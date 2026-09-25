import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunRecordEventV1Schema } from "../../src/contracts/run-record.js";
import {
  RUN_RECORD_EVENT_V2_JSON_SCHEMA,
  RunRecordEventV2Schema,
} from "../../src/contracts/run-record-v2.js";

const envelope = { schemaVersion: 2, at: "2026-09-22T12:00:00.000Z" };
const digest = { algorithm: "SHA256", value: "a".repeat(64) };

function started() {
  return {
    ...envelope,
    type: "RUN_STARTED",
    snapshotDigest: digest,
    briefDigest: digest,
    contextMapDigest: digest,
    planDigest: digest,
    configId: "config_test",
    configDigest: digest,
    requestedModels: ["model/test"],
    promptVersion: "prompt-v1",
    preliminarySchema: "preliminary-v1",
    finalSchema: "final-claim-candidate-v4",
    findingVerificationSchema: "claim-verification-v1",
    findingVerificationPromptVersion: "claim-v1",
    claimProtocolVersion: "claim-review-v1",
    finalClaimVerificationSchema: "claim-verification-v1",
    finalClaimVerificationPromptVersion: "final-claim-v1",
    projectionPolicyVersion: "projection-v1",
  };
}

describe("run record V2 generation boundary", () => {
  it("requires every claim protocol identity on run start", () => {
    assert.deepEqual(RunRecordEventV2Schema.parse(started()), started());
    for (const field of [
      "claimProtocolVersion",
      "finalClaimVerificationSchema",
      "finalClaimVerificationPromptVersion",
      "projectionPolicyVersion",
    ]) {
      const changed: Record<string, unknown> = { ...started() };
      delete changed[field];
      assert.equal(RunRecordEventV2Schema.safeParse(changed).success, false, field);
    }
    assert.equal(
      RunRecordEventV2Schema.safeParse({ ...started(), claimProtocolVersion: "claim-review-v0" })
        .success,
      false,
    );
    assert.equal(
      RunRecordEventV1Schema.safeParse({ ...started(), schemaVersion: 1 }).success,
      false,
    );
    assert.equal(typeof RUN_RECORD_EVENT_V2_JSON_SCHEMA, "object");
  });

  it("records all digest-bound claim and projection persistence checkpoints", () => {
    const checkpoints = [
      { type: "PRELIMINARY_CLAIMS_PERSISTED", claimSetDigest: digest },
      {
        type: "FINAL_CANDIDATE_PERSISTED",
        candidateDigest: digest,
        transitionDigest: digest,
        targetSetDigest: digest,
        catalogSetDigest: digest,
        acceptedAttemptNumber: 2,
      },
      {
        type: "FINAL_CLAIM_VERIFICATION_PERSISTED",
        verificationDigest: digest,
        providerCall: true,
        acceptedAttemptNumber: 4,
        responseArtifact: "final-claim-response.json",
      },
      {
        type: "FINAL_CLAIM_VERIFICATION_PERSISTED",
        verificationDigest: digest,
        providerCall: false,
        responseArtifact: null,
      },
      {
        type: "FINAL_REPORT_PERSISTED",
        reportDigest: digest,
        projectionPolicyVersion: "projection-v1",
      },
    ];
    for (const checkpoint of checkpoints) {
      const event = { ...envelope, ...checkpoint };
      assert.deepEqual(RunRecordEventV2Schema.parse(event), event);
      assert.equal(
        RunRecordEventV2Schema.safeParse({ ...event, unboundExplanation: "Extra prose" }).success,
        false,
      );
      assert.equal(RunRecordEventV1Schema.safeParse({ ...event, schemaVersion: 1 }).success, false);
    }
    assert.equal(
      RunRecordEventV2Schema.safeParse({
        ...envelope,
        type: "FINAL_CANDIDATE_PERSISTED",
        candidateDigest: digest,
      }).success,
      false,
    );
  });

  it("admits post-author verification for call, retry, and budget events only in V2", () => {
    const payloads = [
      {
        type: "CALL_SUCCEEDED",
        attemptNumber: 4,
        durationMs: 10,
        responseId: null,
        returnedModel: null,
        returnedProvider: null,
        usage: { promptTokens: null, completionTokens: null, totalTokens: null, cost: null },
      },
      {
        type: "CALL_STARTED",
        attemptNumber: 4,
        inputDigest: digest,
        providerPolicyVersion: "policy-v1",
        preferredProviderEndpoints: null,
        excludedProviderEndpoints: null,
        wireBodyDigest: digest,
        wireBodyBytes: 100,
        credentialFreeWireRequestDigest: digest,
        requestedModels: ["model/test"],
        promptVersion: "prompt-v1",
        responseSchemaName: "claim-verification-v1",
        responseArrayLimits: {},
        maxOutputTokens: 1000,
        timeoutMs: 10000,
      },
      {
        type: "CALL_FAILED",
        attemptNumber: 4,
        durationMs: 10,
        error: { name: "Error", code: null, message: "Transport failed." },
      },
      {
        type: "PROVIDER_RETRY_REQUESTED",
        failedAttemptNumber: 4,
        retryAttemptNumber: 5,
        retriesUsed: 1,
        maxRetries: 1,
        delayMs: 100,
        chargedFailedTokens: 1000,
        chargedFailedCostUsd: 0.1,
      },
      {
        type: "BUDGET_EXHAUSTED",
        budget: "COST",
        phase: "RESERVATION",
        spentUsd: 1,
        additionalUsd: 0.1,
      },
    ];
    for (const payload of payloads) {
      const event = { ...envelope, ...payload, stage: "FINAL_CLAIM_VERIFICATION" };
      assert.equal(RunRecordEventV2Schema.safeParse(event).success, true);
      assert.equal(RunRecordEventV1Schema.safeParse({ ...event, schemaVersion: 1 }).success, false);
      assert.equal(
        RunRecordEventV2Schema.safeParse({ ...event, stage: "PROJECTION" }).success,
        false,
      );
    }
  });

  it("distinguishes final generation, verification, and local projection resume", () => {
    for (const stage of ["FINAL", "FINAL_CLAIM_VERIFICATION", "PROJECTION"]) {
      assert.equal(
        RunRecordEventV2Schema.safeParse({
          ...envelope,
          type: "RUN_RESUMED",
          stage,
          failedAttemptNumber: 3,
          nextAttemptNumber: 4,
        }).success,
        true,
      );
    }
    assert.equal(
      RunRecordEventV2Schema.safeParse({
        ...envelope,
        type: "RUN_RESUMED",
        stage: "PRELIMINARY",
        failedAttemptNumber: 3,
        nextAttemptNumber: 4,
      }).success,
      false,
    );
  });

  it("requires final verification wire admission without modifying V1", () => {
    const event = {
      ...envelope,
      type: "GUIDANCE_ADMISSION",
      contentBytes: 100,
      wireBytesByStage: {
        preliminary: 200,
        findingVerification: 300,
        final: 400,
        finalClaimVerification: 500,
      },
      capacityBytes: 1000,
      status: "ACCEPTED",
      warningReasons: [],
      stopReasons: [],
    };
    assert.equal(RunRecordEventV2Schema.safeParse(event).success, true);
    const { finalClaimVerification: _, ...legacyWire } = event.wireBytesByStage;
    assert.equal(
      RunRecordEventV2Schema.safeParse({ ...event, wireBytesByStage: legacyWire }).success,
      false,
    );
    assert.equal(
      RunRecordEventV1Schema.safeParse({ ...event, schemaVersion: 1, wireBytesByStage: legacyWire })
        .success,
      true,
    );
    assert.equal(RunRecordEventV1Schema.safeParse({ ...event, schemaVersion: 1 }).success, false);
  });

  it("preserves legacy terminal payload shape while refusing a legacy envelope", () => {
    const event = { ...envelope, type: "RUN_COMPLETED", terminalState: "READY" };
    assert.equal(RunRecordEventV2Schema.safeParse(event).success, true);
    assert.equal(RunRecordEventV2Schema.safeParse({ ...event, schemaVersion: 1 }).success, false);
    assert.equal(RunRecordEventV1Schema.safeParse({ ...event, schemaVersion: 1 }).success, true);
  });
});
