import { digestCanonicalJson } from "../src/contracts/canonical-json.js";
import {
  assertClaimVerificationV1,
  type ClaimVerificationV1,
} from "../src/contracts/claim-verification.js";
import { jsonDocument, sha256BytesDigestV1 } from "../src/contracts/json-document.js";
import {
  assembleReviewClaimSetV1,
  type ReviewClaimCoreV1,
  type ReviewClaimSetV1,
  ReviewClaimSetV1Schema,
} from "../src/contracts/review-claims.js";
import { type RunRecordEventV2, RunRecordEventV2Schema } from "../src/contracts/run-record-v2.js";
import type { VerifiedReviewReport } from "../src/contracts/verified-report.js";
import {
  digestEvaluationArtifactV1,
  type EvaluationAttemptRecordV1,
  EvaluationAttemptRecordV1Schema,
  type EvaluationCaseManifestV1,
  EvaluationEngineIdentityV1Schema,
  type EvaluationExperimentManifestV1,
  EvaluationExperimentManifestV1Schema,
  EvaluationSourceIdentityV1Schema,
} from "./artifact-contracts.js";

export interface RuntimeEvaluationAttemptInputV1 {
  experiment: EvaluationExperimentManifestV1;
  caseManifest: EvaluationCaseManifestV1;
  split: "DEVELOPMENT" | "HOLDOUT";
  events: RunRecordEventV2[];
  report: VerifiedReviewReport | null;
  prior: ReviewClaimSetV1 | null;
  blind: ClaimVerificationV1 | null;
  startedAt: string;
  completedAt: string;
  runtimeReference: string;
  admittedCeilingUsd: number;
  evidenceBytes: number;
  outputBytes: number;
}
const dollars = (value: number) => Number(value.toFixed(12));
const artifactDigest = (value: unknown) => sha256BytesDigestV1(Buffer.from(jsonDocument(value)));
const claimKind = (core: ReviewClaimCoreV1) =>
  core.kind !== "VIOLATION"
    ? ("UNCERTAINTY" as const)
    : core.effect.kind === "STANDARDS" && core.effect.enforcement === "RECOMMENDED"
      ? ("RECOMMENDATION" as const)
      : ("DEFECT" as const);

/** Evaluation FINAL is the delivered outcome: reconciliation, selective verification and projection. */
export function buildRuntimeEvaluationAttemptV1(
  input: RuntimeEvaluationAttemptInputV1,
): EvaluationAttemptRecordV1 {
  const events = input.events.map((event) => RunRecordEventV2Schema.parse(event));
  const outcomes = events.filter(
    (event) => event.type === "CALL_SUCCEEDED" || event.type === "CALL_FAILED",
  );
  const starts = events.filter((event) => event.type === "CALL_STARTED");
  const usage = outcomes.map((event) =>
    event.type === "CALL_SUCCEEDED" ? event.usage : event.responseMetadata?.usage,
  );
  const known = usage.filter((value) => value?.cost !== null && value?.cost !== undefined);
  const allTokens =
    usage.length === starts.length &&
    usage.every(
      (value) =>
        value &&
        value.promptTokens !== null &&
        value.completionTokens !== null &&
        value.totalTokens !== null,
    );
  const findingClaims: EvaluationAttemptRecordV1["findingClaims"] = [];
  const stageOutcomes: EvaluationAttemptRecordV1["stageOutcomes"] = [];
  const prior = input.prior === null ? null : ReviewClaimSetV1Schema.parse(input.prior);
  const logicalStage = (stage: string) => (stage === "FINAL_CLAIM_VERIFICATION" ? "FINAL" : stage);
  const elapsed = (stage: string) =>
    outcomes
      .filter((event) => logicalStage(event.stage) === stage)
      .reduce((sum, event) => sum + event.durationMs, 0);
  const addClaims = (stage: "PRELIMINARY" | "FINDING_VERIFICATION", selected: typeof prior) => {
    for (const claim of selected?.claims ?? [])
      findingClaims.push({
        findingReference: `${input.runtimeReference}#${stage}/${claim.claimId}`,
        claimDigest: digestCanonicalJson(claim.core),
        emittedAtStage: stage,
        claimKind: claimKind(claim.core),
      });
  };
  if (prior) {
    const checkpoint = events.find((event) => event.type === "PRELIMINARY_CLAIMS_PERSISTED");
    if (!checkpoint || checkpoint.claimSetDigest.value !== digestCanonicalJson(prior).value)
      throw new Error("Evaluation preliminary claim checkpoint mismatch");
    stageOutcomes.push({
      stage: "PRELIMINARY",
      state: "SUCCEEDED",
      artifactDigest: artifactDigest(prior),
      elapsedMs: elapsed("PRELIMINARY"),
      providerCall: true,
    });
    addClaims("PRELIMINARY", prior);
    if (input.blind) {
      const blind = assertClaimVerificationV1(
        input.blind,
        prior,
        assembleReviewClaimSetV1(
          { snapshotDigest: prior.snapshotDigest, briefDigest: prior.briefDigest },
          [],
        ),
      );
      const checkpoint = events.find((event) => event.type === "FINDING_VERIFICATION_PERSISTED");
      if (!checkpoint || checkpoint.verificationDigest.value !== digestCanonicalJson(blind).value)
        throw new Error("Evaluation blind checkpoint mismatch");
      stageOutcomes.push({
        stage: "FINDING_VERIFICATION",
        state: "SUCCEEDED",
        artifactDigest: artifactDigest(blind),
        elapsedMs: elapsed("FINDING_VERIFICATION"),
        providerCall: checkpoint.providerCall,
      });
      const eligible = new Set(
        blind.assessments.filter((item) => item.status !== "REJECTED").map((item) => item.claimId),
      );
      addClaims("FINDING_VERIFICATION", {
        ...prior,
        claims: prior.claims.filter((item) => eligible.has(item.claimId)),
      });
    }
  }
  let terminalOutcome: EvaluationAttemptRecordV1["terminalOutcome"];
  if (input.report) {
    const final = events.find((event) => event.type === "FINAL_REPORT_PERSISTED");
    const completed = events.at(-1);
    if (
      !final ||
      final.reportDigest.value !== digestCanonicalJson(input.report).value ||
      completed?.type !== "RUN_COMPLETED" ||
      completed.terminalState !== input.report.verdict
    )
      throw new Error("Evaluation delivered report checkpoint mismatch");
    const reportDigest = artifactDigest(input.report);
    stageOutcomes.push({
      stage: "FINAL",
      state: "SUCCEEDED",
      artifactDigest: reportDigest,
      elapsedMs: elapsed("FINAL"),
      providerCall: true,
    });
    for (const finding of input.report.findings)
      findingClaims.push({
        findingReference: `${input.runtimeReference}/final.json#${finding.id}`,
        claimDigest: digestCanonicalJson(finding),
        emittedAtStage: "FINAL",
        claimKind:
          "enforcement" in finding && finding.enforcement === "RECOMMENDED"
            ? "RECOMMENDATION"
            : "DEFECT",
      });
    for (const uncertainty of input.report.uncertainties)
      findingClaims.push({
        findingReference: `${input.runtimeReference}/final.json#${uncertainty.claimId}`,
        claimDigest: digestCanonicalJson(uncertainty),
        emittedAtStage: "FINAL",
        claimKind: "UNCERTAINTY",
      });
    terminalOutcome =
      input.report.verdict === "UNABLE_TO_VERIFY"
        ? {
            kind: "SEMANTIC_ABSTENTION",
            reportReference: `${input.runtimeReference}/final.json`,
            reportDigest,
            reason: input.report.summary,
          }
        : {
            kind: "DELIVERED",
            reportReference: `${input.runtimeReference}/final.json`,
            reportDigest,
            verdict: input.report.verdict,
          };
  } else {
    const stage = (["PRELIMINARY", "FINDING_VERIFICATION", "FINAL"] as const)[stageOutcomes.length];
    const last = outcomes.at(-1);
    if (!stage) throw new Error("Missing report after complete evaluation stages");
    const providerCall = starts.some((event) => logicalStage(event.stage) === stage);
    if (stageOutcomes.length || providerCall)
      stageOutcomes.push({
        stage,
        state: "FAILED",
        artifactDigest: null,
        elapsedMs: elapsed(stage),
        providerCall,
      });
    const runFailed = events.find((event) => event.type === "RUN_FAILED");
    if (last?.type === "CALL_FAILED" && logicalStage(last.stage) === stage) {
      if (!runFailed || runFailed.error.code !== last.error.code)
        throw new Error("Evaluation terminal failure checkpoint mismatch");
    }
    terminalOutcome =
      last?.type === "CALL_FAILED" && logicalStage(last.stage) === stage && runFailed
        ? {
            kind: "PROVIDER_FAILURE",
            stage,
            failureCode: last.error.code ?? last.error.name,
            transportUncertain: runFailed.terminalState === "TRANSPORT_UNCERTAIN",
          }
        : {
            kind: "RUNNER_FAILURE",
            stage: stageOutcomes.length ? stage : "PREPARATION",
            failureCode: "RUNTIME_INCOMPLETE",
          };
  }
  const variant = input.experiment.variants[0];
  if (!variant || input.experiment.variants.length !== 1)
    throw new Error("Runtime adapter requires a single frozen variant");
  return EvaluationAttemptRecordV1Schema.parse({
    schemaVersion: 1,
    attemptId: `attempt_${input.caseManifest.caseId}_1`,
    experimentId: input.experiment.experimentId,
    experimentManifestDigest: digestEvaluationArtifactV1(
      EvaluationExperimentManifestV1Schema,
      input.experiment,
    ),
    caseId: input.caseManifest.caseId,
    familyId: input.caseManifest.familyId,
    split: input.split,
    variantId: variant.variantId,
    repetition: 1,
    sourceIdentityDigest: digestEvaluationArtifactV1(
      EvaluationSourceIdentityV1Schema,
      input.caseManifest.source,
    ),
    engineIdentityDigest: digestEvaluationArtifactV1(
      EvaluationEngineIdentityV1Schema,
      input.experiment.engine,
    ),
    runtimeRunReference: input.runtimeReference,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    elapsedMs: Date.parse(input.completedAt) - Date.parse(input.startedAt),
    stageOutcomes,
    findingClaims,
    terminalOutcome,
    usage: {
      promptTokens: allTokens
        ? usage.reduce((sum, value) => sum + (value?.promptTokens ?? 0), 0)
        : null,
      completionTokens: allTokens
        ? usage.reduce((sum, value) => sum + (value?.completionTokens ?? 0), 0)
        : null,
      totalTokens: allTokens
        ? usage.reduce((sum, value) => sum + (value?.totalTokens ?? 0), 0)
        : null,
      knownCostUsd: known.length
        ? dollars(known.reduce((sum, value) => sum + (value?.cost ?? 0), 0))
        : null,
      providerAttempts: starts.length,
      knownCostAttempts: known.length,
      unknownCostAttempts: starts.length - known.length,
      conservativeChargeUsd: input.admittedCeilingUsd,
      admittedCeilingUsd: input.admittedCeilingUsd,
      evidenceBytes: input.evidenceBytes,
      outputBytes: input.outputBytes,
    },
  });
}
