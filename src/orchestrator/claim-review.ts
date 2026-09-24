import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  jsonDocument,
  permittedModelsV1,
  ReviewRunConfigV3Schema,
  sha256Utf8,
} from "../contracts/index.js";
import type { RunRecordEventPayloadV2 } from "../contracts/run-record-v2.js";
import { CLAIM_PROJECTION_POLICY_VERSION_V1 } from "../contracts/verified-report.js";
import { planReviewUnitsV1 } from "../planning/review-unit-planner.js";
import type { ReviewProviderV2 } from "../provider/review-provider.js";
import { inspectSnapshotPacket } from "../snapshot/snapshot-packet.js";
import { buildReviewBrief } from "../transmission/neutral-brief-builder.js";
import { writeClaimArtifactV1 } from "./claim-artifacts.js";
import { ClaimCallExecutorV1 } from "./claim-call-executor.js";
import { finishClaimReviewV1 } from "./claim-finish.js";
import {
  CLAIM_VERIFICATION_POLICY_VERSION_V1,
  FINAL_CLAIM_RESPONSE_SCHEMA_V4,
} from "./claim-policy.js";
import { prepareClaimReviewV1 } from "./claim-preparation.js";
import { completeClaimStagesV1 } from "./claim-stages.js";
import { emitReviewProgress } from "./progress.js";
import { normalizedError } from "./provider-failure.js";
import { assertFindingEvidenceAnchors, parsePreliminary } from "./response-validation.js";
import { releasedAuthorContextV1 } from "./review-input.js";
import { reviewOutputPathsV1 } from "./review-paths.js";
import {
  preliminarySchemaNameForBrief,
  promptVersionForBrief,
  REVIEW_UNIT_POLICY_VERSION_V1,
} from "./review-policy.js";
import { appendRunRecordEventV2 } from "./run-record-v2.js";

/** Admission-only counterpart uses the same four-stage recipe as execution. */
export async function preflightClaimReviewV2(
  packetPath: string,
  configValue: unknown,
  guidanceRepositoryPath?: string,
) {
  const config = ReviewRunConfigV3Schema.parse(configValue);
  const packet = await inspectSnapshotPacket(packetPath, {
    ...(guidanceRepositoryPath === undefined ? {} : { guidanceRepositoryPath }),
    requireGuidanceImportResolution: true,
  });
  if (packet.reviewConfigRef !== config.configId || packet.manifest.paths.length === 0)
    throw new Error("Review packet has no scope or mismatched configuration");
  const brief = await buildReviewBrief(
    packetPath,
    config.budgets.maxInitialEvidenceBytes,
    guidanceRepositoryPath,
  );
  const plan = planReviewUnitsV1(brief, packet.contextMap, {
    policyVersion: REVIEW_UNIT_POLICY_VERSION_V1,
    maxSupportingBytesPerUnit: config.budgets.maxInitialEvidenceBytes,
  });
  const prepared = prepareClaimReviewV1(
    brief,
    releasedAuthorContextV1(packet),
    config,
    plan,
    packet.contextMap,
  );
  return {
    reservedTokens: prepared.admission.requiredWithRetry,
    reservedCostUsd: prepared.admission.reservedCostUsd,
    model: config.model,
    fallbackModels: config.fallbackModels,
    preferredProviders: config.providerRouting.order ?? [],
    pinnedToPreferredProviders: config.providerRouting.pinToOrder,
    snapshotDigest: brief.snapshotManifest.snapshotDigest,
    guidanceAdmission: prepared.guidanceAdmission,
    ...(brief.schemaVersion === 3
      ? { guidanceGraphDigest: brief.guidanceGraph.guidanceGraphDigest }
      : {}),
  };
}

export async function runClaimReviewV2(
  packetPath: string,
  configValue: unknown,
  provider: ReviewProviderV2,
  guidanceRepositoryPath?: string,
) {
  const config = ReviewRunConfigV3Schema.parse(configValue);
  const packet = await inspectSnapshotPacket(packetPath, {
    ...(guidanceRepositoryPath === undefined ? {} : { guidanceRepositoryPath }),
    requireGuidanceImportResolution: true,
  });
  if (packet.manifest.paths.length === 0)
    throw new Error("The snapshot contains no changed paths to review.");
  if (packet.reviewConfigRef !== config.configId)
    throw new Error("Review config does not match the frozen packet reference.");
  const released = releasedAuthorContextV1(packet);
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
  await mkdir(paths.reviewDirectory, { mode: 0o700 });
  const persist = (name: string, value: unknown) =>
    writeClaimArtifactV1(join(paths.reviewDirectory, name), jsonDocument(value));
  const durable = async (event: RunRecordEventPayloadV2) => {
    emitReviewProgress(await appendRunRecordEventV2(paths.runRecordPath, event));
  };
  const preliminaryPromptVersion = `${promptVersionForBrief(brief)}/claim-preliminary-v1`;
  await persist("neutral-review-brief.json", brief);
  await persist("review-unit-plan.json", plan);
  await durable({
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
    promptVersion: preliminaryPromptVersion,
    preliminarySchema: preliminarySchemaNameForBrief(brief),
    finalSchema: FINAL_CLAIM_RESPONSE_SCHEMA_V4.name,
    findingVerificationSchema: "claim_verification_candidate_v1",
    findingVerificationPromptVersion: CLAIM_VERIFICATION_POLICY_VERSION_V1,
    claimProtocolVersion: "claim-review-v1",
    finalClaimVerificationSchema: "claim_verification_candidate_v1",
    finalClaimVerificationPromptVersion: CLAIM_VERIFICATION_POLICY_VERSION_V1,
    projectionPolicyVersion: CLAIM_PROJECTION_POLICY_VERSION_V1,
  });
  try {
    const prepared = prepareClaimReviewV1(brief, released, config, plan, packet.contextMap);
    if (prepared.guidanceAdmission)
      await durable({ type: "GUIDANCE_ADMISSION", ...prepared.guidanceAdmission });
    await persist("claim-admission.json", prepared.admission);
    const executor = new ClaimCallExecutorV1({
      directory: paths.reviewDirectory,
      config,
      provider,
      admission: prepared.admission,
      durable,
    });
    const initial = await executor.complete(
      {
        stage: "PRELIMINARY",
        models: permittedModelsV1(config),
        maxOutputTokens: config.budgets.maxOutputTokensPerCall,
        timeoutMs: config.budgets.timeoutMs,
        messages: prepared.calls.PRELIMINARY.messages,
        responseSchema: {
          name: preliminarySchemaNameForBrief(brief),
          schema: prepared.preliminaryConstrained.schema,
        },
      },
      preliminaryPromptVersion,
    );
    const preliminary = await parsePreliminary(initial.response.value, brief, packetPath);
    await persist("preliminary.json", preliminary);
    await durable({
      type: "PRELIMINARY_PERSISTED",
      preliminaryDigest: sha256Utf8(jsonDocument(preliminary)),
      acceptedAttemptNumber: initial.attemptNumber,
      responseArtifact: initial.responseArtifact,
    });
    const completed = await completeClaimStagesV1({
      brief,
      preliminary,
      blindEvidence: prepared.blindEvidence,
      authorEvidence: prepared.authorEvidence,
      authorRelease: released.binding
        ? { type: "AUTHOR_CONTEXT_RELEASED", authorContext: released.binding }
        : {
            type: "AUTHOR_DELIVERED",
            authorPacketDigest: sha256Utf8(JSON.stringify(released.authorPacket)),
          },
      config,
      fragmentLimits: prepared.admission.fragmentLimits,
      complete: (request, promptVersion) => executor.complete(request, promptVersion),
      persist,
      durable: async (event) => {
        if (event.type === "FINDING_VERIFICATION_PERSISTED" && !event.providerCall)
          executor.skip("FINDING_VERIFICATION");
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
    });
    return await finishClaimReviewV1({ brief, preliminary, released, completed, paths, durable });
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

export type ClaimReviewResultV2 = Awaited<ReturnType<typeof runClaimReviewV2>>;
