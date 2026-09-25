import { join } from "node:path";
import { canonicalizeJson, digestCanonicalJson } from "../contracts/canonical-json.js";
import {
  assembleClaimVerificationV1,
  assertClaimVerificationV1,
} from "../contracts/claim-verification.js";
import {
  assembleFinalClaimCandidateV4,
  type FinalClaimCandidateV4,
} from "../contracts/final-claim-candidate.js";
import {
  jsonDocument,
  permittedModelsV1,
  ReviewRunConfigV3Schema,
  sha256Utf8,
} from "../contracts/index.js";
import { assembleReviewClaimSetV1, ReviewClaimSetV1Schema } from "../contracts/review-claims.js";
import type { RunRecordEventPayloadV2, RunRecordEventV2 } from "../contracts/run-record-v2.js";
import { readStrictJsonFileV1 } from "../contracts/strict-json.js";
import { CLAIM_PROJECTION_POLICY_VERSION_V1 } from "../contracts/verified-report.js";
import { planReviewUnitsV1 } from "../planning/review-unit-planner.js";
import {
  ProviderCallError,
  type ReviewProviderRequestV2,
  type ReviewProviderResponseV1,
  type ReviewProviderV2,
} from "../provider/review-provider.js";
import { planClaimTransitionsV1 } from "../report/claim-projection.js";
import { inspectSnapshotPacket } from "../snapshot/snapshot-packet.js";
import { buildReviewBrief } from "../transmission/neutral-brief-builder.js";
import {
  callCostUsd,
  chargedTokens,
  conservativeInputTokenUpperBound,
  priceCeilingCostUsd,
} from "./call-accounting.js";
import { reviewClaimSetV1 } from "./claim-adapter.js";
import { writeClaimArtifactV1 } from "./claim-artifacts.js";
import { ClaimCallExecutorV1, type ClaimCallStateV1 } from "./claim-call-executor.js";
import { finishClaimReviewV1 } from "./claim-finish.js";
import {
  CLAIM_VERIFICATION_POLICY_VERSION_V1,
  claimVerificationMessagesV1,
  claimVerificationResponseSchemaV1,
  FINAL_CLAIM_POLICY_VERSION_V4,
  FINAL_CLAIM_RESPONSE_SCHEMA_V4,
  finalClaimMessagesV4,
} from "./claim-policy.js";
import { prepareClaimReviewV1 } from "./claim-preparation.js";
import { evaluateClaimResumeV1 } from "./claim-resume-eligibility.js";
import { continueClaimStagesV1 } from "./claim-stages.js";
import { emitReviewProgress } from "./progress.js";
import {
  failedAttemptChargeV1,
  isZeroChargeFailureV1,
  normalizedError,
} from "./provider-failure.js";
import { assertFindingEvidenceAnchors, parsePreliminary } from "./response-validation.js";
import { releasedAuthorContextV1 } from "./review-input.js";
import { reviewOutputPathsV1 } from "./review-paths.js";
import {
  preliminarySchemaNameForBrief,
  promptVersionForBrief,
  REVIEW_UNIT_POLICY_VERSION_V1,
} from "./review-policy.js";
import { recoverRunRecordTailV1 } from "./run-record.js";
import { appendRunRecordEventV2, readRunRecordEventsV2 } from "./run-record-v2.js";

const READ_LIMITS = { maxTotalBytes: 64 * 1024 * 1024, maxLineBytes: 8 * 1024 * 1024 };
function assertSame(left: unknown, right: unknown, label: string): void {
  if (canonicalizeJson(left) !== canonicalizeJson(right))
    throw new Error(`Claim resume ${label} mismatch`);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed retained claim artifact");
  return value as Record<string, unknown>;
}

/** Resume never reinterprets a V1 run or spends before revalidating frozen protocol inputs. */
export async function resumeClaimReviewV2(
  packetPath: string,
  configValue: unknown,
  provider: ReviewProviderV2,
  guidanceRepositoryPath?: string,
) {
  const paths = reviewOutputPathsV1(packetPath);
  const ledger = await readRunRecordEventsV2(paths.runRecordPath, READ_LIMITS);
  const { events } = ledger;
  const eligibility = evaluateClaimResumeV1(events);
  if (!eligibility.eligible || eligibility.stage === null)
    throw new Error(`Claim resume refused: ${eligibility.refusals.join("; ")}`);
  const checkpoint = <T extends RunRecordEventV2["type"]>(type: T) =>
    events.find((event) => event.type === type) as
      | Extract<RunRecordEventV2, { type: T }>
      | undefined;
  const started = checkpoint("RUN_STARTED");
  const preliminaryEvent = checkpoint("PRELIMINARY_PERSISTED");
  const priorEvent = checkpoint("PRELIMINARY_CLAIMS_PERSISTED");
  const blindEvent = checkpoint("FINDING_VERIFICATION_PERSISTED");
  if (!started || !preliminaryEvent || !priorEvent || !blindEvent)
    throw new Error("Missing claim resume checkpoint");
  const config = ReviewRunConfigV3Schema.parse(configValue);
  assertSame(started.configDigest, sha256Utf8(JSON.stringify(config)), "configuration");
  const packet = await inspectSnapshotPacket(packetPath, {
    ...(guidanceRepositoryPath === undefined ? {} : { guidanceRepositoryPath }),
    requireGuidanceImportResolution: true,
  });
  if (packet.reviewConfigRef !== config.configId)
    throw new Error("Claim resume packet configuration mismatch");
  const brief = await buildReviewBrief(
    packetPath,
    config.budgets.maxInitialEvidenceBytes,
    guidanceRepositoryPath,
  );
  const unitPlan = planReviewUnitsV1(brief, packet.contextMap, {
    policyVersion: REVIEW_UNIT_POLICY_VERSION_V1,
    maxSupportingBytesPerUnit: config.budgets.maxInitialEvidenceBytes,
  });
  const released = releasedAuthorContextV1(packet);
  const read = (name: string) =>
    readStrictJsonFileV1(join(paths.reviewDirectory, name), {
      maxBytes: 64 * 1024 * 1024,
      source: `claim resume ${name}`,
    });
  assertSame(await read("neutral-review-brief.json"), brief, "brief artifact");
  assertSame(await read("review-unit-plan.json"), unitPlan, "review plan artifact");
  assertSame(started.snapshotDigest, brief.snapshotManifest.snapshotDigest, "snapshot");
  assertSame(started.briefDigest, brief.briefDigest, "brief");
  assertSame(started.contextMapDigest, packet.contextMap.contextMapDigest, "context map");
  assertSame(started.planDigest, unitPlan.planDigest, "plan");
  assertSame(
    started.guidanceGraphDigest ?? null,
    brief.schemaVersion === 3 ? brief.guidanceGraph.guidanceGraphDigest : null,
    "guidance graph",
  );
  assertSame(started.requestedModels, permittedModelsV1(config), "permitted models");
  const preliminaryPromptVersion = `${promptVersionForBrief(brief)}/claim-preliminary-v1`;
  assertSame(
    [
      started.claimProtocolVersion,
      started.promptVersion,
      started.preliminarySchema,
      started.finalSchema,
      started.findingVerificationSchema,
      started.findingVerificationPromptVersion,
      started.finalClaimVerificationSchema,
      started.finalClaimVerificationPromptVersion,
      started.projectionPolicyVersion,
    ],
    [
      "claim-review-v1",
      preliminaryPromptVersion,
      preliminarySchemaNameForBrief(brief),
      FINAL_CLAIM_RESPONSE_SCHEMA_V4.name,
      "claim_verification_candidate_v1",
      CLAIM_VERIFICATION_POLICY_VERSION_V1,
      "claim_verification_candidate_v1",
      CLAIM_VERIFICATION_POLICY_VERSION_V1,
      CLAIM_PROJECTION_POLICY_VERSION_V1,
    ],
    "protocol generation",
  );
  const authorEvent = checkpoint("AUTHOR_CONTEXT_RELEASED") ?? checkpoint("AUTHOR_DELIVERED");
  if (released.binding) {
    if (authorEvent?.type !== "AUTHOR_CONTEXT_RELEASED")
      throw new Error("Claim resume author release mismatch");
    assertSame(authorEvent.authorContext, released.binding, "author context");
  } else {
    if (authorEvent?.type !== "AUTHOR_DELIVERED")
      throw new Error("Claim resume author release mismatch");
    assertSame(
      authorEvent.authorPacketDigest,
      sha256Utf8(JSON.stringify(released.authorPacket)),
      "author packet",
    );
  }
  const prepared = prepareClaimReviewV1(brief, released, config, unitPlan, packet.contextMap);
  assertSame(await read("claim-admission.json"), prepared.admission, "admission policy");
  const preliminaryValue = await read("preliminary.json");
  const preliminary = await parsePreliminary(preliminaryValue, brief, packetPath);
  assertSame(
    preliminaryEvent.preliminaryDigest,
    sha256Utf8(jsonDocument(preliminary)),
    "preliminary checkpoint",
  );
  const prior = ReviewClaimSetV1Schema.parse(await read("preliminary-claims.json"));
  assertSame(prior, reviewClaimSetV1(brief, preliminary).set, "preliminary claims");
  assertSame(priorEvent.claimSetDigest, digestCanonicalJson(prior), "prior claims checkpoint");
  const empty = assembleReviewClaimSetV1(
    { snapshotDigest: prior.snapshotDigest, briefDigest: prior.briefDigest },
    [],
  );
  const priorVerification = assertClaimVerificationV1(
    await read("finding-verification.json"),
    prior,
    empty,
  );
  if (priorVerification.stage !== "FINDING_VERIFICATION")
    throw new Error("Claim resume prior judgment is not blind");
  assertSame(
    blindEvent.verificationDigest,
    digestCanonicalJson(priorVerification),
    "blind verification checkpoint",
  );
  if (blindEvent.providerCall !== prior.claims.length > 0)
    throw new Error("Blind verification skip does not match its targets");

  const candidateEvent = checkpoint("FINAL_CANDIDATE_PERSISTED");
  const candidate: FinalClaimCandidateV4 | undefined = candidateEvent
    ? assembleFinalClaimCandidateV4(prior, await read("final-candidate.json"))
    : undefined;
  const transitionPlan = candidate
    ? planClaimTransitionsV1(prior, priorVerification, {
        continuedClaimIds: candidate.continuedClaimIds,
        withdrawnClaimIds: candidate.withdrawnClaimIds,
        newClaims: candidate.newClaims,
      })
    : undefined;
  if (candidateEvent && candidate && transitionPlan) {
    assertSame(
      candidateEvent.candidateDigest,
      digestCanonicalJson(candidate),
      "candidate checkpoint",
    );
    assertSame(
      candidateEvent.transitionDigest,
      digestCanonicalJson(transitionPlan),
      "transition checkpoint",
    );
    assertSame(
      candidateEvent.targetSetDigest,
      digestCanonicalJson(transitionPlan.targets),
      "target checkpoint",
    );
    assertSame(
      candidateEvent.catalogSetDigest,
      digestCanonicalJson(transitionPlan.catalog),
      "catalog checkpoint",
    );
    assertSame(await read("claim-transitions.json"), transitionPlan, "transition artifact");
    assertSame(await read("final-claim-targets.json"), transitionPlan.targets, "target artifact");
    assertSame(
      await read("carried-claim-catalog.json"),
      transitionPlan.catalog,
      "catalog artifact",
    );
  }
  const verificationEvent = checkpoint("FINAL_CLAIM_VERIFICATION_PERSISTED");
  const finalVerification =
    verificationEvent && transitionPlan
      ? assertClaimVerificationV1(
          await read("final-claim-verification.json"),
          transitionPlan.targets,
          transitionPlan.catalog,
        )
      : undefined;
  if (verificationEvent && finalVerification && transitionPlan) {
    assertSame(
      verificationEvent.verificationDigest,
      digestCanonicalJson(finalVerification),
      "final verification checkpoint",
    );
    if (verificationEvent.providerCall !== transitionPlan.targets.claims.length > 0)
      throw new Error("Final verification skip does not match its targets");
  }
  function requestFor(stage: ReviewProviderRequestV2["stage"]): ReviewProviderRequestV2 {
    const common = {
      stage,
      models: permittedModelsV1(config),
      maxOutputTokens: config.budgets.maxOutputTokensPerCall,
      timeoutMs: config.budgets.timeoutMs,
    };
    if (stage === "PRELIMINARY")
      return {
        ...common,
        messages: prepared.calls.PRELIMINARY.messages,
        responseSchema: {
          name: preliminarySchemaNameForBrief(brief),
          schema: prepared.preliminaryConstrained.schema,
        },
      };
    if (stage === "FINDING_VERIFICATION")
      return {
        ...common,
        messages: claimVerificationMessagesV1(stage, prepared.blindEvidence, prior, empty),
        responseSchema: claimVerificationResponseSchemaV1(stage, prior.claims.length),
      };
    if (stage === "FINAL")
      return {
        ...common,
        messages: finalClaimMessagesV4(
          prepared.blindEvidence,
          prior,
          priorVerification,
          prepared.authorEvidence,
        ),
        responseSchema: FINAL_CLAIM_RESPONSE_SCHEMA_V4,
      };
    if (!transitionPlan) throw new Error("Post-author request has no persisted transition scope");
    return {
      ...common,
      messages: claimVerificationMessagesV1(
        stage,
        prepared.blindEvidence,
        transitionPlan.targets,
        transitionPlan.catalog,
        prepared.authorEvidence,
      ),
      responseSchema: claimVerificationResponseSchemaV1(
        stage,
        transitionPlan.targets.claims.length,
      ),
    };
  }
  const state: ClaimCallStateV1 = {
    nextAttempt: eligibility.nextAttemptNumber,
    spentTokens: 0,
    spentUsd: 0,
    retriesUsed: events.filter((event) => event.type === "PROVIDER_RETRY_REQUESTED").length,
    completedStages: ["PRELIMINARY", "FINDING_VERIFICATION"],
  };
  if (candidate) state.completedStages.push("FINAL");
  if (finalVerification) state.completedStages.push("FINAL_CLAIM_VERIFICATION");
  if (state.retriesUsed > 1) throw new Error("Claim resume exceeds its run-wide retry policy");
  const successfulResponses = new Map<number, ReviewProviderResponseV1>();
  for (const event of events) {
    if (event.type !== "CALL_STARTED") continue;
    const expected = requestFor(event.stage);
    const retained = object(await read(`claim-request-attempt-${event.attemptNumber}.json`));
    assertSame(retained.request, expected, "request artifact");
    assertSame(event.inputDigest, sha256Utf8(JSON.stringify(expected)), "request identity");
    const audit = object(retained.audit);
    assertSame(
      [
        audit.providerPolicyVersion,
        audit.wireBodyDigest,
        audit.wireBodyBytes,
        audit.credentialFreeWireRequestDigest,
        audit.preferredProviderEndpoints ?? null,
        audit.excludedProviderEndpoints ?? null,
      ],
      [
        event.providerPolicyVersion,
        event.wireBodyDigest,
        event.wireBodyBytes,
        event.credentialFreeWireRequestDigest,
        event.preferredProviderEndpoints,
        event.excludedProviderEndpoints,
      ],
      "wire audit artifact",
    );
    if (provider.auditRequest(expected).providerPolicyVersion !== event.providerPolicyVersion)
      throw new Error("Claim resume provider policy mismatch");
    const prompt =
      event.stage === "PRELIMINARY"
        ? preliminaryPromptVersion
        : event.stage === "FINAL"
          ? FINAL_CLAIM_POLICY_VERSION_V4
          : CLAIM_VERIFICATION_POLICY_VERSION_V1;
    if (event.promptVersion !== prompt || event.responseSchemaName !== expected.responseSchema.name)
      throw new Error("Claim resume request protocol mismatch");
    const result = events.find(
      (item) =>
        (item.type === "CALL_SUCCEEDED" || item.type === "CALL_FAILED") &&
        item.attemptNumber === event.attemptNumber,
    );
    const inputTokens = conservativeInputTokenUpperBound(
      expected.messages,
      expected.responseSchema.schema,
    );
    if (result?.type === "CALL_SUCCEEDED") {
      const response = (await read(
        `claim-provider-response-attempt-${event.attemptNumber}.json`,
      )) as ReviewProviderResponseV1;
      if (!result.responseDigest) throw new Error("Claim resume lacks a response digest");
      assertSame(result.responseDigest, digestCanonicalJson(response), "provider response");
      assertSame(
        [response.usage, response.model, response.provider, response.responseId],
        [result.usage, result.returnedModel, result.returnedProvider, result.responseId],
        "provider response accounting",
      );
      state.spentTokens += chargedTokens(response) ?? inputTokens + expected.maxOutputTokens;
      state.spentUsd += callCostUsd(response, config, inputTokens);
      successfulResponses.set(event.attemptNumber, response);
    } else if (result?.type === "CALL_FAILED") {
      const code = result.error.code;
      if (code === "TRANSPORT_UNCERTAIN")
        throw new Error("Claim resume cannot reuse uncertain transport history");
      const error = new ProviderCallError(
        code === "TRANSPORT_UNSENT" ? code : code === "PROVIDER_ERROR" ? code : "INVALID_RESPONSE",
        result.error.message,
        { ...(result.responseMetadata ? { responseMetadata: result.responseMetadata } : {}) },
      );
      const charge = failedAttemptChargeV1(error, inputTokens, expected.maxOutputTokens);
      state.spentTokens += charge.tokens;
      state.spentUsd +=
        result.responseMetadata?.usage.cost ??
        (isZeroChargeFailureV1(code)
          ? 0
          : priceCeilingCostUsd(charge.promptTokens, charge.completionTokens, config));
    }
  }
  const preliminaryResponse = successfulResponses.get(preliminaryEvent.acceptedAttemptNumber);
  if (
    !preliminaryResponse ||
    preliminaryEvent.responseArtifact !==
      `claim-provider-response-attempt-${preliminaryEvent.acceptedAttemptNumber}.json`
  )
    throw new Error("Claim resume preliminary response provenance mismatch");
  assertSame(
    await parsePreliminary(preliminaryResponse.value, brief, packetPath),
    preliminary,
    "preliminary response",
  );
  if (blindEvent.providerCall) {
    const response = successfulResponses.get(blindEvent.acceptedAttemptNumber ?? -1);
    if (!response) throw new Error("Missing accepted blind response");
    assertSame(
      assembleClaimVerificationV1(prior, empty, response.value),
      priorVerification,
      "blind response judgment",
    );
  }
  if (candidate) {
    const response = successfulResponses.get(candidateEvent?.acceptedAttemptNumber ?? -1);
    if (!response) throw new Error("Missing accepted final candidate response");
    assertSame(
      assembleFinalClaimCandidateV4(prior, response.value),
      candidate,
      "final response candidate",
    );
  }
  if (verificationEvent?.providerCall && transitionPlan && finalVerification) {
    const response = successfulResponses.get(verificationEvent.acceptedAttemptNumber ?? -1);
    if (!response) throw new Error("Missing accepted final verification response");
    assertSame(
      assembleClaimVerificationV1(transitionPlan.targets, transitionPlan.catalog, response.value),
      finalVerification,
      "final response judgment",
    );
  }
  const durable = async (event: RunRecordEventPayloadV2) => {
    emitReviewProgress(await appendRunRecordEventV2(paths.runRecordPath, event));
  };
  const executor = new ClaimCallExecutorV1({
    directory: paths.reviewDirectory,
    config,
    provider,
    admission: prepared.admission,
    durable,
    state,
  });
  await writeClaimArtifactV1(
    join(paths.reviewDirectory, `claim-resume-${eligibility.nextAttemptNumber}.json`),
    jsonDocument({ stage: eligibility.stage, nextAttemptNumber: eligibility.nextAttemptNumber }),
  );
  const confirmed = await readRunRecordEventsV2(paths.runRecordPath, READ_LIMITS);
  assertSame(confirmed, ledger, "run record changed before resume");
  if (ledger.tailBytes > 0) {
    await recoverRunRecordTailV1(paths.runRecordPath, ledger);
    await durable({ type: "RUN_RECORD_TAIL_RECOVERED", discardedBytes: ledger.tailBytes });
  }
  await durable({
    type: "RUN_RESUMED",
    stage: eligibility.stage,
    failedAttemptNumber: eligibility.nextAttemptNumber - 1,
    nextAttemptNumber: eligibility.nextAttemptNumber,
  });
  try {
    if (!authorEvent) throw new Error("Missing author release");
    const completed = await continueClaimStagesV1(
      {
        brief,
        preliminary,
        blindEvidence: prepared.blindEvidence,
        authorEvidence: prepared.authorEvidence,
        authorRelease: authorEvent,
        config,
        fragmentLimits: prepared.admission.fragmentLimits,
        complete: (request, promptVersion) => executor.complete(request, promptVersion),
        persist: (name, value) =>
          writeClaimArtifactV1(join(paths.reviewDirectory, name), jsonDocument(value)),
        durable: async (event) => {
          if (event.type === "FINAL_CLAIM_VERIFICATION_PERSISTED" && !event.providerCall)
            executor.skip("FINAL_CLAIM_VERIFICATION");
          await durable(event);
        },
        validateEvidence: (claims) =>
          assertFindingEvidenceAnchors(
            claims.claims.map(({ core }) => ({
              evidence: core.evidence.map((anchor) => ({ ...anchor, detail: core.assertion })),
            })),
            brief,
            packetPath,
          ),
      },
      prior,
      priorVerification,
      candidate ? { candidate, ...(finalVerification ? { finalVerification } : {}) } : undefined,
    );
    const reportEvent = checkpoint("FINAL_REPORT_PERSISTED");
    return await finishClaimReviewV1({
      brief,
      preliminary,
      released,
      completed,
      paths,
      durable,
      resume: true,
      ...(reportEvent ? { reportCheckpoint: reportEvent.reportDigest } : {}),
    });
  } catch (error) {
    const normalized = normalizedError(error);
    await durable({
      type: "RUN_FAILED",
      terminalState: normalized.code === "TRANSPORT_UNCERTAIN" ? "TRANSPORT_UNCERTAIN" : "FAILED",
      error: normalized,
    });
    throw error;
  }
}
