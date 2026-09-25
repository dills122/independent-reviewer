import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EvaluationAttemptRecordV1Schema,
  EvaluationCaseManifestV1Schema,
  EvaluationExperimentManifestV1Schema,
} from "../../evaluation/artifact-contracts.js";
import { buildRuntimeEvaluationAttemptV1 } from "../../evaluation/runtime-attempt.js";
import { digestCanonicalJson } from "../../src/contracts/canonical-json.js";
import { ClaimVerificationV1Schema } from "../../src/contracts/claim-verification.js";
import { ReviewClaimSetV1Schema } from "../../src/contracts/review-claims.js";
import {
  type RunRecordEventV2,
  RunRecordEventV2Schema,
} from "../../src/contracts/run-record-v2.js";
import { makeEvaluationGraph } from "./artifact-fixtures.js";

const digest = { algorithm: "SHA256", value: "a".repeat(64) };
const error = { name: "ProviderCallError", code: "PROVIDER_ERROR", message: "rate limited" };
function event(fields: Record<string, unknown>): RunRecordEventV2 {
  return RunRecordEventV2Schema.parse({
    schemaVersion: 2,
    at: "2026-09-22T00:00:00.000Z",
    ...fields,
  });
}
function started(stage: string, attemptNumber: number): RunRecordEventV2 {
  return event({
    type: "CALL_STARTED",
    stage,
    attemptNumber,
    inputDigest: digest,
    providerPolicyVersion: "test-policy",
    preferredProviderEndpoints: null,
    excludedProviderEndpoints: null,
    wireBodyDigest: digest,
    wireBodyBytes: 10,
    credentialFreeWireRequestDigest: digest,
    requestedModels: ["test/model"],
    promptVersion: "test-prompt",
    responseSchemaName: "test_schema",
    responseArrayLimits: {},
    maxOutputTokens: 100,
    timeoutMs: 1000,
  });
}
function succeeded(stage: string, attemptNumber: number): RunRecordEventV2 {
  return event({
    type: "CALL_SUCCEEDED",
    stage,
    attemptNumber,
    durationMs: 1,
    responseId: null,
    returnedModel: null,
    returnedProvider: null,
    usage: { promptTokens: null, completionTokens: null, totalTokens: null, cost: null },
  });
}
function failed(stage: string, attemptNumber: number): RunRecordEventV2 {
  return event({ type: "CALL_FAILED", stage, attemptNumber, durationMs: 1, error });
}

function fixture() {
  const graph = makeEvaluationGraph();
  const caseManifest = EvaluationCaseManifestV1Schema.parse(graph.cases[1]);
  const prior = ReviewClaimSetV1Schema.parse({
    schemaVersion: 1,
    snapshotDigest: digest,
    briefDigest: digest,
    claims: [],
  });
  const priorDigest = digestCanonicalJson(prior);
  const blind = ClaimVerificationV1Schema.parse({
    schemaVersion: 1,
    stage: "FINDING_VERIFICATION",
    snapshotDigest: digest,
    briefDigest: digest,
    targetSetDigest: priorDigest,
    catalogSetDigest: priorDigest,
    assessments: [],
  });
  const events = [
    event({
      type: "RUN_STARTED",
      snapshotDigest: digest,
      briefDigest: digest,
      contextMapDigest: digest,
      planDigest: digest,
      configId: "config_test",
      configDigest: digest,
      requestedModels: ["test/model"],
      promptVersion: "test-prompt",
      preliminarySchema: "preliminary_test",
      finalSchema: "final_test",
      findingVerificationSchema: "finding_test",
      findingVerificationPromptVersion: "finding-test",
      claimProtocolVersion: "claim-review-v1",
      finalClaimVerificationSchema: "final_claim_test",
      finalClaimVerificationPromptVersion: "final-claim-test",
      projectionPolicyVersion: "claim-projection-v1",
    }),
    started("PRELIMINARY", 1),
    succeeded("PRELIMINARY", 1),
    event({
      type: "PRELIMINARY_PERSISTED",
      preliminaryDigest: digest,
      acceptedAttemptNumber: 1,
      responseArtifact: "preliminary-provider-response.json",
    }),
    event({ type: "PRELIMINARY_CLAIMS_PERSISTED", claimSetDigest: priorDigest }),
    event({
      type: "FINDING_VERIFICATION_PERSISTED",
      verificationDigest: digestCanonicalJson(blind),
      providerCall: false,
      responseArtifact: null,
    }),
    event({ type: "AUTHOR_DELIVERED", authorPacketDigest: digest }),
    started("FINAL", 2),
    succeeded("FINAL", 2),
    event({
      type: "FINAL_CANDIDATE_PERSISTED",
      candidateDigest: digest,
      transitionDigest: digest,
      targetSetDigest: digest,
      catalogSetDigest: digest,
      acceptedAttemptNumber: 2,
    }),
    started("FINAL_CLAIM_VERIFICATION", 3),
    failed("FINAL_CLAIM_VERIFICATION", 3),
    event({ type: "RUN_FAILED", terminalState: "FAILED", error }),
  ];
  const frozenExperiment = EvaluationExperimentManifestV1Schema.parse({
    ...graph.experiment,
    variants: graph.experiment.variants.slice(0, 1),
    comparisons: [],
  });
  return {
    experiment: frozenExperiment,
    caseManifest,
    split: "DEVELOPMENT" as const,
    events,
    report: null,
    prior,
    blind,
    startedAt: "2026-09-22T13:02:03.250Z",
    completedAt: "2026-09-22T13:02:05.750Z",
    runtimeReference: ".review-runs/clean-case",
    admittedCeilingUsd: 0.04,
    evidenceBytes: 123,
    outputBytes: 456,
  };
}

describe("buildRuntimeEvaluationAttemptV1", () => {
  it("retains actual timestamps, runtime reference, and one case/first-variant repetition", () => {
    const input = fixture();
    const attempt = buildRuntimeEvaluationAttemptV1(input);
    EvaluationAttemptRecordV1Schema.parse(attempt);
    assert.equal(attempt.startedAt, input.startedAt);
    assert.equal(attempt.completedAt, input.completedAt);
    assert.equal(attempt.elapsedMs, 2500);
    assert.equal(attempt.runtimeRunReference, input.runtimeReference);
    assert.equal(attempt.caseId, input.caseManifest.caseId);
    assert.equal(attempt.variantId, input.experiment.variants[0]?.variantId);
    assert.equal(attempt.repetition, 1);
    assert.equal(attempt.split, "DEVELOPMENT");
    assert.equal(attempt.usage.evidenceBytes, 123);
    assert.equal(attempt.usage.outputBytes, 456);
  });
  it("folds post-final verification failure into logical FINAL and preserves clean blind skip", () => {
    const attempt = buildRuntimeEvaluationAttemptV1(fixture());
    assert.deepEqual(
      attempt.stageOutcomes.map(({ stage, state, providerCall }) => ({
        stage,
        state,
        providerCall,
      })),
      [
        { stage: "PRELIMINARY", state: "SUCCEEDED", providerCall: true },
        { stage: "FINDING_VERIFICATION", state: "SUCCEEDED", providerCall: false },
        { stage: "FINAL", state: "FAILED", providerCall: true },
      ],
    );
    assert.deepEqual(attempt.terminalOutcome, {
      kind: "PROVIDER_FAILURE",
      stage: "FINAL",
      failureCode: "PROVIDER_ERROR",
      transportUncertain: false,
    });
    assert.deepEqual(attempt.findingClaims, []);
  });
  it("counts post-final provider attempt and keeps unknown cost visible", () => {
    const input = fixture();
    input.events = input.events.map((item) =>
      item.type === "CALL_SUCCEEDED"
        ? {
            ...item,
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cost: 0.005 },
          }
        : item,
    );
    const { usage } = buildRuntimeEvaluationAttemptV1(input);
    assert.equal(usage.providerAttempts, 3);
    assert.equal(usage.knownCostAttempts, 2);
    assert.equal(usage.unknownCostAttempts, 1);
    assert.equal(usage.knownCostUsd, 0.01);
    assert.equal(usage.admittedCeilingUsd, 0.04);
    assert.ok(usage.conservativeChargeUsd >= usage.knownCostUsd);
  });
  it("retains uncertain transport without inventing semantic delivery", () => {
    const input = fixture();
    input.events = input.events.map((item) =>
      item.type === "RUN_FAILED" ? { ...item, terminalState: "TRANSPORT_UNCERTAIN" } : item,
    );
    const attempt = buildRuntimeEvaluationAttemptV1(input);
    assert.deepEqual(attempt.terminalOutcome, {
      kind: "PROVIDER_FAILURE",
      stage: "FINAL",
      failureCode: "PROVIDER_ERROR",
      transportUncertain: true,
    });
    assert.deepEqual(attempt.findingClaims, []);
  });
  it("rejects mixed-version ledger and tampered preliminary claim binding", () => {
    const mixed = fixture();
    const first = mixed.events[0];
    assert.ok(first);
    mixed.events[0] = { ...first, schemaVersion: 1 } as unknown as RunRecordEventV2;
    assert.throws(() => buildRuntimeEvaluationAttemptV1(mixed));
    const tampered = fixture();
    tampered.events = tampered.events.map((item) =>
      item.type === "PRELIMINARY_CLAIMS_PERSISTED"
        ? { ...item, claimSetDigest: { algorithm: "SHA256", value: "b".repeat(64) } }
        : item,
    );
    assert.throws(() => buildRuntimeEvaluationAttemptV1(tampered));
  });
});
