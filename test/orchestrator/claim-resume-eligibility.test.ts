import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type RunRecordEventV2,
  RunRecordEventV2Schema,
} from "../../src/contracts/run-record-v2.js";
import { evaluateClaimResumeV1 } from "../../src/orchestrator/claim-resume-eligibility.js";

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
const terminal = () => event({ type: "RUN_FAILED", terminalState: "FAILED", error });
const candidate = () =>
  event({
    type: "FINAL_CANDIDATE_PERSISTED",
    candidateDigest: digest,
    transitionDigest: digest,
    targetSetDigest: digest,
    catalogSetDigest: digest,
  });
const postVerification = (providerCall: boolean) =>
  event({
    type: "FINAL_CLAIM_VERIFICATION_PERSISTED",
    verificationDigest: digest,
    providerCall,
    ...(providerCall ? { acceptedAttemptNumber: 4 } : {}),
    responseArtifact: providerCall ? "final-claim-verification-provider-response.json" : null,
  });
function blindAndAuthor(): RunRecordEventV2[] {
  return [
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
    event({ type: "PRELIMINARY_CLAIMS_PERSISTED", claimSetDigest: digest }),
    started("FINDING_VERIFICATION", 2),
    succeeded("FINDING_VERIFICATION", 2),
    event({
      type: "FINDING_VERIFICATION_PERSISTED",
      verificationDigest: digest,
      providerCall: true,
      acceptedAttemptNumber: 2,
      responseArtifact: "finding-verification-provider-response.json",
    }),
    event({ type: "AUTHOR_DELIVERED", authorPacketDigest: digest }),
  ];
}
function finalFailure(): RunRecordEventV2[] {
  return [...blindAndAuthor(), started("FINAL", 3), failed("FINAL", 3), terminal()];
}
function persistedCandidate(): RunRecordEventV2[] {
  return [...blindAndAuthor(), started("FINAL", 3), succeeded("FINAL", 3), candidate()];
}
function refuses(events: RunRecordEventV2[], label = "expected refusal"): void {
  const result = evaluateClaimResumeV1(events);
  assert.equal(result.eligible, false, label);
  assert.equal(result.stage, null, label);
  assert.ok(result.refusals.length > 0, label);
}

describe("evaluateClaimResumeV1", () => {
  it("resumes FINAL after a completed failed final attempt", () => {
    assert.deepEqual(evaluateClaimResumeV1(finalFailure()), {
      eligible: true,
      stage: "FINAL",
      refusals: [],
      nextAttemptNumber: 4,
    });
  });
  it("resumes final claim verification from a persisted candidate", () => {
    assert.deepEqual(
      evaluateClaimResumeV1([
        ...persistedCandidate(),
        started("FINAL_CLAIM_VERIFICATION", 4),
        failed("FINAL_CLAIM_VERIFICATION", 4),
        terminal(),
      ]),
      {
        eligible: true,
        stage: "FINAL_CLAIM_VERIFICATION",
        refusals: [],
        nextAttemptNumber: 5,
      },
    );
  });
  it("resumes projection with provider-backed or skipped final verification, even after report persistence", () => {
    for (const providerCall of [false, true]) {
      for (const reportPersisted of [false, true]) {
        const events = [
          ...persistedCandidate(),
          ...(providerCall
            ? [started("FINAL_CLAIM_VERIFICATION", 4), succeeded("FINAL_CLAIM_VERIFICATION", 4)]
            : []),
          postVerification(providerCall),
          ...(reportPersisted
            ? [
                event({
                  type: "FINAL_REPORT_PERSISTED",
                  reportDigest: digest,
                  projectionPolicyVersion: "claim-projection-v1",
                }),
              ]
            : []),
          terminal(),
        ];
        assert.deepEqual(evaluateClaimResumeV1(events), {
          eligible: true,
          stage: "PROJECTION",
          refusals: [],
          nextAttemptNumber: providerCall ? 5 : 4,
        });
      }
    }
  });
  it("accepts explicit author context release and local blind-verification skip", () => {
    const events = finalFailure().filter(
      (item) => !("stage" in item && item.stage === "FINDING_VERIFICATION"),
    );
    const adjusted = events.map((item) => {
      if (item.type === "FINDING_VERIFICATION_PERSISTED")
        return event({
          type: item.type,
          verificationDigest: digest,
          providerCall: false,
          responseArtifact: null,
        });
      if (item.type === "AUTHOR_DELIVERED")
        return event({
          type: "AUTHOR_CONTEXT_RELEASED",
          authorContext: { schemaVersion: 1, status: "DECLINED", digest },
        });
      if (item.type === "CALL_STARTED" || item.type === "CALL_FAILED") {
        return item.stage === "FINAL" ? { ...item, attemptNumber: 2 } : item;
      }
      return item;
    });
    assert.deepEqual(evaluateClaimResumeV1(adjusted), {
      eligible: true,
      stage: "FINAL",
      refusals: [],
      nextAttemptNumber: 3,
    });
  });
  it("requires one initial start and a final ordinary failure, with no completed run", () => {
    const valid = finalFailure();
    refuses(valid.slice(1));
    refuses([...valid.slice(0, 1), ...valid]);
    refuses([...valid.slice(1, 2), ...valid.slice(0, 1), ...valid.slice(2)]);
    refuses(valid.slice(0, -1));
    refuses([
      ...valid.slice(0, -1),
      event({ type: "RUN_FAILED", terminalState: "TRANSPORT_UNCERTAIN", error }),
    ]);
    refuses([
      ...valid.slice(0, -1),
      event({ type: "RUN_COMPLETED", terminalState: "READY" }),
      terminal(),
    ]);
  });
  it("requires contiguous positive attempt numbers", () => {
    for (const attemptNumber of [0, -1, 1.5, 2, 5]) {
      const events = finalFailure().map((item) =>
        "attemptNumber" in item && item.attemptNumber === 3 ? { ...item, attemptNumber } : item,
      );
      refuses(events, `attempt ${attemptNumber}`);
    }
  });
  it("refuses dangling, duplicate, unknown, mismatched, and premature completions", () => {
    const valid = finalFailure();
    refuses(valid.filter((item) => item.type !== "CALL_FAILED"));
    refuses([...valid.slice(0, -1), failed("FINAL", 3), terminal()]);
    refuses([...valid.slice(0, -1), succeeded("FINAL", 99), terminal()]);
    refuses(
      valid.map((item) =>
        item.type === "CALL_FAILED" ? failed("FINAL_CLAIM_VERIFICATION", 3) : item,
      ),
    );
    refuses([...valid.slice(0, -3), failed("FINAL", 3), started("FINAL", 3), terminal()]);
  });
  it("requires ordered, unique blind and author checkpoints", () => {
    for (const type of [
      "PRELIMINARY_PERSISTED",
      "PRELIMINARY_CLAIMS_PERSISTED",
      "FINDING_VERIFICATION_PERSISTED",
      "AUTHOR_DELIVERED",
    ] as const) {
      const valid = finalFailure();
      const index = valid.findIndex((item) => item.type === type);
      refuses(
        valid.filter((item) => item.type !== type),
        `missing ${type}`,
      );
      refuses(
        [...valid.slice(0, index), ...valid.slice(index, index + 1), ...valid.slice(index)],
        `duplicate ${type}`,
      );
      const moved = valid.splice(index, 1);
      valid.splice(1, 0, ...moved);
      refuses(valid, `early ${type}`);
    }
  });
  it("binds provider checkpoints to successful calls at their own stage and rejects skip artifacts", () => {
    for (const type of ["PRELIMINARY_PERSISTED", "FINDING_VERIFICATION_PERSISTED"] as const) {
      refuses(
        finalFailure().map((item) =>
          item.type === type ? { ...item, acceptedAttemptNumber: 3 } : item,
        ),
      );
    }
    refuses(
      finalFailure().map((item) =>
        item.type === "FINDING_VERIFICATION_PERSISTED"
          ? { ...item, acceptedAttemptNumber: 1 }
          : item,
      ),
    );
    refuses(
      finalFailure().map((item) =>
        item.type === "FINDING_VERIFICATION_PERSISTED" ? { ...item, providerCall: false } : item,
      ),
    );
    const base = persistedCandidate();
    refuses([...base, event({ ...postVerification(true), acceptedAttemptNumber: 3 }), terminal()]);
    refuses([...base, event({ ...postVerification(false), acceptedAttemptNumber: 3 }), terminal()]);
    refuses([
      ...base,
      event({ ...postVerification(false), responseArtifact: "unexpected.json" }),
      terminal(),
    ]);
  });
  it("requires candidate after final success and before final verification", () => {
    refuses([...finalFailure().slice(0, -1), candidate(), terminal()]);
    refuses([
      ...blindAndAuthor(),
      candidate(),
      started("FINAL", 3),
      succeeded("FINAL", 3),
      postVerification(false),
      terminal(),
    ]);
    refuses([
      ...blindAndAuthor(),
      started("FINAL_CLAIM_VERIFICATION", 3),
      failed("FINAL_CLAIM_VERIFICATION", 3),
      terminal(),
    ]);
    refuses([...persistedCandidate(), candidate(), postVerification(false), terminal()]);
    refuses([
      ...persistedCandidate(),
      postVerification(false),
      postVerification(false),
      terminal(),
    ]);
    refuses([...persistedCandidate(), terminal()]);
  });
  it("refuses provider calls after persisted final verification or report before verification", () => {
    refuses([
      ...persistedCandidate(),
      postVerification(false),
      started("FINAL_CLAIM_VERIFICATION", 4),
      failed("FINAL_CLAIM_VERIFICATION", 4),
      terminal(),
    ]);
    refuses([
      ...persistedCandidate(),
      event({
        type: "FINAL_REPORT_PERSISTED",
        reportDigest: digest,
        projectionPolicyVersion: "claim-projection-v1",
      }),
      postVerification(false),
      terminal(),
    ]);
  });
  it("resumes a repeated final failure only through an explicit resume boundary", () => {
    const retry = [started("FINAL", 4), failed("FINAL", 4), terminal()];
    refuses([...finalFailure(), ...retry]);
    assert.deepEqual(
      evaluateClaimResumeV1([
        ...finalFailure(),
        event({
          type: "RUN_RESUMED",
          stage: "FINAL",
          failedAttemptNumber: 3,
          nextAttemptNumber: 4,
        }),
        ...retry,
      ]),
      {
        eligible: true,
        stage: "FINAL",
        refusals: [],
        nextAttemptNumber: 5,
      },
    );
  });
});
