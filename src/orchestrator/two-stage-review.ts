import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as z from "zod";
import { verifyReviewBriefIdentity } from "../contracts/artifact-identity.js";
import {
  type AuthorPacketV1,
  type DigestV1,
  FINAL_REVIEW_CANDIDATE_V3_JSON_SCHEMA,
  FINDING_VERIFICATION_CANDIDATE_V4_JSON_SCHEMA,
  type FinalReviewReportV1,
  type FindingVerificationV4,
  GuidancePromptPresentationSchema,
  jsonDocument,
  PRELIMINARY_ASSESSMENT_V1_JSON_SCHEMA,
  permittedModelsV1,
  type ReviewContextMapV1,
  ReviewReportMetadataV1Schema,
  ReviewRunConfigV3Schema,
  type ReviewUnitPlanV1,
  ReviewUnitPlanV1Schema,
  type RunRecordEventPayloadV1,
  type RunRecordEventV1,
  sha256Utf8,
  verifyReviewUnitPlanIdentityV1,
} from "../contracts/index.js";
import { type ReviewBrief, ReviewBriefSchema } from "../contracts/neutral-review-brief.js";
import {
  type ReviewPreliminary,
  type ReviewReport,
  STANDARDS_CANDIDATE_V3_JSON_SCHEMA,
  STANDARDS_PRELIMINARY_V2_JSON_SCHEMA,
  StandardsReportV3Schema,
} from "../contracts/standards-results.js";
import type { AuthorContextBindingV1, ReviewAuthor } from "../contracts/standards-review.js";
import { DECLINED_AUTHOR_CONTEXT_MARKER_V1, selectedRules } from "../contracts/standards-review.js";
import { parseStrictJsonV1, readStrictJsonFileV1 } from "../contracts/strict-json.js";
import { planReviewUnitsV1 } from "../planning/review-unit-planner.js";
import {
  ProviderCallError,
  type ProviderErrorDiagnosticV1,
  type ReviewMessageV1,
  type ReviewProviderResponseV1,
  type ReviewProviderV1,
} from "../provider/review-provider.js";
import { renderReviewMarkdown } from "../report/markdown.js";
import {
  type InspectedSnapshotPacket,
  inspectSnapshotPacket,
} from "../snapshot/snapshot-packet.js";
import { buildReviewBrief } from "../transmission/neutral-brief-builder.js";
import { compactProjectGuidanceV1 } from "../transmission/project-guidance-digest.js";
import {
  evaluateGuidanceAdmissionV1,
  type GuidanceAdmissionResultV1,
} from "./guidance-admission.js";
import { emitReviewProgress } from "./progress.js";
import {
  type ConstrainedResponseSchemaV1,
  constrainFinalConcernScopeV1,
  constrainFindingVerificationCandidateSchemaV4,
  constrainRepairReferencesV1,
  constrainResponseSchemaV1,
} from "./response-schema.js";
import {
  PreliminaryOutputValidationError,
  parseFinal,
  parseFindingVerification,
  parseFindingVerificationCandidate,
  parsePreliminary,
  ReviewOutputValidationError,
} from "./response-validation.js";
import { describeResumeRefusalsV1, evaluateResumeShapeV1 } from "./resume-eligibility.js";
import {
  FINDING_VERIFICATION_POLICY_V4,
  FINDING_VERIFICATION_POLICY_VERSION_V4,
  finalSchemaNameForBrief,
  isStandardsBrief,
  preliminarySchemaNameForBrief,
  promptVersionForBrief,
  REVIEW_PROMPT_VERSION_V1,
  REVIEW_UNIT_POLICY_VERSION_V1,
  STANDARDS_GUIDANCE_POLICY_VERSION_V1,
  STANDARDS_SYSTEM_POLICY_V1,
  systemPolicyForBrief,
} from "./review-policy.js";
import {
  appendRunRecordEventV1,
  type ReadRunRecordResultV1,
  readRunRecordEventsV1,
  recoverRunRecordTailV1,
} from "./run-record.js";
import { STANDARDS_POLICY_VERSION } from "./standards-policy.js";
import { transmittedEvidencePathsV1, transmittedLineEvidenceV1 } from "./transmitted-evidence.js";

export interface TwoStageReviewResultV1 {
  report: FinalReviewReportV1;
  briefPath: string;
  preliminaryPath: string;
  findingVerificationPath: string;
  finalPath: string;
  markdownPath: string;
  reportMetadataPath: string;
  runRecordPath: string;
}

export interface TwoStageReviewResult extends Omit<TwoStageReviewResultV1, "report"> {
  report: ReviewReport;
}

const MAX_PERSISTED_REVIEW_JSON_BYTES_V1 = 64 * 1024 * 1024;
const MAX_STORED_PROVIDER_RESPONSE_BYTES_V1 = 8 * 1024 * 1024;
const MAX_RUN_RECORD_LINE_BYTES_V1 = 8 * 1024 * 1024;

function focusedReviewContext(plan: ReviewUnitPlanV1, contextMap: ReviewContextMapV1): unknown {
  const regionIds = new Set(
    plan.units.flatMap((unit) => [...unit.primaryRegionIds, ...unit.supportingRegionIds]),
  );
  const relationIds = new Set(plan.units.flatMap((unit) => unit.relationIds));
  const relations = contextMap.relations.filter((relation) => relationIds.has(relation.relationId));
  const producerIds = new Set([
    ...contextMap.regions
      .filter((region) => regionIds.has(region.regionId))
      .map((region) => region.producerId),
    ...relations.map((relation) => relation.producerId),
    ...contextMap.producers
      .filter((producer) => producer.status !== "COMPLETE")
      .map((producer) => producer.producerId),
  ]);
  return {
    producers: contextMap.producers
      .filter((producer) => producerIds.has(producer.producerId))
      .map((producer) => ({
        producerId: producer.producerId,
        producerVersion: producer.producerVersion,
        status: producer.status,
        diagnostics: producer.diagnostics.slice(0, 8).map((diagnostic) => diagnostic.slice(0, 256)),
        diagnosticCount: producer.diagnostics.length,
      })),
    regions: contextMap.regions
      .filter((region) => regionIds.has(region.regionId))
      .map((region) => ({
        regionId: region.regionId,
        origin: region.origin,
        path: region.path,
        side: region.side,
        languageId: region.languageId,
        kind: region.kind,
        producerId: region.producerId,
        ...(region.range ? { range: region.range } : {}),
        ...(region.displayName ? { displayName: region.displayName } : {}),
      })),
    relations: relations.map((relation) => ({
      relationId: relation.relationId,
      sourceRegionId: relation.sourceRegionId,
      targetRegionId: relation.targetRegionId,
      kind: relation.kind,
      certainty: relation.certainty,
      producerId: relation.producerId,
    })),
  };
}

function blindReviewEvidence(
  brief: ReviewBrief,
  plan: ReviewUnitPlanV1,
  contextMap: ReviewContextMapV1,
): unknown {
  const reviewPlanning = {
    reviewUnitPlan: {
      schemaVersion: plan.schemaVersion,
      units: plan.units.map((unit) => ({
        unitId: unit.unitId,
        targetPaths: unit.targetPaths,
        primaryEvidenceIds: unit.primaryEvidenceIds,
        primaryRegionIds: unit.primaryRegionIds,
        supportingRegionIds: unit.supportingRegionIds,
        limitations: unit.limitations,
      })),
    },
    reviewContext: focusedReviewContext(plan, contextMap),
  };
  if (brief.schemaVersion !== 1)
    return {
      ...brief,
      ...reviewPlanning,
      requiredCoverage: {
        changedPaths: brief.snapshotManifest.paths.map((entry) => entry.path),
        canonicalInputIds: brief.snapshotManifest.canonicalInputs.map((input) => input.id),
      },
    };
  const projectGuidanceDigest = compactProjectGuidanceV1(brief.canonicalInputs.projectGuidance);
  const truncatedGuidanceIds = projectGuidanceDigest
    .filter((entry) => entry.truncated)
    .map((entry) => entry.id);
  if (truncatedGuidanceIds.length > 0) {
    throw new Error(
      `Project guidance exceeds the compact transmission budget: ${truncatedGuidanceIds.join(", ")}.`,
    );
  }
  return {
    ...brief,
    ...reviewPlanning,
    requiredCoverage: {
      changedPaths: brief.snapshotManifest.paths.map((entry) => entry.path),
      canonicalInputIds: brief.snapshotManifest.canonicalInputs.map((entry) => entry.id),
    },
    canonicalInputs: {
      requirements: brief.canonicalInputs.requirements,
      implementationPlan: brief.canonicalInputs.implementationPlan,
    },
    projectGuidanceDigest,
  };
}

async function appendRunEvent(
  runRecordPath: string,
  event: RunRecordEventPayloadV1,
): Promise<void> {
  const durableEvent = await appendRunRecordEventV1(runRecordPath, event);
  emitReviewProgress(durableEvent);
}

function normalizedError(error: unknown): {
  name: string;
  code: string | null;
  message: string;
  diagnostic?: ProviderErrorDiagnosticV1;
} {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", code: null, message: "A non-Error value was thrown." };
  }
  const possibleCode = (error as Error & { code?: unknown }).code;
  const normalized: {
    name: string;
    code: string | null;
    message: string;
    diagnostic?: ProviderErrorDiagnosticV1;
  } = {
    name: error.name,
    code: typeof possibleCode === "string" ? possibleCode : null,
    message: error.message,
  };
  if (error instanceof ProviderCallError && error.diagnostic !== null) {
    normalized.diagnostic = error.diagnostic;
  }
  return normalized;
}

/** OpenRouter unit prices are expressed in dollars per million tokens. */
const TOKENS_PER_UNIT_PRICE_V1 = 1_000_000;

type ReviewRunConfigV3 = z.infer<typeof ReviewRunConfigV3Schema>;

/** Upper bound in dollars for a known token split at the configured unit-price ceiling. */
function priceCeilingCostUsd(
  promptTokens: number,
  completionTokens: number,
  config: ReviewRunConfigV3,
): number {
  const { prompt, completion, request } = config.providerRouting.maxPrice;
  return (
    (promptTokens / TOKENS_PER_UNIT_PRICE_V1) * prompt +
    (completionTokens / TOKENS_PER_UNIT_PRICE_V1) * completion +
    request
  );
}

/** Price known prompt/output reservations separately, including each request fee. */
function reservationCostUsd(reservedTokens: number, config: ReviewRunConfigV3, calls = 1): number {
  const completionTokens = calls * config.budgets.maxOutputTokensPerCall;
  return (
    priceCeilingCostUsd(reservedTokens - completionTokens, completionTokens, config) +
    (calls - 1) * config.providerRouting.maxPrice.request
  );
}

/**
 * What a completed call cost. Unknown cost is never treated as zero: it falls back to the
 * unit-price ceiling over reported tokens, and to the reservation where tokens are missing too.
 */
function callCostUsd(
  response: ReviewProviderResponseV1,
  config: ReviewRunConfigV3,
  reservedInputTokens: number,
): number {
  if (response.usage.cost !== null) {
    return response.usage.cost;
  }
  return priceCeilingCostUsd(
    response.usage.promptTokens ?? reservedInputTokens,
    response.usage.completionTokens ?? config.budgets.maxOutputTokensPerCall,
    config,
  );
}

/**
 * Tracks run spend against budgets.maxTotalCostUsd. maxPrice bounds unit rates on the provider
 * side and maxTotalTokens bounds tokens, but neither bounds the bill for one run: the same token
 * budget is a different amount of money on a different model.
 */
class RunCostLedgerV1 {
  #spentUsd = 0;

  constructor(private readonly ceilingUsd: number) {}

  get spentUsd(): number {
    return this.#spentUsd;
  }

  record(costUsd: number): void {
    this.#spentUsd += costUsd;
  }

  exceededBy(additionalUsd: number): number {
    return this.#spentUsd + additionalUsd - this.ceilingUsd;
  }
}

/** Aborts before or after a call when the run cost ceiling is crossed, and records why. */
async function assertCostBudget(
  runRecordPath: string,
  ledger: RunCostLedgerV1,
  additionalUsd: number,
  stage: "PRELIMINARY" | "FINDING_VERIFICATION" | "FINAL",
  phase: "RESERVATION" | "REPORTED",
): Promise<void> {
  if (ledger.exceededBy(additionalUsd) <= 0) {
    return;
  }
  await appendRunEvent(runRecordPath, {
    type: "BUDGET_EXHAUSTED",
    budget: "COST",
    stage,
    phase,
    spentUsd: ledger.spentUsd,
    additionalUsd,
  });
  throw new Error(
    phase === "RESERVATION"
      ? `The remaining cost budget cannot reserve the ${stage.toLowerCase()} call.`
      : `Provider-reported usage exceeded the total cost budget at the ${stage.toLowerCase()} stage.`,
  );
}

interface ProviderRetryStateV1 {
  nextAttempt: number;
  lastAttempt: number;
  failedTokens: number;
}
/**
 * Retry budget for one logical call. Each call site builds its own, so a preliminary retry cannot
 * starve the final stage; the run-wide token and cost ledgers still bound the total spend.
 */
interface ProviderRetryContextV1 {
  state: ProviderRetryStateV1;
  /** Retries permitted for this call, derived from budgets.maxAttemptsPerCall. */
  maxRetries: number;
  /** Retries already spent on this call. Mutated across the retry recursion. */
  retriesUsed: number;
  config: ReviewRunConfigV3;
  costLedger: RunCostLedgerV1;
  /** Total successful-call reservation so far, including mandatory calls still ahead. */
  requiredTokens: number;
  remainingTokens: number;
}

/**
 * Builds the retry budget for one logical call.
 *
 * Every call site differs only in its token reservations; the rest is policy that belongs in one
 * place. It was written out five times, so "how many retries does a call get" was five statements
 * that happened to agree (#89).
 */
function providerRetryContextV1(
  state: ProviderRetryStateV1,
  config: ReviewRunConfigV3,
  costLedger: RunCostLedgerV1,
  reservations: { requiredTokens: number; remainingTokens: number },
): ProviderRetryContextV1 {
  return {
    state,
    maxRetries: config.budgets.maxAttemptsPerCall - 1,
    retriesUsed: 0,
    config,
    costLedger,
    ...reservations,
  };
}

/**
 * What a failed attempt costs the run.
 *
 * Charging every failure the full conservative reservation was the reason retries were refused
 * with "the remaining token budget cannot reserve a provider retry": a 429 that never reached a
 * model was billed as if it had produced a whole review. A provider error envelope carrying no
 * usage means no generation happened and costs nothing. Anything else may have generated output,
 * so it keeps the conservative reservation.
 */
function failedAttemptChargeV1(
  error: ProviderCallError,
  inputTokens: number,
  maxOutputTokens: number,
): { tokens: number; promptTokens: number; completionTokens: number } {
  const usage = error.responseMetadata?.usage;
  const reported = usage ? chargedTokens({ usage }) : null;
  if (reported !== null) {
    return {
      tokens: reported,
      promptTokens: usage?.promptTokens ?? inputTokens,
      completionTokens: usage?.completionTokens ?? 0,
    };
  }
  // A provider error envelope carrying no usage means no generation happened; so does a failure
  // that never reached the provider at all (#134). Both cost nothing.
  if (error.code === "PROVIDER_ERROR" || error.code === "TRANSPORT_UNSENT") {
    return { tokens: 0, promptTokens: 0, completionTokens: 0 };
  }
  return {
    tokens: inputTokens + maxOutputTokens,
    promptTokens: inputTokens,
    completionTokens: maxOutputTokens,
  };
}

/**
 * Base delay before another attempt, or null when the failure is not transient.
 *
 * A rejected request changes nothing on retry: 400/401/402/413/422 need a different request or a
 * different account, so they fail the run immediately instead of burning attempts and money.
 */
function retryDelayMs(error: ProviderCallError): number | null {
  const code = Number(error.diagnostic?.providerErrorCode);
  const status = error.diagnostic?.httpStatus;
  const transient = [408, 409, 429, 500, 502, 503, 504, 524, 529];
  // An inference call is idempotent for this product: a request that may or may not have been
  // submitted can be reissued, and the ledger charges the uncertain attempt either way. A request
  // that was never submitted is unambiguously safe to reissue and costs nothing (#134).
  if (error.code === "TRANSPORT_UNSENT" || error.code === "TRANSPORT_UNCERTAIN")
    return 1_000 + Math.floor(Math.random() * 1_000);
  if (
    !error.retryable &&
    (error.code !== "PROVIDER_ERROR" ||
      !(transient.includes(code) || (status !== undefined && transient.includes(status))))
  )
    return null;
  const fallbackDelay = () =>
    code === 429 || status === 429 || code === 529 || status === 529
      ? 5_000 + Math.floor(Math.random() * 5_000)
      : 1_000 + Math.floor(Math.random() * 1_000);
  const hint = error.diagnostic?.retryAfter;
  if (!hint) return fallbackDelay();
  const seconds = Number(hint);
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(hint) - Date.now();
  // Longer hints remain actionable failures; never retry earlier than the server requested.
  if (!Number.isFinite(delay)) return fallbackDelay();
  return delay <= 30_000 ? Math.max(0, delay) : null;
}

/** Runner-owned provenance for one call, recorded alongside it rather than derived from it. */
interface CallAuditV1 {
  /**
   * The policy version this call's system prompt came from.
   *
   * Passed in, never inferred. This used to be reconstructed inside `CALL_STARTED` by comparing
   * `request.messages[0]?.content` against three multi-kilobyte prompt constants, with an
   * unmatched prompt silently recorded as the requirements policy (#126). It was correct only
   * because every repair path happens to preserve the first message.
   */
  promptVersion: string;
  /** Array ceilings applied to the response schema, so a bounded review is auditable. */
  responseArrayLimits?: Record<string, number>;
}

async function completeWithAudit(
  runRecordPath: string,
  attemptNumber: number,
  provider: ReviewProviderV1,
  request: Parameters<ReviewProviderV1["complete"]>[0],
  audit: CallAuditV1,
  retry?: ProviderRetryContextV1,
): Promise<ReviewProviderResponseV1> {
  if (retry) {
    attemptNumber = retry.state.nextAttempt++;
    retry.state.lastAttempt = attemptNumber;
  }
  const startedAt = Date.now();
  const requestAudit = provider.auditRequest(request);
  await appendRunEvent(runRecordPath, {
    type: "CALL_STARTED",
    attemptNumber,
    stage: request.stage,
    inputDigest: sha256Utf8(JSON.stringify(request)),
    providerPolicyVersion: requestAudit.providerPolicyVersion,
    preferredProviderEndpoints: requestAudit.preferredProviderEndpoints ?? null,
    excludedProviderEndpoints: requestAudit.excludedProviderEndpoints ?? null,
    wireBodyDigest: requestAudit.wireBodyDigest,
    wireBodyBytes: requestAudit.wireBodyBytes,
    credentialFreeWireRequestDigest: requestAudit.credentialFreeWireRequestDigest,
    requestedModels: request.models,
    promptVersion: audit.promptVersion,
    responseSchemaName: request.responseSchema.name,
    responseArrayLimits: audit.responseArrayLimits ?? {},
    maxOutputTokens: request.maxOutputTokens,
    timeoutMs: request.timeoutMs,
  });
  try {
    const response = await provider.complete(request);
    if (response.rawResponseBody !== undefined) {
      await writeFile(
        join(dirname(runRecordPath), `provider-response-attempt-${attemptNumber}.raw.json`),
        jsonDocument(response.rawResponseBody),
        { flag: "wx", mode: 0o600 },
      );
    }
    // Enforcement point for the model-match rule. The OpenRouter adapter checks the same thing
    // against its own wire response; this check covers any ReviewProviderV1 implementation, so
    // the two messages name their layer to say which one fired.
    if (response.model !== null && !request.models.includes(response.model)) {
      throw new ProviderCallError(
        "INVALID_RESPONSE",
        `The review provider returned a model outside the permitted set (${response.model}).`,
      );
    }
    await appendRunEvent(runRecordPath, {
      type: "CALL_SUCCEEDED",
      attemptNumber,
      stage: request.stage,
      durationMs: Date.now() - startedAt,
      responseId: response.responseId,
      returnedModel: response.model,
      returnedProvider: response.provider,
      usage: response.usage,
    });
    return response;
  } catch (error) {
    if (error instanceof ProviderCallError && error.responseBody !== null) {
      await writeFile(
        join(dirname(runRecordPath), `provider-response-attempt-${attemptNumber}.raw.json`),
        jsonDocument(error.responseBody),
        { flag: "wx", mode: 0o600 },
      );
    }
    await appendRunEvent(runRecordPath, {
      type: "CALL_FAILED",
      attemptNumber,
      stage: request.stage,
      durationMs: Date.now() - startedAt,
      ...(error instanceof ProviderCallError && error.responseMetadata !== null
        ? { responseMetadata: error.responseMetadata }
        : {}),
      error: normalizedError(error),
    });
    const delayMs = error instanceof ProviderCallError ? retryDelayMs(error) : null;
    if (
      error instanceof ProviderCallError &&
      (Number(error.diagnostic?.providerErrorCode) === 429 || error.diagnostic?.httpStatus === 429)
    ) {
      // Share throttling even when this run has already spent its one retry.
      const hint = error.diagnostic?.retryAfter;
      const seconds = hint ? Number(hint) : NaN;
      const hintedDelay = hint
        ? Number.isFinite(seconds)
          ? seconds * 1_000
          : Date.parse(hint) - Date.now()
        : NaN;
      const cooldownMs =
        delayMs ??
        (Number.isFinite(hintedDelay)
          ? Math.max(0, hintedDelay)
          : 5_000 + Math.floor(Math.random() * 5_000));
      provider.deferRequests?.(request.models[0] as string, cooldownMs);
    }
    if (retry && retry.retriesUsed < retry.maxRetries && error instanceof ProviderCallError) {
      if (delayMs !== null) {
        const retryProvider =
          provider.forRetry?.(error, request) ??
          (provider.forRetry === undefined ? provider : null);
        if (retryProvider === null) throw error;
        const inputTokens = conservativeInputTokenUpperBound(
          request.messages,
          request.responseSchema.schema,
        );
        const charge = failedAttemptChargeV1(error, inputTokens, request.maxOutputTokens);
        const usage = error.responseMetadata?.usage;
        const failedTokens = charge.tokens;
        const failedCostUsd =
          usage?.cost ??
          priceCeilingCostUsd(charge.promptTokens, charge.completionTokens, retry.config);
        retry.state.failedTokens += failedTokens;
        retry.costLedger.record(failedCostUsd);
        if (retry.requiredTokens + retry.state.failedTokens > retry.config.budgets.maxTotalTokens) {
          throw new Error("The remaining token budget cannot reserve a provider retry.", {
            cause: error,
          });
        }
        await assertCostBudget(
          runRecordPath,
          retry.costLedger,
          reservationCostUsd(
            retry.remainingTokens,
            retry.config,
            request.stage === "PRELIMINARY" ? 3 : request.stage === "FINDING_VERIFICATION" ? 2 : 1,
          ),
          request.stage,
          "RESERVATION",
        );
        // Exponential backoff with the jitter already baked into delayMs, so concurrent workers
        // recovering from the same provider incident do not resynchronize onto it.
        const backoffMs = Math.min(delayMs * 2 ** retry.retriesUsed, 30_000);
        retry.retriesUsed += 1;
        await appendRunEvent(runRecordPath, {
          type: "PROVIDER_RETRY_REQUESTED",
          stage: request.stage,
          failedAttemptNumber: attemptNumber,
          retryAttemptNumber: retry.state.nextAttempt,
          retriesUsed: retry.retriesUsed,
          maxRetries: retry.maxRetries,
          delayMs: backoffMs,
          chargedFailedTokens: failedTokens,
          chargedFailedCostUsd: failedCostUsd,
        });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        return completeWithAudit(
          runRecordPath,
          attemptNumber,
          retryProvider,
          request,
          audit,
          retry,
        );
      }
    }
    throw error;
  }
}

function assertConversationBudget(messages: ReviewMessageV1[], maximum: number): void {
  const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
  if (bytes > maximum) {
    throw new Error(`Conversation requires ${bytes} bytes, exceeding the ${maximum}-byte budget.`);
  }
}

/**
 * An upper bound on the tokens one call's input can consume, measured in UTF-8 bytes.
 *
 * Bytes bound tokens from above: no tokenizer emits a token shorter than one byte, so the encoded
 * size of the payload is a ceiling on its token count no matter which model runs. The per-message
 * addend covers chat-template and role framing the payload itself does not carry. That makes this
 * safe to reserve against and safe to price at the unit-price ceiling, in the conservative
 * direction in both cases.
 *
 * It is not an estimate of the real token count, and it is not close to one. English prose and
 * JSON run roughly 3-4 bytes per token, so this typically overshoots by a factor of about four.
 * Anything shown to a user must therefore describe it as a reservation, never as a token count
 * they could check against a model's context window (#135).
 */
function conservativeInputTokenUpperBound(
  messages: ReviewMessageV1[],
  responseSchema: unknown,
): number {
  const bytes = Buffer.byteLength(JSON.stringify({ messages, responseSchema }), "utf8");
  return bytes + messages.length * 256;
}

function findingVerificationReservationCountV1(): number {
  return 40;
}

function findingVerificationConcernReservationCountV1(): number {
  return 80;
}

function requiredReviewTokenReservations(
  blindMessages: ReviewMessageV1[],
  blindEvidence: unknown,
  authorMessage: string,
  maxOutputTokensPerCall: number,
  preliminaryResponseSchema: unknown,
  findingVerificationResponseSchema: unknown,
  finalResponseSchema: unknown,
): {
  preliminaryCallReservation: number;
  findingVerificationCallReservation: number;
  finalCallReservation: number;
  requiredTokens: number;
} {
  const preliminaryCallReservation =
    conservativeInputTokenUpperBound(blindMessages, preliminaryResponseSchema) +
    maxOutputTokensPerCall;
  const findingVerificationCallReservation =
    conservativeInputTokenUpperBound(
      findingVerificationMessagesV4(blindEvidence, null),
      findingVerificationResponseSchema,
    ) +
    maxOutputTokensPerCall +
    maxOutputTokensPerCall;
  const finalCallReservation =
    finalInputTokenReservation(
      blindMessages,
      authorMessage,
      maxOutputTokensPerCall,
      maxOutputTokensPerCall,
      finalResponseSchema,
    ) + maxOutputTokensPerCall;
  return {
    preliminaryCallReservation,
    findingVerificationCallReservation,
    finalCallReservation,
    requiredTokens:
      preliminaryCallReservation + findingVerificationCallReservation + finalCallReservation,
  };
}

function findingVerificationEnvelope(verification: FindingVerificationV4 | null): string {
  return JSON.stringify({
    schemaVersion: 4,
    type: "FINDING_VERIFICATION",
    verification,
    finalProtocol: {
      limitations: "RETURN_EMPTY_RUNNER_OWNED",
      concernDispositions: {
        BLOCKING_UNCERTAINTY_DEMONSTRATED: "REMAINS",
        NO_BLOCKING_UNCERTAINTY: "RESOLVED",
        INCONCLUSIVE: "REMAINS",
      },
    },
  });
}

function finalInputTokenReservation(
  blindMessages: ReviewMessageV1[],
  authorMessage: string,
  preliminaryOutputReservation: number,
  findingVerificationOutputReservation: number,
  finalResponseSchema: unknown,
): number {
  const messagesWithoutGeneratedContent: ReviewMessageV1[] = [
    ...blindMessages,
    { role: "assistant", content: "" },
    { role: "user", content: findingVerificationEnvelope(null) },
    { role: "user", content: authorMessage },
  ];
  return (
    conservativeInputTokenUpperBound(messagesWithoutGeneratedContent, finalResponseSchema) +
    preliminaryOutputReservation +
    findingVerificationOutputReservation
  );
}

function serializedMessageBytes(messages: ReviewMessageV1[]): number {
  return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

function evidenceWithoutGuidanceV1(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Blind review evidence must be an object.");
  }
  const {
    guidanceGraph: _guidanceGraph,
    guidancePresentation: _guidancePresentation,
    ...withoutGuidance
  } = value as Record<string, unknown>;
  return withoutGuidance;
}

function guidanceAdmissionForCallsV1(
  brief: ReviewBrief,
  blindEvidence: unknown,
  blindMessages: ReviewMessageV1[],
  authorMessage: string,
  capacityBytes: number,
): GuidanceAdmissionResultV1 | null {
  if (brief.schemaVersion !== 3) return null;
  const presentation = GuidancePromptPresentationSchema.parse(
    parseStrictJsonV1(brief.guidancePresentation, {
      maxBytes: MAX_PERSISTED_REVIEW_JSON_BYTES_V1,
      source: "guidance presentation",
    }),
  );
  const contentBytes = presentation.sources.reduce(
    (total, source) => total + Buffer.byteLength(source.content, "utf8"),
    0,
  );
  const baselineEvidence = evidenceWithoutGuidanceV1(blindEvidence);
  const baselineBlindMessages: ReviewMessageV1[] = [
    { role: "system", content: STANDARDS_SYSTEM_POLICY_V1 },
    { role: "user", content: JSON.stringify(baselineEvidence) },
  ];
  const finalMessages = (messages: ReviewMessageV1[]): ReviewMessageV1[] => [
    ...messages,
    { role: "assistant", content: "" },
    { role: "user", content: findingVerificationEnvelope(null) },
    { role: "user", content: authorMessage },
  ];
  const wireBytesByStage = {
    preliminary:
      serializedMessageBytes(blindMessages) - serializedMessageBytes(baselineBlindMessages),
    findingVerification:
      serializedMessageBytes(findingVerificationMessagesV4(blindEvidence, null)) -
      serializedMessageBytes(findingVerificationMessagesV4(baselineEvidence, null)),
    final:
      serializedMessageBytes(finalMessages(blindMessages)) -
      serializedMessageBytes(finalMessages(baselineBlindMessages)),
  };
  const admission = evaluateGuidanceAdmissionV1({
    contentBytes,
    wireBytesByStage,
    capacityBytes,
  });
  if (admission.status === "STOP") {
    throw new Error(
      `Repository guidance admission stopped before provider access: ${admission.stopReasons.join(", ")}. Content ${contentBytes} bytes; wire deltas ${JSON.stringify(wireBytesByStage)}; conversation capacity ${capacityBytes} bytes.`,
    );
  }
  return admission;
}

function chargedTokens(response: Pick<ReviewProviderResponseV1, "usage">): number | null {
  const { promptTokens, completionTokens, totalTokens } = response.usage;
  if (promptTokens === null || completionTokens === null || totalTokens === null) {
    return null;
  }
  if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) {
    return null;
  }
  if (
    !Number.isSafeInteger(promptTokens) ||
    promptTokens < 0 ||
    !Number.isSafeInteger(completionTokens) ||
    completionTokens < 0
  ) {
    return null;
  }
  if (promptTokens + completionTokens !== totalTokens) {
    return null;
  }
  return totalTokens;
}

function providerRecord(response: ReviewProviderResponseV1): unknown {
  return {
    responseId: response.responseId,
    model: response.model,
    provider: response.provider,
    rawContent: response.rawContent,
    usage: response.usage,
  };
}

const StoredProviderResponseV1Schema = z.strictObject({
  responseId: z.string().nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  rawContent: z.string(),
  usage: z.strictObject({
    promptTokens: z.int().nonnegative().nullable(),
    completionTokens: z.int().nonnegative().nullable(),
    totalTokens: z.int().nonnegative().nullable(),
    cost: z.number().nonnegative().nullable(),
  }),
});

function preliminaryRepairMessagesV1(
  blindMessages: ReviewMessageV1[],
  rejectedRawContent: string,
  validationError: string,
  acceptedLineEvidence: ReturnType<typeof transmittedLineEvidenceV1>,
): ReviewMessageV1[] {
  return [
    ...blindMessages,
    { role: "assistant", content: rejectedRawContent },
    {
      role: "user",
      content: JSON.stringify({
        schemaVersion: 1,
        type: "PRELIMINARY_OUTPUT_REPAIR",
        instruction:
          "Return one complete corrected blind preliminary assessment under the same schema. Change only what is needed to resolve every listed validation error; preserve supported review judgments and do not infer or request author context. Copy inspected paths exactly from the schema. LINE_RANGE evidence may use only a path, side, and range wholly contained within one range in acceptedLineEvidence. Omit a finding when no listed range supports it; never move a citation to nearby lines.",
        validationError,
        acceptedLineEvidence,
      }),
    },
  ];
}

async function validatePreliminaryStageV1(
  packetPath: string,
  reviewDirectory: string,
  runRecordPath: string,
  config: ReviewRunConfigV3,
  provider: ReviewProviderV1,
  brief: ReviewBrief,
  blindMessages: ReviewMessageV1[],
  preliminaryConstrained: ConstrainedResponseSchemaV1,
  initialResponse: ReviewProviderResponseV1,
  remainingCallReservation: number,
  costLedger: RunCostLedgerV1,
  retryState: ProviderRetryStateV1,
): Promise<{
  preliminary: ReviewPreliminary;
  acceptedResponse: ReviewProviderResponseV1;
  chargedTokens: number;
  acceptedAttemptNumber: number;
  responseArtifact: string;
}> {
  const responseSchema = preliminaryConstrained.schema;
  const preliminaryInputTokens = conservativeInputTokenUpperBound(blindMessages, responseSchema);
  const initialCallTokens =
    chargedTokens(initialResponse) ??
    preliminaryInputTokens + config.budgets.maxOutputTokensPerCall;
  if (
    initialCallTokens + retryState.failedTokens + remainingCallReservation >
    config.budgets.maxTotalTokens
  ) {
    throw new Error("Provider-reported usage exceeded the total token budget.");
  }
  const initialCostUsd = callCostUsd(initialResponse, config, preliminaryInputTokens);
  await assertCostBudget(runRecordPath, costLedger, initialCostUsd, "PRELIMINARY", "REPORTED");
  costLedger.record(initialCostUsd);

  try {
    return {
      preliminary: await parsePreliminary(initialResponse.value, brief, packetPath),
      acceptedResponse: initialResponse,
      chargedTokens: initialCallTokens,
      acceptedAttemptNumber: retryState.lastAttempt,
      responseArtifact: "preliminary-provider-response.json",
    };
  } catch (error) {
    if (!(error instanceof PreliminaryOutputValidationError)) {
      throw error;
    }
    const rejectedAttemptNumber = retryState.lastAttempt;
    const validationError = error.message.slice(0, 4_000);
    await appendRunEvent(runRecordPath, {
      type: "PRELIMINARY_CANDIDATE_REJECTED",
      attemptNumber: rejectedAttemptNumber,
      validationError,
    });
    const repairMessages = preliminaryRepairMessagesV1(
      blindMessages,
      initialResponse.rawContent,
      validationError,
      transmittedLineEvidenceV1(brief),
    );
    assertConversationBudget(repairMessages, config.budgets.maxConversationBytes);
    const repairInputTokens = conservativeInputTokenUpperBound(repairMessages, responseSchema);
    const repairCallReservation = repairInputTokens + config.budgets.maxOutputTokensPerCall;
    if (
      initialCallTokens +
        retryState.failedTokens +
        repairCallReservation +
        remainingCallReservation >
      config.budgets.maxTotalTokens
    ) {
      throw new PreliminaryOutputValidationError(
        `${error.message}\nThe remaining token budget cannot reserve one preliminary-output repair, possible finding verification, and the mandatory final call.`,
        { cause: error },
      );
    }
    await assertCostBudget(
      runRecordPath,
      costLedger,
      reservationCostUsd(repairCallReservation + remainingCallReservation, config, 3),
      "PRELIMINARY",
      "RESERVATION",
    );
    await appendRunEvent(runRecordPath, {
      type: "PRELIMINARY_REPAIR_REQUESTED",
      rejectedAttemptNumber,
      repairAttemptNumber: retryState.nextAttempt,
    });
    const repairResponse = await completeWithAudit(
      runRecordPath,
      retryState.nextAttempt,
      provider,
      {
        stage: "PRELIMINARY",
        models: [initialResponse.model ?? config.model],
        maxOutputTokens: config.budgets.maxOutputTokensPerCall,
        timeoutMs: config.budgets.timeoutMs,
        messages: repairMessages,
        responseSchema: {
          name: isStandardsBrief(brief) ? "standards_preliminary_v2" : "preliminary_assessment_v1",
          schema: responseSchema,
        },
      },
      {
        promptVersion: promptVersionForBrief(brief),
        responseArrayLimits: preliminaryConstrained.appliedArrayLimits,
      },
      providerRetryContextV1(retryState, config, costLedger, {
        requiredTokens: initialCallTokens + repairCallReservation + remainingCallReservation,
        remainingTokens: repairCallReservation + remainingCallReservation,
      }),
    );
    const acceptedAttemptNumber = retryState.lastAttempt;
    const responseArtifact = "preliminary-repair-provider-response.json";
    await writeFile(
      join(reviewDirectory, responseArtifact),
      jsonDocument(providerRecord(repairResponse)),
      { flag: "wx", mode: 0o600 },
    );
    const repairCallTokens =
      chargedTokens(repairResponse) ?? repairInputTokens + config.budgets.maxOutputTokensPerCall;
    if (
      initialCallTokens + repairCallTokens + retryState.failedTokens + remainingCallReservation >
      config.budgets.maxTotalTokens
    ) {
      throw new Error("Provider-reported usage exceeded the total token budget.");
    }
    const repairCostUsd = callCostUsd(repairResponse, config, repairInputTokens);
    await assertCostBudget(runRecordPath, costLedger, repairCostUsd, "PRELIMINARY", "REPORTED");
    costLedger.record(repairCostUsd);
    try {
      return {
        preliminary: await parsePreliminary(repairResponse.value, brief, packetPath),
        acceptedResponse: repairResponse,
        chargedTokens: initialCallTokens + repairCallTokens,
        acceptedAttemptNumber,
        responseArtifact,
      };
    } catch (repairError) {
      if (repairError instanceof PreliminaryOutputValidationError) {
        await appendRunEvent(runRecordPath, {
          type: "PRELIMINARY_CANDIDATE_REJECTED",
          attemptNumber: acceptedAttemptNumber,
          validationError: repairError.message.slice(0, 4_000),
        });
      }
      throw repairError;
    }
  }
}

function findingVerificationMessagesV4(
  blindEvidence: unknown,
  preliminary: ReviewPreliminary | null,
): ReviewMessageV1[] {
  return [
    { role: "system", content: FINDING_VERIFICATION_POLICY_V4 },
    {
      role: "user",
      content: JSON.stringify({
        schemaVersion: 4,
        type: "FINDING_VERIFICATION_REQUEST",
        blindReviewEvidence: blindEvidence,
        preliminaryFindings:
          preliminary?.findings.map(({ id: _runnerOwnedId, ...finding }) => finding) ?? null,
        preliminaryConcerns: preliminary
          ? [
              ...preliminary.evidenceGaps.map((text) => ({ kind: "EVIDENCE_GAP", text })),
              ...preliminary.limitations.map((text) => ({ kind: "LIMITATION", text })),
            ]
          : null,
      }),
    },
  ];
}

function emptyFindingVerificationV4(
  preliminary: ReviewPreliminary,
  brief: ReviewBrief,
): FindingVerificationV4 {
  if (
    preliminary.findings.length !== 0 ||
    preliminary.evidenceGaps.length !== 0 ||
    preliminary.limitations.length !== 0
  ) {
    throw new Error("Cannot skip finding verification while preliminary adverse claims exist.");
  }
  return {
    schemaVersion: 4,
    stage: "FINDING_VERIFICATION",
    snapshotDigest: brief.snapshotManifest.snapshotDigest,
    briefDigest: brief.briefDigest,
    assessments: [],
    concernAssessments: [],
  };
}

async function completeFindingVerificationStageV4(
  reviewDirectory: string,
  runRecordPath: string,
  config: ReviewRunConfigV3,
  provider: ReviewProviderV1,
  brief: ReviewBrief,
  blindEvidence: unknown,
  preliminary: ReviewPreliminary,
  firstCallTokens: number,
  callReservation: number,
  finalCallReservation: number,
  costLedger: RunCostLedgerV1,
  retryState: ProviderRetryStateV1,
): Promise<{ verification: FindingVerificationV4; chargedTokens: number }> {
  const verificationPath = join(reviewDirectory, "finding-verification.json");
  const concernCount = preliminary.evidenceGaps.length + preliminary.limitations.length;
  if (preliminary.findings.length === 0 && concernCount === 0) {
    const verification = emptyFindingVerificationV4(preliminary, brief);
    await writeFile(verificationPath, jsonDocument(verification), { flag: "wx", mode: 0o600 });
    await appendRunEvent(runRecordPath, {
      type: "FINDING_VERIFICATION_PERSISTED",
      verificationDigest: sha256Utf8(jsonDocument(verification)),
      providerCall: false,
      responseArtifact: null,
    });
    return { verification, chargedTokens: 0 };
  }

  const messages = findingVerificationMessagesV4(blindEvidence, preliminary);
  assertConversationBudget(messages, config.budgets.maxConversationBytes);
  const constrained = constrainFindingVerificationCandidateSchemaV4(
    FINDING_VERIFICATION_CANDIDATE_V4_JSON_SCHEMA,
    preliminary.findings.length,
    concernCount,
    {
      snapshotDigest: brief.snapshotManifest.snapshotDigest.value,
      briefDigest: brief.briefDigest.value,
    },
  );
  const reservedInputTokens = callReservation - config.budgets.maxOutputTokensPerCall;
  if (
    firstCallTokens + retryState.failedTokens + callReservation + finalCallReservation >
    config.budgets.maxTotalTokens
  ) {
    throw new Error(
      "The remaining token budget cannot reserve finding verification and final review calls.",
    );
  }
  await assertCostBudget(
    runRecordPath,
    costLedger,
    reservationCostUsd(callReservation + finalCallReservation, config, 2),
    "FINDING_VERIFICATION",
    "RESERVATION",
  );
  const response = await completeWithAudit(
    runRecordPath,
    retryState.nextAttempt,
    provider,
    {
      stage: "FINDING_VERIFICATION",
      models: permittedModelsV1(config),
      maxOutputTokens: config.budgets.maxOutputTokensPerCall,
      timeoutMs: config.budgets.timeoutMs,
      messages,
      responseSchema: {
        name: "finding_verification_candidate_v4",
        schema: constrained.schema,
      },
    },
    {
      promptVersion: FINDING_VERIFICATION_POLICY_VERSION_V4,
      responseArrayLimits: constrained.appliedArrayLimits,
    },
    providerRetryContextV1(retryState, config, costLedger, {
      requiredTokens: firstCallTokens + callReservation + finalCallReservation,
      remainingTokens: callReservation + finalCallReservation,
    }),
  );
  const responseArtifact = "finding-verification-provider-response.json";
  await writeFile(join(reviewDirectory, responseArtifact), jsonDocument(providerRecord(response)), {
    flag: "wx",
    mode: 0o600,
  });
  const charged = chargedTokens(response) ?? callReservation;
  if (
    firstCallTokens + charged + retryState.failedTokens + finalCallReservation >
    config.budgets.maxTotalTokens
  ) {
    throw new Error("Provider-reported usage exceeded the total token budget.");
  }
  const callCost = callCostUsd(response, config, reservedInputTokens);
  await assertCostBudget(runRecordPath, costLedger, callCost, "FINDING_VERIFICATION", "REPORTED");
  costLedger.record(callCost);
  const verification = parseFindingVerificationCandidate(response.value, preliminary, brief);
  await writeFile(verificationPath, jsonDocument(verification), { flag: "wx", mode: 0o600 });
  await appendRunEvent(runRecordPath, {
    type: "FINDING_VERIFICATION_PERSISTED",
    verificationDigest: sha256Utf8(jsonDocument(verification)),
    providerCall: true,
    acceptedAttemptNumber: retryState.lastAttempt,
    responseArtifact,
  });
  return { verification, chargedTokens: charged };
}

async function completeFinalStageV1(
  packetPath: string,
  reviewDirectory: string,
  runRecordPath: string,
  attemptNumber: number,
  config: z.infer<typeof ReviewRunConfigV3Schema>,
  provider: ReviewProviderV1,
  brief: ReviewBrief,
  preliminary: ReviewPreliminary,
  findingVerification: FindingVerificationV4,
  finalMessages: ReviewMessageV1[],
  finalConstrained: ConstrainedResponseSchemaV1,
  finalCallReservation: number,
  firstCallTokens: number,
  authorVerificationClaims: AuthorPacketV1["claimedVerification"],
  costLedger: RunCostLedgerV1,
  retryState?: ProviderRetryStateV1,
): Promise<ReviewReport> {
  finalConstrained = constrainFinalConcernScopeV1(finalConstrained, preliminary);
  const finalResponseSchema = finalConstrained.schema;
  assertConversationBudget(finalMessages, config.budgets.maxConversationBytes);
  const finalInputTokens = finalCallReservation - config.budgets.maxOutputTokensPerCall;
  if (
    firstCallTokens + (retryState?.failedTokens ?? 0) + finalCallReservation >
    config.budgets.maxTotalTokens
  ) {
    throw new Error("The remaining token budget cannot reserve the final review call.");
  }
  await assertCostBudget(
    runRecordPath,
    costLedger,
    reservationCostUsd(finalInputTokens + config.budgets.maxOutputTokensPerCall, config),
    "FINAL",
    "RESERVATION",
  );
  const finalResponse = await completeWithAudit(
    runRecordPath,
    attemptNumber,
    provider,
    {
      stage: "FINAL",
      models: permittedModelsV1(config),
      maxOutputTokens: config.budgets.maxOutputTokensPerCall,
      timeoutMs: config.budgets.timeoutMs,
      messages: finalMessages,
      responseSchema: {
        name: isStandardsBrief(brief) ? "standards_candidate_v3" : "final_review_candidate_v3",
        schema: finalResponseSchema,
      },
    },
    {
      promptVersion: promptVersionForBrief(brief),
      responseArrayLimits: finalConstrained.appliedArrayLimits,
    },
    retryState
      ? providerRetryContextV1(retryState, config, costLedger, {
          requiredTokens:
            firstCallTokens + finalInputTokens + config.budgets.maxOutputTokensPerCall,
          remainingTokens: finalInputTokens + config.budgets.maxOutputTokensPerCall,
        })
      : undefined,
  );
  attemptNumber = retryState?.lastAttempt ?? attemptNumber;
  await writeFile(
    join(reviewDirectory, "final-provider-response.json"),
    jsonDocument(providerRecord(finalResponse)),
    { flag: "wx", mode: 0o600 },
  );
  const finalCallTokens =
    chargedTokens(finalResponse) ?? finalInputTokens + config.budgets.maxOutputTokensPerCall;
  if (
    firstCallTokens + finalCallTokens + (retryState?.failedTokens ?? 0) >
    config.budgets.maxTotalTokens
  ) {
    throw new Error("Provider-reported usage exceeded the total token budget.");
  }
  const finalCallCostUsd = callCostUsd(finalResponse, config, finalInputTokens);
  await assertCostBudget(runRecordPath, costLedger, finalCallCostUsd, "FINAL", "REPORTED");
  costLedger.record(finalCallCostUsd);
  try {
    return await parseFinal(
      finalResponse.value,
      preliminary,
      findingVerification,
      brief,
      packetPath,
      authorVerificationClaims,
    );
  } catch (error) {
    if (!(error instanceof ReviewOutputValidationError)) {
      throw error;
    }
    const validationError = error.message.slice(0, 4_000);
    await appendRunEvent(runRecordPath, {
      type: "FINAL_CANDIDATE_REJECTED",
      attemptNumber,
      validationError,
    });
    const repairMessages: ReviewMessageV1[] = [
      ...finalMessages,
      { role: "assistant", content: finalResponse.rawContent },
      {
        role: "user",
        content: JSON.stringify({
          schemaVersion: 1,
          type: "FINAL_OUTPUT_REPAIR",
          instruction:
            "Return one complete corrected final report under the same schema. Change only what is needed to resolve every listed validation error; preserve supported review conclusions and evidence.",
          validationError,
        }),
      },
    ];
    assertConversationBudget(repairMessages, config.budgets.maxConversationBytes);
    const repairConstrained = constrainRepairReferencesV1(finalConstrained, preliminary);
    const repairInputTokens = conservativeInputTokenUpperBound(
      repairMessages,
      repairConstrained.schema,
    );
    if (
      firstCallTokens +
        finalCallTokens +
        (retryState?.failedTokens ?? 0) +
        repairInputTokens +
        config.budgets.maxOutputTokensPerCall >
      config.budgets.maxTotalTokens
    ) {
      throw new ReviewOutputValidationError(
        `${error.message}\nThe remaining token budget cannot reserve one final-output repair call.`,
        { cause: error },
      );
    }
    await assertCostBudget(
      runRecordPath,
      costLedger,
      reservationCostUsd(repairInputTokens + config.budgets.maxOutputTokensPerCall, config),
      "FINAL",
      "RESERVATION",
    );
    await appendRunEvent(runRecordPath, {
      type: "FINAL_REPAIR_REQUESTED",
      rejectedAttemptNumber: attemptNumber,
      repairAttemptNumber: attemptNumber + 1,
    });
    const repairResponse = await completeWithAudit(
      runRecordPath,
      attemptNumber + 1,
      provider,
      {
        stage: "FINAL",
        models: [finalResponse.model ?? config.model],
        maxOutputTokens: config.budgets.maxOutputTokensPerCall,
        timeoutMs: config.budgets.timeoutMs,
        messages: repairMessages,
        responseSchema: {
          name: isStandardsBrief(brief) ? "standards_candidate_v3" : "final_review_candidate_v3",
          schema: repairConstrained.schema,
        },
      },
      {
        promptVersion: promptVersionForBrief(brief),
        responseArrayLimits: repairConstrained.appliedArrayLimits,
      },
      retryState
        ? providerRetryContextV1(retryState, config, costLedger, {
            requiredTokens:
              firstCallTokens +
              finalCallTokens +
              repairInputTokens +
              config.budgets.maxOutputTokensPerCall,
            remainingTokens: repairInputTokens + config.budgets.maxOutputTokensPerCall,
          })
        : undefined,
    );
    await writeFile(
      join(reviewDirectory, "final-repair-provider-response.json"),
      jsonDocument(providerRecord(repairResponse)),
      { flag: "wx", mode: 0o600 },
    );
    const repairCallTokens =
      chargedTokens(repairResponse) ?? repairInputTokens + config.budgets.maxOutputTokensPerCall;
    if (
      firstCallTokens + finalCallTokens + repairCallTokens + (retryState?.failedTokens ?? 0) >
      config.budgets.maxTotalTokens
    ) {
      throw new Error("Provider-reported usage exceeded the total token budget.");
    }
    const repairCallCostUsd = callCostUsd(repairResponse, config, repairInputTokens);
    await assertCostBudget(runRecordPath, costLedger, repairCallCostUsd, "FINAL", "REPORTED");
    costLedger.record(repairCallCostUsd);
    try {
      return await parseFinal(
        repairResponse.value,
        preliminary,
        findingVerification,
        brief,
        packetPath,
        authorVerificationClaims,
      );
    } catch (repairError) {
      if (repairError instanceof ReviewOutputValidationError) {
        await appendRunEvent(runRecordPath, {
          type: "FINAL_CANDIDATE_REJECTED",
          attemptNumber: retryState?.lastAttempt ?? attemptNumber + 1,
          validationError: repairError.message.slice(0, 4_000),
        });
      }
      throw repairError;
    }
  }
}

interface ReleasedAuthorContextV1 {
  binding?: AuthorContextBindingV1;
  authorPacket?: ReviewAuthor;
  claimedVerification: AuthorPacketV1["claimedVerification"];
}

function releasedAuthorContextV1(packet: InspectedSnapshotPacket): ReleasedAuthorContextV1 {
  if (packet.authorContext?.status === "DECLINED") {
    return { binding: packet.authorContext, claimedVerification: [] };
  }
  if (packet.authorPacket) {
    return {
      ...(packet.authorContext ? { binding: packet.authorContext } : {}),
      authorPacket: packet.authorPacket,
      claimedVerification: packet.authorPacket.claimedVerification,
    };
  }
  throw new Error("An author packet or explicit declined author context is required.");
}

function authorReleaseMessageV1(brief: ReviewBrief, released: ReleasedAuthorContextV1): string {
  if (!released.binding) {
    return JSON.stringify({
      schemaVersion: 1,
      type: "AUTHOR_PACKET",
      snapshotDigest: brief.snapshotManifest.snapshotDigest,
      authorPacket: released.authorPacket,
    });
  }
  return JSON.stringify({
    schemaVersion: 1,
    type: "AUTHOR_CONTEXT_RELEASED",
    snapshotDigest: brief.snapshotManifest.snapshotDigest,
    authorContext: released.binding,
    ...(released.authorPacket
      ? { authorPacket: released.authorPacket }
      : { declinedMarker: DECLINED_AUTHOR_CONTEXT_MARKER_V1 }),
  });
}

function bindReleasedAuthorContextV1(
  report: ReviewReport,
  released: ReleasedAuthorContextV1,
): ReviewReport {
  if (!released.binding) return report;
  if (!("ruleAssessments" in report))
    throw new Error("Explicit author-context lifecycle requires a standards report.");
  return StandardsReportV3Schema.parse({
    ...report,
    schemaVersion: 3,
    authorContext: {
      status: released.binding.status,
      digest: released.binding.digest,
      noteCode: released.binding.status === "DECLINED" ? "AUTHOR_CONTEXT_DECLINED" : null,
    },
    ...(released.binding.status === "DECLINED"
      ? { authorClaims: [], authorVerificationClaims: [] }
      : {}),
  });
}

function prepareReviewCalls(
  brief: ReviewBrief,
  releasedAuthorContext: ReleasedAuthorContextV1,
  config: ReviewRunConfigV3,
  plan: ReviewUnitPlanV1,
  contextMap: ReviewContextMapV1,
) {
  const blindEvidence = blindReviewEvidence(brief, plan, contextMap);
  const blindMessages: ReviewMessageV1[] = [
    {
      role: "system",
      content: systemPolicyForBrief(brief),
    },
    { role: "user", content: JSON.stringify(blindEvidence) },
  ];
  const evidencePaths = transmittedEvidencePathsV1(brief);
  const changedPaths = brief.snapshotManifest.paths.map((entry) => entry.path).sort();
  const canonicalInputIds = brief.snapshotManifest.canonicalInputs.map((entry) => entry.id).sort();
  const preliminaryConstrained = constrainResponseSchemaV1(
    isStandardsBrief(brief)
      ? STANDARDS_PRELIMINARY_V2_JSON_SCHEMA
      : PRELIMINARY_ASSESSMENT_V1_JSON_SCHEMA,
    {
      evidencePaths,
      changedPaths,
      canonicalInputIds,
      identities: {
        snapshotDigest: brief.snapshotManifest.snapshotDigest.value,
        briefDigest: brief.briefDigest.value,
      },
      authorVerificationClaims: releasedAuthorContext.claimedVerification,
      ...(isStandardsBrief(brief)
        ? { ruleIds: selectedRules(brief.canonicalInputs).map((rule) => rule.id) }
        : {}),
    },
  );
  const preliminaryResponseSchema = preliminaryConstrained.schema;
  const finalConstrained = constrainResponseSchemaV1(
    isStandardsBrief(brief)
      ? STANDARDS_CANDIDATE_V3_JSON_SCHEMA
      : FINAL_REVIEW_CANDIDATE_V3_JSON_SCHEMA,
    {
      evidencePaths,
      changedPaths,
      canonicalInputIds,
      identities: {
        snapshotDigest: brief.snapshotManifest.snapshotDigest.value,
        briefDigest: brief.briefDigest.value,
      },
      authorVerificationClaims: releasedAuthorContext.claimedVerification,
      ...(isStandardsBrief(brief)
        ? { ruleIds: selectedRules(brief.canonicalInputs).map((rule) => rule.id) }
        : {}),
    },
  );
  const finalResponseSchema = finalConstrained.schema;
  const findingVerificationResponseSchema = constrainFindingVerificationCandidateSchemaV4(
    FINDING_VERIFICATION_CANDIDATE_V4_JSON_SCHEMA,
    findingVerificationReservationCountV1(),
    findingVerificationConcernReservationCountV1(),
    {
      snapshotDigest: brief.snapshotManifest.snapshotDigest.value,
      briefDigest: brief.briefDigest.value,
    },
  ).schema;
  assertConversationBudget(blindMessages, config.budgets.maxConversationBytes);
  const authorMessage = authorReleaseMessageV1(brief, releasedAuthorContext);
  const guidanceAdmission = guidanceAdmissionForCallsV1(
    brief,
    blindEvidence,
    blindMessages,
    authorMessage,
    config.budgets.maxConversationBytes,
  );
  const finalMessageSkeleton: ReviewMessageV1[] = [
    ...blindMessages,
    { role: "assistant", content: "" },
    { role: "user", content: findingVerificationEnvelope(null) },
    { role: "user", content: authorMessage },
  ];
  assertConversationBudget(finalMessageSkeleton, config.budgets.maxConversationBytes);
  assertConversationBudget(
    findingVerificationMessagesV4(blindEvidence, null),
    config.budgets.maxConversationBytes,
  );
  const reservations = requiredReviewTokenReservations(
    blindMessages,
    blindEvidence,
    authorMessage,
    config.budgets.maxOutputTokensPerCall,
    preliminaryResponseSchema,
    findingVerificationResponseSchema,
    finalResponseSchema,
  );
  const {
    preliminaryCallReservation,
    findingVerificationCallReservation,
    finalCallReservation,
    requiredTokens,
  } = reservations;
  const retryReservation = Math.max(
    preliminaryCallReservation,
    findingVerificationCallReservation,
    finalCallReservation,
  );
  const requiredWithRetry = requiredTokens + retryReservation;
  if (requiredWithRetry > config.budgets.maxTotalTokens) {
    throw new Error(
      `The review reserves ${requiredWithRetry} of the ${config.budgets.maxTotalTokens}-unit token budget, including selective finding verification and one provider retry (${requiredTokens} without retry). Reservations bound tokens by UTF-8 payload size, so they run roughly four times the tokens a call actually spends; raise budgets.maxTotalTokens rather than reading this as a token count.`,
    );
  }

  const reservedCostUsd =
    reservationCostUsd(requiredTokens, config, 3) +
    priceCeilingCostUsd(
      retryReservation - config.budgets.maxOutputTokensPerCall,
      config.budgets.maxOutputTokensPerCall,
      config,
    );
  return {
    blindMessages,
    blindEvidence,
    authorMessage,
    preliminaryConstrained,
    finalConstrained,
    preliminaryResponseSchema,
    requiredTokens,
    requiredWithRetry,
    retryReservation,
    findingVerificationCallReservation,
    finalCallReservation,
    reservedCostUsd,
    guidanceAdmission,
  };
}

/** Uses the same admission calculation as execution, without constructing a provider. */
export async function preflightReview(
  packetPath: string,
  configValue: unknown,
  guidanceRepositoryPath?: string,
) {
  const config = ReviewRunConfigV3Schema.parse(configValue);
  const packet = await inspectSnapshotPacket(packetPath, {
    ...(guidanceRepositoryPath !== undefined ? { guidanceRepositoryPath } : {}),
    requireGuidanceImportResolution: true,
  });
  const releasedAuthorContext = releasedAuthorContextV1(packet);
  if (packet.reviewConfigRef !== config.configId)
    throw new Error("Review configuration does not match packet.");
  if (!packet.manifest.paths.length)
    throw new Error("The snapshot contains no changed paths to review.");
  const brief = await buildReviewBrief(
    packetPath,
    config.budgets.maxInitialEvidenceBytes,
    guidanceRepositoryPath,
  );
  const plan = planReviewUnitsV1(brief, packet.contextMap, {
    policyVersion: REVIEW_UNIT_POLICY_VERSION_V1,
    maxSupportingBytesPerUnit: config.budgets.maxInitialEvidenceBytes,
  });
  const calls = prepareReviewCalls(brief, releasedAuthorContext, config, plan, packet.contextMap);
  if (calls.reservedCostUsd > config.budgets.maxTotalCostUsd)
    throw new Error("The remaining cost budget cannot reserve the preliminary call.");
  return {
    reservedTokens: calls.requiredWithRetry,
    reservedCostUsd: calls.reservedCostUsd,
    model: config.model,
    fallbackModels: config.fallbackModels,
    preferredProviders: config.providerRouting.order ?? [],
    pinnedToPreferredProviders: config.providerRouting.pinToOrder,
    snapshotDigest: brief.snapshotManifest.snapshotDigest,
    guidanceAdmission: calls.guidanceAdmission,
    ...(brief.schemaVersion === 3
      ? { guidanceGraphDigest: brief.guidanceGraph.guidanceGraphDigest }
      : {}),
  };
}

/** Runs two mandatory model calls and at most one output-repair call per stage. */
export async function runTwoStageReview(
  packetPath: string,
  configValue: unknown,
  provider: ReviewProviderV1,
  guidanceRepositoryPath?: string,
): Promise<TwoStageReviewResult> {
  const config = ReviewRunConfigV3Schema.parse(configValue);
  const packet = await inspectSnapshotPacket(packetPath, {
    ...(guidanceRepositoryPath !== undefined ? { guidanceRepositoryPath } : {}),
    requireGuidanceImportResolution: true,
  });
  if (packet.manifest.paths.length === 0) {
    throw new Error("The snapshot contains no changed paths to review.");
  }
  const releasedAuthorContext = releasedAuthorContextV1(packet);
  if (packet.reviewConfigRef !== config.configId) {
    throw new Error(
      `Review config ${config.configId} does not match packet reference ${packet.reviewConfigRef}.`,
    );
  }
  const brief = await buildReviewBrief(
    packetPath,
    config.budgets.maxInitialEvidenceBytes,
    guidanceRepositoryPath,
  );
  const plan = planReviewUnitsV1(brief, packet.contextMap, {
    policyVersion: REVIEW_UNIT_POLICY_VERSION_V1,
    maxSupportingBytesPerUnit: config.budgets.maxInitialEvidenceBytes,
  });
  const paths = reviewOutputPathsV1(packetPath);
  const { reviewDirectory, briefPath, planPath, preliminaryPath, runRecordPath } = paths;
  await mkdir(reviewDirectory, { mode: 0o700 });
  await writeFile(briefPath, jsonDocument(brief), { flag: "wx", mode: 0o600 });
  await writeFile(planPath, jsonDocument(plan), { flag: "wx", mode: 0o600 });
  await appendRunEvent(runRecordPath, {
    type: "RUN_STARTED",
    snapshotDigest: brief.snapshotManifest.snapshotDigest,
    briefDigest: brief.briefDigest,
    ...(brief.schemaVersion === 3
      ? { guidanceGraphDigest: brief.guidanceGraph.guidanceGraphDigest }
      : {}),
    contextMapDigest: packet.contextMap.contextMapDigest,
    planDigest: plan.planDigest,
    configId: config.configId,
    configDigest: sha256Utf8(JSON.stringify(config)),
    requestedModels: permittedModelsV1(config),
    promptVersion: promptVersionForBrief(brief),
    preliminarySchema: preliminarySchemaNameForBrief(brief),
    finalSchema: finalSchemaNameForBrief(brief),
    findingVerificationSchema: "finding_verification_candidate_v4",
    findingVerificationPromptVersion: FINDING_VERIFICATION_POLICY_VERSION_V4,
  });

  try {
    const {
      blindMessages,
      blindEvidence,
      authorMessage,
      preliminaryConstrained,
      finalConstrained,
      preliminaryResponseSchema,
      requiredTokens,
      findingVerificationCallReservation,
      finalCallReservation,
      reservedCostUsd,
      guidanceAdmission,
    } = prepareReviewCalls(brief, releasedAuthorContext, config, plan, packet.contextMap);
    if (guidanceAdmission) {
      await appendRunEvent(runRecordPath, {
        type: "GUIDANCE_ADMISSION",
        ...guidanceAdmission,
      });
    }
    const costLedger = new RunCostLedgerV1(config.budgets.maxTotalCostUsd);
    // Every possible mandatory call is reserved before spending on the preliminary stage.
    await assertCostBudget(
      runRecordPath,
      costLedger,
      reservedCostUsd,
      "PRELIMINARY",
      "RESERVATION",
    );
    const retryState: ProviderRetryStateV1 = {
      nextAttempt: 1,
      lastAttempt: 0,
      failedTokens: 0,
    };
    const preliminaryResponse = await completeWithAudit(
      runRecordPath,
      1,
      provider,
      {
        stage: "PRELIMINARY",
        models: permittedModelsV1(config),
        maxOutputTokens: config.budgets.maxOutputTokensPerCall,
        timeoutMs: config.budgets.timeoutMs,
        messages: blindMessages,
        responseSchema: {
          name: isStandardsBrief(brief) ? "standards_preliminary_v2" : "preliminary_assessment_v1",
          schema: preliminaryResponseSchema,
        },
      },
      {
        promptVersion: promptVersionForBrief(brief),
        responseArrayLimits: preliminaryConstrained.appliedArrayLimits,
      },
      providerRetryContextV1(retryState, config, costLedger, {
        requiredTokens,
        remainingTokens: requiredTokens,
      }),
    );
    await writeFile(
      join(reviewDirectory, "preliminary-provider-response.json"),
      jsonDocument(providerRecord(preliminaryResponse)),
      { flag: "wx", mode: 0o600 },
    );
    const validatedPreliminary = await validatePreliminaryStageV1(
      packetPath,
      reviewDirectory,
      runRecordPath,
      config,
      provider,
      brief,
      blindMessages,
      preliminaryConstrained,
      preliminaryResponse,
      findingVerificationCallReservation + finalCallReservation,
      costLedger,
      retryState,
    );
    const preliminary = validatedPreliminary.preliminary;
    await writeFile(preliminaryPath, jsonDocument(preliminary), { flag: "wx", mode: 0o600 });
    await appendRunEvent(runRecordPath, {
      type: "PRELIMINARY_PERSISTED",
      preliminaryDigest: sha256Utf8(jsonDocument(preliminary)),
      acceptedAttemptNumber: validatedPreliminary.acceptedAttemptNumber,
      responseArtifact: validatedPreliminary.responseArtifact,
    });

    const validatedVerification = await completeFindingVerificationStageV4(
      reviewDirectory,
      runRecordPath,
      config,
      provider,
      brief,
      blindEvidence,
      preliminary,
      validatedPreliminary.chargedTokens,
      findingVerificationCallReservation,
      finalCallReservation,
      costLedger,
      retryState,
    );
    const finalMessages: ReviewMessageV1[] = [
      ...blindMessages,
      { role: "assistant", content: validatedPreliminary.acceptedResponse.rawContent },
      {
        role: "user",
        content: findingVerificationEnvelope(validatedVerification.verification),
      },
      { role: "user", content: authorMessage },
    ];
    if (releasedAuthorContext.binding) {
      await appendRunEvent(runRecordPath, {
        type: "AUTHOR_CONTEXT_RELEASED",
        authorContext: releasedAuthorContext.binding,
      });
    } else {
      await appendRunEvent(runRecordPath, {
        type: "AUTHOR_DELIVERED",
        authorPacketDigest: sha256Utf8(JSON.stringify(releasedAuthorContext.authorPacket)),
      });
    }
    const candidateReport = await completeFinalStageV1(
      packetPath,
      reviewDirectory,
      runRecordPath,
      2,
      config,
      provider,
      brief,
      preliminary,
      validatedVerification.verification,
      finalMessages,
      finalConstrained,
      finalCallReservation,
      validatedPreliminary.chargedTokens + validatedVerification.chargedTokens,
      releasedAuthorContext.claimedVerification,
      costLedger,
      retryState,
    );
    const report = bindReleasedAuthorContextV1(candidateReport, releasedAuthorContext);
    return await finishReviewV1(report, brief, paths);
  } catch (error) {
    return await recordRunFailureV1(runRecordPath, error);
  }
}

/**
 * Reads the run record as typed events.
 *
 * Parsing here rather than reading raw objects is what makes resume eligibility checkable: every
 * field the gates below compare is declared in `RunRecordEventV1Schema`, so a renamed or
 * restructured event fails the build instead of quietly making every run ineligible (#122).
 */
async function readRunEventsV1(runRecordPath: string): Promise<ReadRunRecordResultV1> {
  return readRunRecordEventsV1(runRecordPath, {
    maxTotalBytes: MAX_PERSISTED_REVIEW_JSON_BYTES_V1,
    maxLineBytes: MAX_RUN_RECORD_LINE_BYTES_V1,
  });
}

/**
 * Fast-fails a resume whose outputs already exist, before a provider call is paid for.
 *
 * This is a preflight, not the exclusivity guard: it cannot close the window between the check and
 * the write. `writeExclusive` and its `flag: "wx"` are authoritative, and must stay that way.
 */
async function assertFileAbsent(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`Final-stage resume is not allowed because ${path} already exists.`);
}

/** Creates a review output exclusively; an existing file is never overwritten. */
async function writeExclusive(path: string, contents: string): Promise<void> {
  try {
    await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Refusing to overwrite an existing review output at ${path}.`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Every path one review writes under a packet.
 *
 * Built once so the two entry points cannot disagree about where an artifact lives. They used to
 * construct overlapping lists independently, and `resumeFinalReview` has to find exactly what
 * `runTwoStageReview` wrote -- a mismatch would surface as a missing-file failure partway through
 * a resume rather than as anything a reader could see (#123).
 */
interface ReviewOutputPathsV1 {
  reviewDirectory: string;
  briefPath: string;
  planPath: string;
  preliminaryPath: string;
  findingVerificationPath: string;
  finalPath: string;
  markdownPath: string;
  reportMetadataPath: string;
  runRecordPath: string;
  preliminaryProviderPath: string;
  preliminaryRepairProviderPath: string;
  findingVerificationProviderPath: string;
  finalProviderPath: string;
  finalResumeClaimPath: string;
}

function reviewOutputPathsV1(packetPath: string): ReviewOutputPathsV1 {
  const reviewDirectory = join(packetPath, "review");
  const at = (name: string): string => join(reviewDirectory, name);
  return {
    reviewDirectory,
    briefPath: at("neutral-review-brief.json"),
    planPath: at("review-unit-plan.json"),
    preliminaryPath: at("preliminary.json"),
    findingVerificationPath: at("finding-verification.json"),
    finalPath: at("final.json"),
    markdownPath: at("report.md"),
    reportMetadataPath: at("report-metadata.json"),
    runRecordPath: at("run-record.jsonl"),
    preliminaryProviderPath: at("preliminary-provider-response.json"),
    preliminaryRepairProviderPath: at("preliminary-repair-provider-response.json"),
    findingVerificationProviderPath: at("finding-verification-provider-response.json"),
    finalProviderPath: at("final-provider-response.json"),
    finalResumeClaimPath: at("final-resume-claim.json"),
  };
}

/**
 * Writes a finished report and its rendered views, then records the run as completed.
 *
 * Identical for a first run and for a resumed one, and it was duplicated verbatim between them.
 * A resumed review must produce the same artifacts as an unresumed one or its report is not
 * interchangeable with one (#123).
 */
async function finishReviewV1(
  report: ReviewReport,
  brief: ReviewBrief,
  paths: ReviewOutputPathsV1,
): Promise<TwoStageReviewResult> {
  const reportDocument = jsonDocument(report);
  await writeExclusive(paths.finalPath, reportDocument);
  await writeReportMetadataV1(paths.reportMetadataPath, reportDocument, brief);
  await writeExclusive(
    paths.markdownPath,
    renderReviewMarkdown(
      report,
      isStandardsBrief(brief) ? selectedRules(brief.canonicalInputs) : [],
      brief.coverageConstraints,
    ),
  );
  await appendRunEvent(paths.runRecordPath, {
    type: "RUN_COMPLETED",
    terminalState: report.verdict,
  });
  return {
    report,
    briefPath: paths.briefPath,
    preliminaryPath: paths.preliminaryPath,
    findingVerificationPath: paths.findingVerificationPath,
    finalPath: paths.finalPath,
    markdownPath: paths.markdownPath,
    reportMetadataPath: paths.reportMetadataPath,
    runRecordPath: paths.runRecordPath,
  };
}

/** Records a terminal failure against the run record and rethrows it unchanged. */
async function recordRunFailureV1(runRecordPath: string, error: unknown): Promise<never> {
  const normalized = normalizedError(error);
  await appendRunEvent(runRecordPath, {
    type: "RUN_FAILED",
    terminalState: normalized.code === "TRANSPORT_UNCERTAIN" ? "TRANSPORT_UNCERTAIN" : "FAILED",
    error: normalized,
  });
  throw error;
}

async function writeReportMetadataV1(
  path: string,
  reportDocument: string,
  brief: ReviewBrief,
): Promise<void> {
  await writeExclusive(
    path,
    jsonDocument(
      ReviewReportMetadataV1Schema.parse({
        schemaVersion: 1,
        snapshotDigest: brief.snapshotManifest.snapshotDigest,
        briefDigest: brief.briefDigest,
        guidanceGraphDigest:
          brief.schemaVersion === 3 ? brief.guidanceGraph.guidanceGraphDigest : null,
        reportDigest: sha256Utf8(reportDocument),
        promptVersion: promptVersionForBrief(brief),
        preliminarySchema: preliminarySchemaNameForBrief(brief),
        finalSchema: finalSchemaNameForBrief(brief),
      }),
    ),
  );
}

/**
 * Explicitly retries only a final call that received a definite provider 429.
 * The persisted blind assessment and exact run configuration are reused.
 */
/**
 * Refuses a resume whose persisted run would answer a different question than this invocation.
 *
 * The prompt and schema names pin the protocol the first call was made under, and the config
 * triple pins what it was permitted to spend; a resume reuses the persisted preliminary and
 * verification verbatim, so any drift here would splice two incompatible runs together.
 */
function assertResumeProtocolV1(
  started: Extract<RunRecordEventV1, { type: "RUN_STARTED" }>,
  packet: InspectedSnapshotPacket,
  config: ReviewRunConfigV3,
  expectedConfigDigest: DigestV1,
): void {
  if (
    started.promptVersion !==
      (packet.guidanceGraph
        ? STANDARDS_GUIDANCE_POLICY_VERSION_V1
        : "standards" in packet.canonicalInputs
          ? STANDARDS_POLICY_VERSION
          : REVIEW_PROMPT_VERSION_V1) ||
    JSON.stringify(started.guidanceGraphDigest) !== JSON.stringify(packet.guidanceGraphDigest) ||
    started.finalSchema !==
      ("standards" in packet.canonicalInputs
        ? "standards_candidate_v3"
        : "final_review_candidate_v3") ||
    started.findingVerificationSchema !== "finding_verification_candidate_v4" ||
    started.findingVerificationPromptVersion !== FINDING_VERIFICATION_POLICY_VERSION_V4
  ) {
    throw new Error(
      "The persisted run uses an incompatible final response protocol; start a new review.",
    );
  }
  if (
    started.configId !== config.configId ||
    JSON.stringify(started.configDigest) !== JSON.stringify(expectedConfigDigest) ||
    JSON.stringify(started.requestedModels) !== JSON.stringify(permittedModelsV1(config))
  ) {
    throw new Error("The resume configuration must exactly match the original review run.");
  }
}

/**
 * Re-derives the brief and plan from the frozen packet and requires the persisted copies to match
 * byte for byte.
 *
 * Reading them back is not enough: the resume reuses a preliminary assessment that was written
 * against these exact inputs, so an identical-looking rebuild is the only evidence that the packet
 * on disk still means what it meant when that assessment was produced.
 */
async function verifyPersistedReviewInputsV1(
  packetPath: string,
  paths: ReviewOutputPathsV1,
  config: ReviewRunConfigV3,
  packet: InspectedSnapshotPacket,
  started: Extract<RunRecordEventV1, { type: "RUN_STARTED" }>,
  guidanceRepositoryPath: string | undefined,
): Promise<{ brief: ReviewBrief; plan: ReviewUnitPlanV1 }> {
  const briefValue = await readStrictJsonFileV1(paths.briefPath, {
    maxBytes: MAX_PERSISTED_REVIEW_JSON_BYTES_V1,
    source: "persisted neutral review brief",
  });
  if (!verifyReviewBriefIdentity(briefValue)) {
    throw new Error("The persisted neutral review brief identity is invalid.");
  }
  const brief = ReviewBriefSchema.parse(briefValue);
  const rebuiltBrief = await buildReviewBrief(
    packetPath,
    config.budgets.maxInitialEvidenceBytes,
    guidanceRepositoryPath,
  );
  if (
    JSON.stringify(brief) !== JSON.stringify(rebuiltBrief) ||
    JSON.stringify(started.snapshotDigest) !==
      JSON.stringify(brief.snapshotManifest.snapshotDigest) ||
    JSON.stringify(started.briefDigest) !== JSON.stringify(brief.briefDigest)
  ) {
    throw new Error("The persisted final-stage inputs no longer match the frozen packet.");
  }

  const planValue = await readStrictJsonFileV1(paths.planPath, {
    maxBytes: MAX_PERSISTED_REVIEW_JSON_BYTES_V1,
    source: "persisted review unit plan",
  });
  if (!verifyReviewUnitPlanIdentityV1(planValue)) {
    throw new Error("The persisted review unit plan identity is invalid.");
  }
  const plan = ReviewUnitPlanV1Schema.parse(planValue);
  const rebuiltPlan = planReviewUnitsV1(brief, packet.contextMap, {
    policyVersion: REVIEW_UNIT_POLICY_VERSION_V1,
    maxSupportingBytesPerUnit: config.budgets.maxInitialEvidenceBytes,
  });
  if (
    JSON.stringify(plan) !== JSON.stringify(rebuiltPlan) ||
    JSON.stringify(started.contextMapDigest) !==
      JSON.stringify(packet.contextMap.contextMapDigest) ||
    JSON.stringify(started.planDigest) !== JSON.stringify(plan.planDigest)
  ) {
    throw new Error("The persisted review unit plan no longer matches the frozen packet.");
  }
  return { brief, plan };
}

type ResumeShapeV1 = Extract<ReturnType<typeof evaluateResumeShapeV1>, { eligible: true }>["shape"];
type StoredProviderResponseV1 = z.infer<typeof StoredProviderResponseV1Schema>;

/**
 * Reads the stored preliminary completions, in ledger order, and proves each is the response the
 * run record says was accepted.
 *
 * A repaired preliminary leaves two artifacts, so the artifact name recorded at persistence must
 * name the last of them; the per-response model and usage checks keep a hand-edited artifact from
 * silently replacing what the provider actually returned.
 */
async function readVerifiedPreliminaryResponsesV1(
  paths: ReviewOutputPathsV1,
  config: ReviewRunConfigV3,
  preliminarySucceededCalls: ResumeShapeV1["preliminarySucceededCalls"],
  preliminaryPersisted: ResumeShapeV1["preliminaryPersisted"],
): Promise<StoredProviderResponseV1[]> {
  const providerPaths =
    preliminarySucceededCalls.length === 2
      ? [paths.preliminaryProviderPath, paths.preliminaryRepairProviderPath]
      : [paths.preliminaryProviderPath];
  if (preliminaryPersisted?.responseArtifact !== (providerPaths.at(-1)?.split("/").at(-1) ?? "")) {
    throw new Error("The persisted preliminary response artifact is inconsistent with the ledger.");
  }
  const responses = await Promise.all(
    providerPaths.map(async (path, index) =>
      StoredProviderResponseV1Schema.parse(
        await readStrictJsonFileV1(path, {
          maxBytes: MAX_STORED_PROVIDER_RESPONSE_BYTES_V1,
          source: `stored preliminary provider response ${index + 1}`,
        }),
      ),
    ),
  );
  responses.forEach((response, index) => {
    const succeeded = preliminarySucceededCalls[index];
    if (
      response.model !== succeeded?.returnedModel ||
      (response.model !== null && !permittedModelsV1(config).includes(response.model)) ||
      JSON.stringify(succeeded?.usage) !== JSON.stringify(response.usage)
    ) {
      throw new Error(
        "A persisted preliminary response does not match the requested model or ledger.",
      );
    }
  });
  return responses;
}

/**
 * Returns the stored finding-verification completion, or undefined when the stage was resolved
 * locally.
 *
 * A preliminary with nothing adverse to check never calls the provider, so the two shapes are
 * mutually exclusive and each is proven against the ledger: a call must name its artifact and
 * re-parse to exactly the persisted verification, and a local resolution must have left no
 * artifact and no succeeded call behind.
 */
async function readVerifiedFindingVerificationResponseV1(
  paths: ReviewOutputPathsV1,
  config: ReviewRunConfigV3,
  brief: ReviewBrief,
  preliminary: ReviewPreliminary,
  findingVerification: FindingVerificationV4 | null,
  succeededCalls: ResumeShapeV1["findingVerificationSucceededCalls"],
  persisted: ResumeShapeV1["findingVerificationPersisted"],
): Promise<StoredProviderResponseV1 | undefined> {
  const hasAdverseClaims =
    preliminary.findings.length > 0 ||
    preliminary.evidenceGaps.length > 0 ||
    preliminary.limitations.length > 0;
  if (!hasAdverseClaims) {
    if (
      persisted?.providerCall !== false ||
      persisted.responseArtifact !== null ||
      succeededCalls.length !== 0
    ) {
      throw new Error("An adverse-claim-free preliminary must use local empty verification.");
    }
    return undefined;
  }

  const succeeded = succeededCalls[0];
  if (
    persisted?.providerCall !== true ||
    persisted.responseArtifact !== "finding-verification-provider-response.json" ||
    succeeded === undefined ||
    succeeded.attemptNumber !== persisted.acceptedAttemptNumber
  ) {
    throw new Error("The persisted finding verification is inconsistent with the ledger.");
  }
  const response = StoredProviderResponseV1Schema.parse(
    await readStrictJsonFileV1(paths.findingVerificationProviderPath, {
      maxBytes: MAX_STORED_PROVIDER_RESPONSE_BYTES_V1,
      source: "stored finding verification provider response",
    }),
  );
  if (
    response.model !== succeeded.returnedModel ||
    (response.model !== null && !permittedModelsV1(config).includes(response.model)) ||
    JSON.stringify(response.usage) !== JSON.stringify(succeeded.usage) ||
    JSON.stringify(
      parseFindingVerificationCandidate(
        parseStrictJsonV1(response.rawContent, {
          maxBytes: MAX_STORED_PROVIDER_RESPONSE_BYTES_V1,
          source: "stored finding verification raw completion",
        }),
        preliminary,
        brief,
      ),
    ) !== JSON.stringify(findingVerification)
  ) {
    throw new Error("The persisted finding-verification response is invalid.");
  }
  return response;
}

/**
 * Reconstructs the input-token reservation each preliminary call was charged against.
 *
 * A repaired preliminary billed two calls whose second request this invocation never saw, so the
 * repair request is rebuilt from the rejected artifact and its persisted validation error and
 * matched against the input digest the run record stored. Without that match the resume would
 * charge the ledger for a request nobody can prove was made.
 */
function replayPreliminaryInputReservationsV1(
  config: ReviewRunConfigV3,
  brief: ReviewBrief,
  events: readonly RunRecordEventV1[],
  startedCalls: ResumeShapeV1["startedCalls"],
  acceptedAttemptNumber: ResumeShapeV1["acceptedAttemptNumber"],
  blindMessages: ReviewMessageV1[],
  preliminaryResponseSchema: unknown,
  preliminaryProviders: readonly StoredProviderResponseV1[],
): number[] {
  const reservations = [conservativeInputTokenUpperBound(blindMessages, preliminaryResponseSchema)];
  if (preliminaryProviders.length !== 2) return reservations;

  const rejected = events.find((event) => event.type === "PRELIMINARY_CANDIDATE_REJECTED");
  if (typeof rejected?.validationError !== "string") {
    throw new Error("The preliminary repair is missing its persisted validation error.");
  }
  const rejectedProvider = preliminaryProviders[0];
  if (rejectedProvider === undefined) {
    throw new Error("The rejected preliminary response artifact is unavailable.");
  }
  const repairMessages = preliminaryRepairMessagesV1(
    blindMessages,
    rejectedProvider.rawContent,
    rejected.validationError,
    transmittedLineEvidenceV1(brief),
  );
  const repairRequest = {
    stage: "PRELIMINARY" as const,
    models: [rejectedProvider.model ?? config.model],
    maxOutputTokens: config.budgets.maxOutputTokensPerCall,
    timeoutMs: config.budgets.timeoutMs,
    messages: repairMessages,
    responseSchema: {
      name: isStandardsBrief(brief) ? "standards_preliminary_v2" : "preliminary_assessment_v1",
      schema: preliminaryResponseSchema,
    },
  };
  const repairStarted = startedCalls.find(
    (event) => event.stage === "PRELIMINARY" && event.attemptNumber === acceptedAttemptNumber,
  );
  if (
    JSON.stringify(repairStarted?.inputDigest) !==
    JSON.stringify(sha256Utf8(JSON.stringify(repairRequest)))
  ) {
    throw new Error("The persisted preliminary repair does not match its input digest.");
  }
  reservations.push(conservativeInputTokenUpperBound(repairMessages, preliminaryResponseSchema));
  return reservations;
}

/**
 * Rebuilds the finding-verification request to confirm the persisted call, and returns what it
 * spent.
 *
 * Reservation rather than reported usage is the fallback for call tokens: a provider that omitted
 * usage must not make the resume look cheaper than the ceiling the original call was admitted
 * under. A locally resolved stage spent nothing and reports zero.
 */
function replayFindingVerificationSpendV1(
  config: ReviewRunConfigV3,
  brief: ReviewBrief,
  preliminary: ReviewPreliminary,
  blindEvidence: unknown,
  startedCalls: ResumeShapeV1["startedCalls"],
  succeededCalls: ResumeShapeV1["findingVerificationSucceededCalls"],
  provider: StoredProviderResponseV1 | undefined,
  callReservation: number,
): { inputTokens: number; callTokens: number } {
  if (!provider) return { inputTokens: 0, callTokens: 0 };

  const constrained = constrainFindingVerificationCandidateSchemaV4(
    FINDING_VERIFICATION_CANDIDATE_V4_JSON_SCHEMA,
    preliminary.findings.length,
    preliminary.evidenceGaps.length + preliminary.limitations.length,
    {
      snapshotDigest: brief.snapshotManifest.snapshotDigest.value,
      briefDigest: brief.briefDigest.value,
    },
  );
  const request = {
    stage: "FINDING_VERIFICATION" as const,
    models: permittedModelsV1(config),
    maxOutputTokens: config.budgets.maxOutputTokensPerCall,
    timeoutMs: config.budgets.timeoutMs,
    messages: findingVerificationMessagesV4(blindEvidence, preliminary),
    responseSchema: {
      name: "finding_verification_candidate_v4",
      schema: constrained.schema,
    },
  };
  const succeeded = succeededCalls[0];
  const started = startedCalls.find(
    (event) =>
      event.stage === "FINDING_VERIFICATION" && event.attemptNumber === succeeded?.attemptNumber,
  );
  if (
    started?.promptVersion !== FINDING_VERIFICATION_POLICY_VERSION_V4 ||
    JSON.stringify(started.inputDigest) !== JSON.stringify(sha256Utf8(JSON.stringify(request)))
  ) {
    throw new Error("The persisted finding-verification request is invalid.");
  }
  return {
    inputTokens: callReservation - config.budgets.maxOutputTokensPerCall,
    callTokens: chargedTokens({ usage: provider.usage }) ?? callReservation,
  };
}

interface ResumeSpendInputsV1 {
  preliminaryProviders: readonly StoredProviderResponseV1[];
  preliminaryInputReservations: readonly number[];
  findingVerificationProvider: StoredProviderResponseV1 | undefined;
  findingVerificationInputTokens: number;
  findingVerificationCallTokens: number;
  finalCallReservation: number;
}

/**
 * Rebuilds the run's spend so far so the resumed final call is admitted against the run's ceiling
 * rather than a fresh one.
 *
 * The ceiling covers the whole review, not one invocation of the CLI, so every earlier call is
 * re-charged here: the persisted preliminaries, the finding verification if it called out, each
 * retry's recorded charge, and the failed final attempt at its reserved price ceiling. A call that
 * reported no usage falls back to its reservation, which is why a resume can never look cheaper
 * than the run it continues.
 */
function replayRunSpendV1(
  config: ReviewRunConfigV3,
  events: readonly RunRecordEventV1[],
  spend: ResumeSpendInputsV1,
): { costLedger: RunCostLedgerV1; firstCallTokens: number } {
  const {
    preliminaryProviders,
    preliminaryInputReservations,
    findingVerificationProvider,
    findingVerificationInputTokens,
    findingVerificationCallTokens,
    finalCallReservation,
  } = spend;
  const failedFinalInputTokens = finalCallReservation - config.budgets.maxOutputTokensPerCall;
  const preliminaryCallTokens = preliminaryProviders.reduce(
    (total, response, index) =>
      total +
      (chargedTokens({ usage: response.usage }) ??
        (preliminaryInputReservations[index] as number) + config.budgets.maxOutputTokensPerCall),
    0,
  );

  let chargedFailedTokens = 0;
  let chargedFailedCostUsd = 0;
  for (const retry of events.filter((event) => event.type === "PROVIDER_RETRY_REQUESTED")) {
    if (
      !Number.isSafeInteger(retry.chargedFailedTokens) ||
      (retry.chargedFailedTokens as number) < 0 ||
      typeof retry.chargedFailedCostUsd !== "number" ||
      !Number.isFinite(retry.chargedFailedCostUsd) ||
      retry.chargedFailedCostUsd < 0
    ) {
      throw new Error("The persisted provider-retry charge is invalid.");
    }
    chargedFailedTokens += retry.chargedFailedTokens as number;
    chargedFailedCostUsd += retry.chargedFailedCostUsd;
  }

  const costLedger = new RunCostLedgerV1(config.budgets.maxTotalCostUsd);
  preliminaryProviders.forEach((response, index) => {
    costLedger.record(
      callCostUsd(
        { ...response, value: null },
        config,
        preliminaryInputReservations[index] as number,
      ),
    );
  });
  if (findingVerificationProvider) {
    costLedger.record(
      callCostUsd(
        { ...findingVerificationProvider, value: null },
        config,
        findingVerificationInputTokens,
      ),
    );
  }
  costLedger.record(chargedFailedCostUsd);
  costLedger.record(
    priceCeilingCostUsd(failedFinalInputTokens, config.budgets.maxOutputTokensPerCall, config),
  );
  return {
    costLedger,
    firstCallTokens:
      preliminaryCallTokens +
      findingVerificationCallTokens +
      chargedFailedTokens +
      // A deferred manual retry inherits conservative spend for its failed predecessor.
      finalCallReservation,
  };
}

/**
 * Takes the one permitted final-stage resume, repairs a torn run record, and opens the new attempt.
 *
 * The claim file is written with O_EXCL first and deliberately: it is the only thing standing
 * between two concurrent resumes and a double charge, so it must be won before any repair or event
 * append. Tail recovery then re-reads the record and refuses if anything moved since inspection,
 * because every gate above was decided against the bytes read at that time.
 */
async function claimFinalResumeV1(
  paths: ReviewOutputPathsV1,
  runRecord: ReadRunRecordResultV1,
  expectedConfigDigest: DigestV1,
  failedAttemptNumber: number,
  resumedAttemptNumber: number,
): Promise<void> {
  try {
    await writeFile(
      paths.finalResumeClaimPath,
      jsonDocument({
        schemaVersion: 1,
        stage: "FINAL",
        failedAttemptNumber,
        claimedAttemptNumber: resumedAttemptNumber,
        configDigest: expectedConfigDigest,
      }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("The one permitted final-stage resume has already been claimed.");
    }
    throw error;
  }
  if (runRecord.tailBytes > 0) {
    const confirmed = await readRunEventsV1(paths.runRecordPath);
    if (
      confirmed.completeBytes !== runRecord.completeBytes ||
      confirmed.tailBytes !== runRecord.tailBytes ||
      JSON.stringify(confirmed.events) !== JSON.stringify(runRecord.events)
    ) {
      throw new Error("The review run record changed after it was inspected; refusing recovery.");
    }
    await recoverRunRecordTailV1(paths.runRecordPath, runRecord);
    await appendRunEvent(paths.runRecordPath, {
      type: "RUN_RECORD_TAIL_RECOVERED",
      discardedBytes: runRecord.tailBytes,
    });
  }
  await appendRunEvent(paths.runRecordPath, {
    type: "RUN_RESUMED",
    stage: "FINAL",
    failedAttemptNumber,
    nextAttemptNumber: resumedAttemptNumber,
  });
}

export async function resumeFinalReview(
  packetPath: string,
  configValue: unknown,
  provider: ReviewProviderV1,
  guidanceRepositoryPath?: string,
): Promise<TwoStageReviewResult> {
  const config = ReviewRunConfigV3Schema.parse(configValue);
  const packet = await inspectSnapshotPacket(packetPath, {
    ...(guidanceRepositoryPath !== undefined ? { guidanceRepositoryPath } : {}),
    requireGuidanceImportResolution: true,
  });
  const releasedAuthorContext = releasedAuthorContextV1(packet);
  if (packet.reviewConfigRef !== config.configId) {
    throw new Error(
      `Review config ${config.configId} does not match packet reference ${packet.reviewConfigRef}.`,
    );
  }

  const paths = reviewOutputPathsV1(packetPath);
  const {
    reviewDirectory,
    preliminaryPath,
    findingVerificationPath,
    finalProviderPath,
    finalPath,
    markdownPath,
    reportMetadataPath,
    runRecordPath,
  } = paths;

  const runRecord = await readRunEventsV1(runRecordPath);
  const events = runRecord.events;
  const eligibility = evaluateResumeShapeV1(events);
  if (!eligibility.eligible) {
    throw new Error(describeResumeRefusalsV1(eligibility.refusals));
  }
  const {
    started,
    startedCalls,
    preliminarySucceededCalls,
    preliminaryPersisted,
    findingVerificationPersisted,
    findingVerificationSucceededCalls,
    authorDelivered,
    finalStarted,
    acceptedAttemptNumber,
  } = eligibility.shape;
  const expectedConfigDigest = sha256Utf8(JSON.stringify(config));
  assertResumeProtocolV1(started, packet, config, expectedConfigDigest);

  const { brief, plan } = await verifyPersistedReviewInputsV1(
    packetPath,
    paths,
    config,
    packet,
    started,
    guidanceRepositoryPath,
  );

  const preliminaryProviders = await readVerifiedPreliminaryResponsesV1(
    paths,
    config,
    preliminarySucceededCalls,
    preliminaryPersisted,
  );
  const preliminaryProvider = preliminaryProviders.at(-1);
  if (preliminaryProvider === undefined) {
    throw new Error("The accepted preliminary provider response is unavailable.");
  }
  const preliminaryCandidate = await parsePreliminary(
    parseStrictJsonV1(preliminaryProvider.rawContent, {
      maxBytes: MAX_STORED_PROVIDER_RESPONSE_BYTES_V1,
      source: "stored preliminary raw completion",
    }),
    brief,
    packetPath,
  );
  const preliminary = await parsePreliminary(
    await readStrictJsonFileV1(preliminaryPath, {
      maxBytes: MAX_PERSISTED_REVIEW_JSON_BYTES_V1,
      source: "persisted preliminary assessment",
    }),
    brief,
    packetPath,
  );
  const findingVerification = parseFindingVerification(
    await readStrictJsonFileV1(findingVerificationPath, {
      maxBytes: MAX_PERSISTED_REVIEW_JSON_BYTES_V1,
      source: "persisted finding verification",
    }),
    preliminary,
    brief,
  );
  if (
    JSON.stringify(preliminaryCandidate) !== JSON.stringify(preliminary) ||
    JSON.stringify(preliminaryPersisted?.preliminaryDigest) !==
      JSON.stringify(sha256Utf8(jsonDocument(preliminary))) ||
    JSON.stringify(findingVerificationPersisted?.verificationDigest) !==
      JSON.stringify(sha256Utf8(jsonDocument(findingVerification))) ||
    events.indexOf(findingVerificationPersisted) > events.indexOf(authorDelivered) ||
    (authorDelivered.type === "AUTHOR_CONTEXT_RELEASED"
      ? JSON.stringify(authorDelivered.authorContext) !==
        JSON.stringify(releasedAuthorContext.binding)
      : releasedAuthorContext.binding !== undefined ||
        JSON.stringify(authorDelivered.authorPacketDigest) !==
          JSON.stringify(sha256Utf8(JSON.stringify(releasedAuthorContext.authorPacket))))
  ) {
    throw new Error("The persisted preliminary or author-stage identity is invalid.");
  }

  const findingVerificationProvider = await readVerifiedFindingVerificationResponseV1(
    paths,
    config,
    brief,
    preliminary,
    findingVerification,
    findingVerificationSucceededCalls,
    findingVerificationPersisted,
  );

  await Promise.all([
    assertFileAbsent(finalProviderPath),
    assertFileAbsent(finalPath),
    assertFileAbsent(markdownPath),
    assertFileAbsent(reportMetadataPath),
  ]);

  // Identical inputs must produce the identical call shape, so a resume derives its messages,
  // constrained schemas and reservations from the same builder the original run used rather than
  // from a second copy of it. The budget assertions inside cannot newly fire: the config, brief
  // and plan were each proven above to match the run that already passed them.
  const {
    blindEvidence,
    blindMessages,
    authorMessage,
    preliminaryResponseSchema,
    finalConstrained,
    findingVerificationCallReservation,
    finalCallReservation,
  } = prepareReviewCalls(brief, releasedAuthorContext, config, plan, packet.contextMap);
  const finalMessages: ReviewMessageV1[] = [
    ...blindMessages,
    { role: "assistant", content: preliminaryProvider.rawContent },
    { role: "user", content: findingVerificationEnvelope(findingVerification) },
    { role: "user", content: authorMessage },
  ];
  const preliminaryInputReservations = replayPreliminaryInputReservationsV1(
    config,
    brief,
    events,
    startedCalls,
    acceptedAttemptNumber,
    blindMessages,
    preliminaryResponseSchema,
    preliminaryProviders,
  );
  const { inputTokens: findingVerificationInputTokens, callTokens: findingVerificationCallTokens } =
    replayFindingVerificationSpendV1(
      config,
      brief,
      preliminary,
      blindEvidence,
      startedCalls,
      findingVerificationSucceededCalls,
      findingVerificationProvider,
      findingVerificationCallReservation,
    );
  const { costLedger, firstCallTokens } = replayRunSpendV1(config, events, {
    preliminaryProviders,
    preliminaryInputReservations,
    findingVerificationProvider,
    findingVerificationInputTokens,
    findingVerificationCallTokens,
    finalCallReservation,
  });
  const failedFinalAttemptNumber = finalStarted.attemptNumber;
  const resumedAttemptNumber = failedFinalAttemptNumber + 1;

  await claimFinalResumeV1(
    paths,
    runRecord,
    expectedConfigDigest,
    failedFinalAttemptNumber,
    resumedAttemptNumber,
  );
  try {
    const candidateReport = await completeFinalStageV1(
      packetPath,
      reviewDirectory,
      runRecordPath,
      resumedAttemptNumber,
      config,
      provider,
      brief,
      preliminary,
      findingVerification,
      finalMessages,
      finalConstrained,
      finalCallReservation,
      firstCallTokens,
      releasedAuthorContext.claimedVerification,
      costLedger,
    );
    const report = bindReleasedAuthorContextV1(candidateReport, releasedAuthorContext);
    return await finishReviewV1(report, brief, paths);
  } catch (error) {
    return await recordRunFailureV1(runRecordPath, error);
  }
}

/** Legacy entry points reject standards packets; new callers use mode-aware functions. */
export async function runTwoStageReviewV1(
  packetPath: string,
  configValue: unknown,
  provider: ReviewProviderV1,
): Promise<TwoStageReviewResultV1> {
  const packet = await inspectSnapshotPacket(packetPath);
  if ("standards" in packet.canonicalInputs)
    throw new Error("Use runTwoStageReview for standards packets.");
  const result = await runTwoStageReview(packetPath, configValue, provider);
  return { ...result, report: result.report as FinalReviewReportV1 };
}
export async function resumeFinalReviewV1(
  packetPath: string,
  configValue: unknown,
  provider: ReviewProviderV1,
): Promise<TwoStageReviewResultV1> {
  const packet = await inspectSnapshotPacket(packetPath);
  if ("standards" in packet.canonicalInputs)
    throw new Error("Use resumeFinalReview for standards packets.");
  const result = await resumeFinalReview(packetPath, configValue, provider);
  return { ...result, report: result.report as FinalReviewReportV1 };
}
