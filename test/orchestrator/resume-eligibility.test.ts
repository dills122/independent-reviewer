import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type RunRecordEventV1, RunRecordEventV1Schema } from "../../src/contracts/run-record.js";
import {
  evaluateResumeShapeV1,
  type ResumeRefusalV1,
} from "../../src/orchestrator/resume-eligibility.js";

const digest = { algorithm: "SHA256" as const, value: "a".repeat(64) };
let clock = 0;
const at = () => new Date(Date.UTC(2026, 8, 12, 0, 0, clock++)).toISOString();

function event(fields: Record<string, unknown>): RunRecordEventV1 {
  return RunRecordEventV1Schema.parse({ schemaVersion: 1, at: at(), ...fields });
}

const callStarted = (stage: string, attemptNumber: number) =>
  event({
    type: "CALL_STARTED",
    attemptNumber,
    stage,
    inputDigest: digest,
    providerPolicyVersion: "openrouter-chat-completions-v5",
    preferredProviderEndpoints: null,
    excludedProviderEndpoints: null,
    wireBodyDigest: digest,
    wireBodyBytes: 10,
    credentialFreeWireRequestDigest: digest,
    requestedModels: ["vendor/model"],
    promptVersion: "review-policy-v21",
    responseSchemaName: "preliminary_assessment_v1",
    responseArrayLimits: {},
    maxOutputTokens: 8192,
    timeoutMs: 1000,
  });

const callSucceeded = (stage: string, attemptNumber: number) =>
  event({
    type: "CALL_SUCCEEDED",
    attemptNumber,
    stage,
    durationMs: 5,
    responseId: "id",
    returnedModel: "vendor/model",
    returnedProvider: "vendor",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0.1 },
  });

const callFailed429 = (attemptNumber: number) =>
  event({
    type: "CALL_FAILED",
    attemptNumber,
    stage: "FINAL",
    durationMs: 5,
    error: {
      name: "ProviderCallError",
      code: "PROVIDER_ERROR",
      message: "rate limited",
      diagnostic: {
        httpStatus: 429,
        providerErrorCode: "429",
        providerMessage: null,
        errorType: null,
        providerCode: null,
        providerName: null,
        model: null,
        responseId: null,
        retryAfter: null,
      },
    },
  });

/**
 * The sequence a real run produces when the final call is rate limited.
 *
 * Built from the contract rather than hand-written JSON, and deliberately including the
 * finding-verification events: the CLI's previous literal sequence omitted them, which is what
 * made its resume offer unreachable (#121).
 */
function eligibleEvents(): RunRecordEventV1[] {
  clock = 0;
  return [
    event({
      type: "RUN_STARTED",
      snapshotDigest: digest,
      briefDigest: digest,
      contextMapDigest: digest,
      planDigest: digest,
      configId: "config_example",
      configDigest: digest,
      requestedModels: ["vendor/model"],
      promptVersion: "review-policy-v21",
      preliminarySchema: "preliminary_assessment_v1",
      finalSchema: "final_review_candidate_v3",
      findingVerificationSchema: "finding_verification_candidate_v1",
      findingVerificationPromptVersion: "finding-verification-policy-v3",
    }),
    callStarted("PRELIMINARY", 1),
    callSucceeded("PRELIMINARY", 1),
    event({
      type: "PRELIMINARY_PERSISTED",
      preliminaryDigest: digest,
      acceptedAttemptNumber: 1,
      responseArtifact: "preliminary-provider-response.json",
    }),
    callStarted("FINDING_VERIFICATION", 2),
    callSucceeded("FINDING_VERIFICATION", 2),
    event({
      type: "FINDING_VERIFICATION_PERSISTED",
      verificationDigest: digest,
      providerCall: true,
      acceptedAttemptNumber: 2,
      responseArtifact: "finding-verification-provider-response.json",
    }),
    event({ type: "AUTHOR_DELIVERED", authorPacketDigest: digest }),
    callStarted("FINAL", 3),
    callFailed429(3),
    event({
      type: "RUN_FAILED",
      terminalState: "FAILED",
      error: { name: "ProviderCallError", code: "PROVIDER_ERROR", message: "rate limited" },
    }),
  ];
}

function refusalsOf(events: RunRecordEventV1[]): readonly ResumeRefusalV1[] {
  const result = evaluateResumeShapeV1(events);
  return result.eligible ? [] : result.refusals;
}

describe("evaluateResumeShapeV1", () => {
  it("admits a real rate-limited run, finding-verification events included", () => {
    const result = evaluateResumeShapeV1(eligibleEvents());

    assert.equal(result.eligible, true);
    assert.ok(result.eligible);
    assert.equal(result.shape.acceptedAttemptNumber, 1);
    assert.equal(result.shape.finalStarted.attemptNumber, 3);
    assert.equal(result.shape.finalFailed.attemptNumber, 3);
    assert.equal(result.shape.findingVerificationSucceededCalls.length, 1);
  });

  it("admits a run whose preliminary needed one output repair", () => {
    const events = eligibleEvents();
    events.splice(3, 0, callStarted("PRELIMINARY", 2), callSucceeded("PRELIMINARY", 2));
    const persisted = events.findIndex((candidate) => candidate.type === "PRELIMINARY_PERSISTED");
    events[persisted] = event({
      type: "PRELIMINARY_PERSISTED",
      preliminaryDigest: digest,
      acceptedAttemptNumber: 2,
      responseArtifact: "preliminary-repair-provider-response.json",
    });

    assert.deepEqual(refusalsOf(events), []);
  });

  it("admits a run whose preliminary had no findings to verify", () => {
    const events = eligibleEvents().filter(
      (candidate) =>
        !(candidate.type === "CALL_STARTED" && candidate.stage === "FINDING_VERIFICATION") &&
        !(candidate.type === "CALL_SUCCEEDED" && candidate.stage === "FINDING_VERIFICATION"),
    );
    const index = events.findIndex(
      (candidate) => candidate.type === "FINDING_VERIFICATION_PERSISTED",
    );
    events[index] = event({
      type: "FINDING_VERIFICATION_PERSISTED",
      verificationDigest: digest,
      providerCall: false,
      responseArtifact: null,
    });

    assert.deepEqual(refusalsOf(events), []);
  });

  it("admits a rate-limited run whose retry could not be reserved", () => {
    // Regression for #125. `assertCostBudget` appends BUDGET_EXHAUSTED between the failed call and
    // RUN_FAILED when a retryable 429 cannot reserve its retry. The old positional assertion
    // required CALL_FAILED to sit exactly at events.length - 2, so it refused precisely the run
    // resume exists for: one that died on a rate limit with a paid preliminary already saved.
    const events = eligibleEvents();
    events.splice(
      events.length - 1,
      0,
      event({
        type: "BUDGET_EXHAUSTED",
        budget: "COST",
        stage: "FINAL",
        phase: "RESERVATION",
        spentUsd: 0.2,
        additionalUsd: 0.1,
      }),
    );

    assert.deepEqual(refusalsOf(events), []);
  });

  it("refuses a run that already completed, and names why", () => {
    const events = eligibleEvents();
    events.push(event({ type: "RUN_COMPLETED", terminalState: "READY" }));

    assert.deepEqual(refusalsOf(events), ["ALREADY_COMPLETED", "NOT_TERMINALLY_FAILED"]);
  });

  it("refuses a second resume", () => {
    const events = eligibleEvents();
    events.splice(
      events.length - 1,
      0,
      event({
        type: "RUN_RESUMED",
        stage: "FINAL",
        failedAttemptNumber: 3,
        nextAttemptNumber: 4,
      }),
    );

    assert.deepEqual(refusalsOf(events), ["ALREADY_RESUMED"]);
  });

  it("refuses a transport-uncertain failure", () => {
    const events = eligibleEvents();
    events[events.length - 2] = event({
      type: "CALL_FAILED",
      attemptNumber: 3,
      stage: "FINAL",
      durationMs: 5,
      error: { name: "ProviderCallError", code: "TRANSPORT_UNCERTAIN", message: "unknown" },
    });
    events[events.length - 1] = event({
      type: "RUN_FAILED",
      terminalState: "TRANSPORT_UNCERTAIN",
      error: { name: "ProviderCallError", code: "TRANSPORT_UNCERTAIN", message: "unknown" },
    });

    const refusals = refusalsOf(events);
    assert.ok(refusals.includes("TRANSPORT_UNCERTAIN"), refusals.join(","));
    // Reported once, not once per predicate that observed it.
    assert.equal(refusals.filter((reason) => reason === "TRANSPORT_UNCERTAIN").length, 1);
  });

  it("refuses a failure that was not a rate limit", () => {
    const events = eligibleEvents();
    events[events.length - 2] = event({
      type: "CALL_FAILED",
      attemptNumber: 3,
      stage: "FINAL",
      durationMs: 5,
      error: {
        name: "ProviderCallError",
        code: "PROVIDER_ERROR",
        message: "server error",
        diagnostic: {
          httpStatus: 500,
          providerErrorCode: "500",
          providerMessage: null,
          errorType: null,
          providerCode: null,
          providerName: null,
          model: null,
          responseId: null,
          retryAfter: null,
        },
      },
    });

    assert.deepEqual(refusalsOf(events), ["NOT_A_RATE_LIMIT"]);
  });

  it("refuses when another call was attempted after the final failure", () => {
    const events = eligibleEvents();
    events.splice(events.length - 1, 0, callStarted("FINAL", 4));

    // Two independent predicates catch this: a call follows the failure, and the last FINAL call
    // started is no longer the one that failed. Both are reported, which is the point of naming
    // them -- a single sentence would have hidden that the run is wrong in two ways.
    assert.deepEqual(refusalsOf(events), [
      "CALL_ATTEMPTED_AFTER_FINAL_FAILURE",
      "FINAL_ATTEMPT_MISMATCH",
    ]);
  });

  it("refuses a run with no persisted finding verification", () => {
    const events = eligibleEvents().filter(
      (candidate) => candidate.type !== "FINDING_VERIFICATION_PERSISTED",
    );

    assert.deepEqual(refusalsOf(events), ["NO_FINDING_VERIFICATION_PERSISTED"]);
  });

  it("refuses a run that never reached the author stage", () => {
    const events = eligibleEvents().filter((candidate) => candidate.type !== "AUTHOR_DELIVERED");

    assert.deepEqual(refusalsOf(events), ["NO_AUTHOR_DELIVERED"]);
  });

  it("reports every failing predicate rather than the first", () => {
    const refusals = refusalsOf([]);

    assert.ok(refusals.length > 5, `expected several refusals, saw ${refusals.join(", ")}`);
    assert.ok(refusals.includes("NO_RUN_STARTED"));
    assert.ok(refusals.includes("NOT_TERMINALLY_FAILED"));
    assert.ok(refusals.includes("NO_FINAL_CALL_FAILED"));
  });
});
