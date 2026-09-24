import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digestCanonicalJson } from "../contracts/canonical-json.js";
import { sha256Utf8 } from "../contracts/index.js";
import { jsonDocument } from "../contracts/json-document.js";
import type { RunRecordEventPayloadV2 } from "../contracts/run-record-v2.js";
import {
  ProviderCallError,
  type ReviewProviderRequestV2,
  type ReviewProviderResponseV1,
  type ReviewProviderV2,
} from "../provider/review-provider.js";
import {
  callCostUsd,
  chargedTokens,
  conservativeInputTokenUpperBound,
  priceCeilingCostUsd,
  type ReviewRunConfigV3,
  reservationCostUsd,
} from "./call-accounting.js";
import type { ClaimReviewStageV1, reserveClaimCallsV1 } from "./claim-admission.js";
import { writeClaimArtifactV1 } from "./claim-artifacts.js";
import { failedAttemptChargeV1, normalizedError, retryDelayMs } from "./provider-failure.js";

export interface ClaimCallStateV1 {
  nextAttempt: number;
  spentTokens: number;
  spentUsd: number;
  retriesUsed: number;
  completedStages: ClaimReviewStageV1[];
}
export interface ClaimCallExecutorInputV1 {
  directory: string;
  config: ReviewRunConfigV3;
  provider: ReviewProviderV2;
  admission: ReturnType<typeof reserveClaimCallsV1>;
  durable(event: RunRecordEventPayloadV2): Promise<void>;
  state?: ClaimCallStateV1;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** One retry pool and one budget ledger cover every stage of this review instance. */
export class ClaimCallExecutorV1 {
  readonly state: ClaimCallStateV1;
  constructor(private readonly input: ClaimCallExecutorInputV1) {
    this.state = structuredClone(
      input.state ?? {
        nextAttempt: 1,
        spentTokens: 0,
        spentUsd: 0,
        retriesUsed: 0,
        completedStages: [],
      },
    );
  }

  skip(stage: ClaimReviewStageV1): void {
    if (!this.state.completedStages.includes(stage)) this.state.completedStages.push(stage);
  }

  private async admit(request: ReviewProviderRequestV2): Promise<number> {
    const { config, admission, durable } = this.input;
    const inputTokens = conservativeInputTokenUpperBound(
      request.messages,
      request.responseSchema.schema,
    );
    if (inputTokens + request.maxOutputTokens > admission.stageReservations[request.stage])
      throw new Error("Actual claim request exceeds its stage reservation");
    const remaining = Object.entries(admission.stageReservations).filter(
      ([stage]) => !this.state.completedStages.includes(stage as ClaimReviewStageV1),
    );
    const reserved = remaining.reduce((sum, [, tokens]) => sum + tokens, 0);
    const retry = this.state.retriesUsed === 0 ? admission.retryReservation : 0;
    if (this.state.spentTokens + reserved + retry > config.budgets.maxTotalTokens)
      throw new Error("Remaining token budget cannot reserve claim stages and retry");
    const remainingCost =
      reservationCostUsd(reserved, config, remaining.length) +
      (retry === 0
        ? 0
        : priceCeilingCostUsd(
            retry - config.budgets.maxOutputTokensPerCall,
            config.budgets.maxOutputTokensPerCall,
            config,
          ));
    if (this.state.spentUsd + remainingCost > config.budgets.maxTotalCostUsd) {
      await durable({
        type: "BUDGET_EXHAUSTED",
        budget: "COST",
        stage: request.stage,
        phase: "RESERVATION",
        spentUsd: this.state.spentUsd,
        additionalUsd: remainingCost,
      });
      throw new Error("Remaining cost budget cannot reserve claim stages and retry");
    }
    return inputTokens;
  }

  async complete(request: ReviewProviderRequestV2, promptVersion: string) {
    const { config, durable, directory } = this.input;
    if (this.state.completedStages.includes(request.stage))
      throw new Error("Claim stage already completed");
    let provider = this.input.provider;
    for (;;) {
      const inputTokens = await this.admit(request);
      const attemptNumber = this.state.nextAttempt++;
      const audit = provider.auditRequest(request);
      await writeClaimArtifactV1(
        join(directory, `claim-request-attempt-${attemptNumber}.json`),
        jsonDocument({ request, audit }),
      );
      await durable({
        type: "CALL_STARTED",
        attemptNumber,
        stage: request.stage,
        inputDigest: sha256Utf8(JSON.stringify(request)),
        providerPolicyVersion: audit.providerPolicyVersion,
        preferredProviderEndpoints: audit.preferredProviderEndpoints ?? null,
        excludedProviderEndpoints: audit.excludedProviderEndpoints ?? null,
        wireBodyDigest: audit.wireBodyDigest,
        wireBodyBytes: audit.wireBodyBytes,
        credentialFreeWireRequestDigest: audit.credentialFreeWireRequestDigest,
        requestedModels: request.models,
        promptVersion,
        responseSchemaName: request.responseSchema.name,
        responseArrayLimits: {},
        maxOutputTokens: request.maxOutputTokens,
        timeoutMs: request.timeoutMs,
      });
      const started = Date.now();
      let response: ReviewProviderResponseV1;
      try {
        response = await provider.complete(request);
        if (response.rawResponseBody !== undefined)
          await writeFile(
            join(directory, `provider-response-attempt-${attemptNumber}.raw.json`),
            jsonDocument(response.rawResponseBody),
            { flag: "wx", mode: 0o600 },
          );
        if (response.model !== null && !request.models.includes(response.model))
          throw new ProviderCallError(
            "INVALID_RESPONSE",
            "Review provider returned a model outside the permitted set.",
            {
              responseMetadata: {
                responseId: response.responseId,
                model: response.model,
                provider: response.provider,
                finishReason: null,
                usage: response.usage,
              },
            },
          );
      } catch (error) {
        if (error instanceof ProviderCallError && error.responseBody !== null)
          await writeFile(
            join(directory, `provider-response-attempt-${attemptNumber}.raw.json`),
            jsonDocument(error.responseBody),
            { flag: "wx", mode: 0o600 },
          );
        await durable({
          type: "CALL_FAILED",
          attemptNumber,
          stage: request.stage,
          durationMs: Date.now() - started,
          ...(error instanceof ProviderCallError && error.responseMetadata !== null
            ? { responseMetadata: error.responseMetadata }
            : {}),
          error: normalizedError(error),
        });
        const charge =
          error instanceof ProviderCallError
            ? failedAttemptChargeV1(error, inputTokens, request.maxOutputTokens)
            : {
                tokens: inputTokens + request.maxOutputTokens,
                promptTokens: inputTokens,
                completionTokens: request.maxOutputTokens,
              };
        const cost =
          error instanceof ProviderCallError &&
          error.responseMetadata?.usage.cost !== null &&
          error.responseMetadata?.usage.cost !== undefined
            ? error.responseMetadata.usage.cost
            : error instanceof ProviderCallError && error.code === "TRANSPORT_UNSENT"
              ? 0
              : priceCeilingCostUsd(charge.promptTokens, charge.completionTokens, config);
        this.state.spentTokens += charge.tokens;
        this.state.spentUsd += cost;
        const delay = error instanceof ProviderCallError ? retryDelayMs(error) : null;
        if (
          !(error instanceof ProviderCallError) ||
          delay === null ||
          this.state.retriesUsed > 0 ||
          config.budgets.maxAttemptsPerCall < 2
        )
          throw error;
        const next =
          provider.forRetry?.(error, request) ??
          (provider.forRetry === undefined ? provider : null);
        if (next === null) throw error;
        this.state.retriesUsed++;
        await this.admit(request);
        await durable({
          type: "PROVIDER_RETRY_REQUESTED",
          stage: request.stage,
          failedAttemptNumber: attemptNumber,
          retryAttemptNumber: this.state.nextAttempt,
          retriesUsed: this.state.retriesUsed,
          maxRetries: 1,
          delayMs: delay,
          chargedFailedTokens: charge.tokens,
          chargedFailedCostUsd: cost,
        });
        if (
          Number(error.diagnostic?.providerErrorCode) === 429 ||
          error.diagnostic?.httpStatus === 429
        )
          provider.deferRequests?.(request.models[0] ?? "", delay);
        await (
          this.input.sleep ??
          ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
        )(delay);
        provider = next;
        continue;
      }
      await durable({
        type: "CALL_SUCCEEDED",
        responseDigest: digestCanonicalJson(response),
        attemptNumber,
        stage: request.stage,
        durationMs: Date.now() - started,
        responseId: response.responseId,
        returnedModel: response.model,
        returnedProvider: response.provider,
        usage: response.usage,
      });
      this.state.spentTokens += chargedTokens(response) ?? inputTokens + request.maxOutputTokens;
      this.state.spentUsd += callCostUsd(response, config, inputTokens);
      this.skip(request.stage);
      const responseArtifact = `claim-provider-response-attempt-${attemptNumber}.json`;
      await writeFile(join(directory, responseArtifact), jsonDocument(response), {
        flag: "wx",
        mode: 0o600,
      });
      if (this.state.spentUsd > config.budgets.maxTotalCostUsd) {
        await durable({
          type: "BUDGET_EXHAUSTED",
          budget: "COST",
          stage: request.stage,
          phase: "REPORTED",
          spentUsd: this.state.spentUsd,
          additionalUsd: 0,
        });
        throw new Error("Provider usage exceeded total claim review cost budget");
      }
      if (this.state.spentTokens > config.budgets.maxTotalTokens)
        throw new Error("Provider usage exceeded total claim review token budget");
      return { response, attemptNumber, responseArtifact };
    }
  }
}
