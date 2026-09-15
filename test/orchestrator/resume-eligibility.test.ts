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

const retryRequested = (stage: string, failedAttemptNumber: number, retryAttemptNumber: number) =>
  event({
    type: "PROVIDER_RETRY_REQUESTED",
    stage,
    failedAttemptNumber,
    retryAttemptNumber,
    retriesUsed: 1,
    maxRetries: 1,
    delayMs: 1,
    chargedFailedTokens: 0,
    chargedFailedCostUsd: 0,
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

  it("admits explicit declined author-context release without treating it as missing", () => {
    const events = eligibleEvents();
    const index = events.findIndex((candidate) => candidate.type === "AUTHOR_DELIVERED");
    events[index] = event({
      type: "AUTHOR_CONTEXT_RELEASED",
      authorContext: { schemaVersion: 1, status: "DECLINED", digest },
    });

    const result = evaluateResumeShapeV1(events);
    assert.equal(result.eligible, true);
    assert.ok(result.eligible);
    assert.equal(result.shape.authorDelivered.type, "AUTHOR_CONTEXT_RELEASED");
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
    for (const candidate of events) {
      if (
        (candidate.type === "CALL_STARTED" || candidate.type === "CALL_SUCCEEDED") &&
        candidate.stage === "FINDING_VERIFICATION"
      )
        candidate.attemptNumber = 3;
      if (
        (candidate.type === "CALL_STARTED" || candidate.type === "CALL_FAILED") &&
        candidate.stage === "FINAL"
      )
        candidate.attemptNumber = 4;
    }

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
    for (const candidate of events) {
      if (
        (candidate.type === "CALL_STARTED" || candidate.type === "CALL_FAILED") &&
        candidate.stage === "FINAL"
      )
        candidate.attemptNumber = 2;
    }

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

  it("admits a definite final 429 when the terminal failure event was not durably appended", () => {
    const events = eligibleEvents();
    events.pop();

    const result = evaluateResumeShapeV1(events);
    assert.equal(result.eligible, true);
    assert.ok(result.eligible);
    assert.equal(result.shape.runFailed, undefined);
  });

  it("refuses a run that already completed, and names why", () => {
    const events = eligibleEvents();
    events.push(event({ type: "RUN_COMPLETED", terminalState: "READY" }));

    assert.deepEqual(refusalsOf(events), [
      "ALREADY_COMPLETED",
      "POST_TERMINAL_EVENT_INVALID",
      "NOT_TERMINALLY_FAILED",
    ]);
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

    assert.deepEqual(refusalsOf(events), ["ALREADY_RESUMED", "POST_TERMINAL_EVENT_INVALID"]);
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
      "CALL_OUTCOME_SEQUENCE_INVALID",
      "PROVIDER_RETRY_SEQUENCE_INVALID",
      "POST_TERMINAL_EVENT_INVALID",
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

  it("refuses mixed or duplicate author lifecycle transitions", () => {
    const mixed = eligibleEvents();
    const authorIndex = mixed.findIndex((candidate) => candidate.type === "AUTHOR_DELIVERED");
    mixed.splice(
      authorIndex,
      0,
      event({
        type: "AUTHOR_CONTEXT_RELEASED",
        authorContext: { schemaVersion: 1, status: "DECLINED", digest },
      }),
    );
    assert.deepEqual(refusalsOf(mixed), ["MULTIPLE_AUTHOR_LIFECYCLE_TRANSITIONS"]);

    const duplicate = eligibleEvents();
    duplicate.splice(
      duplicate.findIndex((candidate) => candidate.type === "AUTHOR_DELIVERED"),
      0,
      event({ type: "AUTHOR_DELIVERED", authorPacketDigest: digest }),
    );
    assert.deepEqual(refusalsOf(duplicate), ["MULTIPLE_AUTHOR_LIFECYCLE_TRANSITIONS"]);
  });

  it("requires the sole author lifecycle transition after verification and before first final call", () => {
    const tooEarly = eligibleEvents();
    const [earlyAuthor] = tooEarly.splice(
      tooEarly.findIndex((candidate) => candidate.type === "AUTHOR_DELIVERED"),
      1,
    );
    assert.ok(earlyAuthor);
    tooEarly.splice(3, 0, earlyAuthor);
    assert.deepEqual(refusalsOf(tooEarly), ["AUTHOR_LIFECYCLE_OUT_OF_ORDER"]);

    const tooLate = eligibleEvents();
    const [lateAuthor] = tooLate.splice(
      tooLate.findIndex((candidate) => candidate.type === "AUTHOR_DELIVERED"),
      1,
    );
    assert.ok(lateAuthor);
    tooLate.splice(
      tooLate.findIndex(
        (candidate) => candidate.type === "CALL_STARTED" && candidate.stage === "FINAL",
      ) + 1,
      0,
      lateAuthor,
    );
    assert.deepEqual(refusalsOf(tooLate), ["AUTHOR_LIFECYCLE_OUT_OF_ORDER"]);
  });

  it("requires one run and one persisted artifact transition", () => {
    const duplicateRun = eligibleEvents();
    const runStarted = duplicateRun[0];
    assert.ok(runStarted);
    duplicateRun.splice(1, 0, structuredClone(runStarted));
    assert.ok(refusalsOf(duplicateRun).includes("MULTIPLE_RUN_STARTED"));

    const duplicatePreliminary = eligibleEvents();
    const preliminaryIndex = duplicatePreliminary.findIndex(
      (candidate) => candidate.type === "PRELIMINARY_PERSISTED",
    );
    const preliminaryPersisted = duplicatePreliminary[preliminaryIndex];
    assert.ok(preliminaryPersisted);
    duplicatePreliminary.splice(preliminaryIndex + 1, 0, structuredClone(preliminaryPersisted));
    assert.ok(refusalsOf(duplicatePreliminary).includes("MULTIPLE_PRELIMINARY_PERSISTED"));

    const duplicateVerification = eligibleEvents();
    const verificationIndex = duplicateVerification.findIndex(
      (candidate) => candidate.type === "FINDING_VERIFICATION_PERSISTED",
    );
    const verificationPersisted = duplicateVerification[verificationIndex];
    assert.ok(verificationPersisted);
    duplicateVerification.splice(verificationIndex + 1, 0, structuredClone(verificationPersisted));
    assert.ok(
      refusalsOf(duplicateVerification).includes("MULTIPLE_FINDING_VERIFICATION_PERSISTED"),
    );
  });

  it("requires persisted transitions in lifecycle order", () => {
    const preliminaryTooEarly = eligibleEvents();
    const [preliminary] = preliminaryTooEarly.splice(
      preliminaryTooEarly.findIndex((candidate) => candidate.type === "PRELIMINARY_PERSISTED"),
      1,
    );
    assert.ok(preliminary);
    preliminaryTooEarly.splice(1, 0, preliminary);
    assert.ok(refusalsOf(preliminaryTooEarly).includes("PERSISTED_LIFECYCLE_OUT_OF_ORDER"));

    const verificationTooEarly = eligibleEvents();
    const [verification] = verificationTooEarly.splice(
      verificationTooEarly.findIndex(
        (candidate) => candidate.type === "FINDING_VERIFICATION_PERSISTED",
      ),
      1,
    );
    assert.ok(verification);
    verificationTooEarly.splice(2, 0, verification);
    assert.ok(refusalsOf(verificationTooEarly).includes("PERSISTED_LIFECYCLE_OUT_OF_ORDER"));
  });

  it("requires one terminal failure for the last final attempt while retaining earlier retries", () => {
    const duplicateTerminal = eligibleEvents();
    const failureIndex = duplicateTerminal.findIndex(
      (candidate) => candidate.type === "CALL_FAILED" && candidate.stage === "FINAL",
    );
    const terminalFailure = duplicateTerminal[failureIndex];
    assert.ok(terminalFailure);
    duplicateTerminal.splice(failureIndex, 0, structuredClone(terminalFailure));
    assert.ok(refusalsOf(duplicateTerminal).includes("MULTIPLE_TERMINAL_FINAL_FAILURES"));

    const retried = eligibleEvents();
    const finalIndex = retried.findIndex(
      (candidate) => candidate.type === "CALL_STARTED" && candidate.stage === "FINAL",
    );
    retried.splice(
      finalIndex,
      0,
      callStarted("FINAL", 3),
      callFailed429(3),
      event({
        type: "PROVIDER_RETRY_REQUESTED",
        stage: "FINAL",
        failedAttemptNumber: 3,
        retryAttemptNumber: 4,
        retriesUsed: 1,
        maxRetries: 1,
        delayMs: 1,
        chargedFailedTokens: 0,
        chargedFailedCostUsd: 0,
      }),
    );
    const lastStarted = retried.findLast(
      (candidate) => candidate.type === "CALL_STARTED" && candidate.stage === "FINAL",
    );
    const lastFailed = retried.findLast(
      (candidate) => candidate.type === "CALL_FAILED" && candidate.stage === "FINAL",
    );
    assert.ok(lastStarted?.type === "CALL_STARTED" && lastFailed?.type === "CALL_FAILED");
    lastStarted.attemptNumber = 4;
    lastFailed.attemptNumber = 4;
    assert.deepEqual(refusalsOf(retried), []);
  });

  it("rejects duplicate call starts and outcomes for one global attempt", () => {
    const duplicateStart = eligibleEvents();
    const startIndex = duplicateStart.findIndex(
      (candidate) => candidate.type === "CALL_STARTED" && candidate.stage === "FINAL",
    );
    const duplicatedStart = duplicateStart[startIndex];
    assert.ok(duplicatedStart);
    duplicateStart.splice(startIndex + 1, 0, structuredClone(duplicatedStart));
    assert.ok(refusalsOf(duplicateStart).includes("CALL_START_SEQUENCE_INVALID"));

    const duplicateOutcome = eligibleEvents();
    const outcomeIndex = duplicateOutcome.findIndex(
      (candidate) => candidate.type === "CALL_SUCCEEDED" && candidate.stage === "PRELIMINARY",
    );
    const duplicatedOutcome = duplicateOutcome[outcomeIndex];
    assert.ok(duplicatedOutcome);
    duplicateOutcome.splice(outcomeIndex + 1, 0, structuredClone(duplicatedOutcome));
    assert.ok(refusalsOf(duplicateOutcome).includes("CALL_OUTCOME_SEQUENCE_INVALID"));
  });

  it("rejects outcomes before their start and outcomes bound to the wrong stage", () => {
    const outcomeBeforeStart = eligibleEvents();
    const [outcome] = outcomeBeforeStart.splice(
      outcomeBeforeStart.findIndex(
        (candidate) => candidate.type === "CALL_SUCCEEDED" && candidate.stage === "PRELIMINARY",
      ),
      1,
    );
    assert.ok(outcome);
    outcomeBeforeStart.splice(1, 0, outcome);
    assert.ok(refusalsOf(outcomeBeforeStart).includes("CALL_OUTCOME_SEQUENCE_INVALID"));

    const wrongStage = eligibleEvents();
    const preliminaryStart = wrongStage.findIndex(
      (candidate) => candidate.type === "CALL_STARTED" && candidate.stage === "PRELIMINARY",
    );
    wrongStage.splice(preliminaryStart + 1, 0, callFailed429(1));
    assert.ok(refusalsOf(wrongStage).includes("CALL_OUTCOME_SEQUENCE_INVALID"));
  });

  it("accepts genuine preliminary and final retries but rejects orphan, duplicate, and mismatched retry records", () => {
    const preliminaryRetry = eligibleEvents();
    const preliminaryOutcome = preliminaryRetry.findIndex(
      (candidate) => candidate.type === "CALL_SUCCEEDED" && candidate.stage === "PRELIMINARY",
    );
    preliminaryRetry.splice(
      preliminaryOutcome,
      1,
      event({
        type: "CALL_FAILED",
        attemptNumber: 1,
        stage: "PRELIMINARY",
        durationMs: 5,
        error: { name: "ProviderCallError", code: "PROVIDER_ERROR", message: "retry" },
      }),
      retryRequested("PRELIMINARY", 1, 2),
      callStarted("PRELIMINARY", 2),
      callSucceeded("PRELIMINARY", 2),
    );
    const preliminaryPersisted = preliminaryRetry.find(
      (candidate) => candidate.type === "PRELIMINARY_PERSISTED",
    );
    assert.ok(preliminaryPersisted?.type === "PRELIMINARY_PERSISTED");
    preliminaryPersisted.acceptedAttemptNumber = 2;
    const verificationStart = preliminaryRetry.findIndex(
      (candidate) =>
        candidate.type === "CALL_STARTED" && candidate.stage === "FINDING_VERIFICATION",
    );
    preliminaryRetry.splice(verificationStart, 2);
    const verificationPersisted = preliminaryRetry.find(
      (candidate) => candidate.type === "FINDING_VERIFICATION_PERSISTED",
    );
    assert.ok(verificationPersisted?.type === "FINDING_VERIFICATION_PERSISTED");
    verificationPersisted.providerCall = false;
    delete verificationPersisted.acceptedAttemptNumber;
    verificationPersisted.responseArtifact = null;
    assert.deepEqual(refusalsOf(preliminaryRetry), []);

    const finalRetry = eligibleEvents();
    const terminalFailure = finalRetry.findIndex(
      (candidate) => candidate.type === "CALL_FAILED" && candidate.stage === "FINAL",
    );
    finalRetry.splice(
      terminalFailure + 1,
      0,
      retryRequested("FINAL", 3, 4),
      callStarted("FINAL", 4),
      callFailed429(4),
    );
    assert.deepEqual(refusalsOf(finalRetry), []);

    const orphan = eligibleEvents();
    orphan.splice(orphan.length - 1, 0, retryRequested("FINAL", 3, 4));
    assert.ok(refusalsOf(orphan).includes("PROVIDER_RETRY_SEQUENCE_INVALID"));

    const duplicate = structuredClone(finalRetry);
    const retryIndex = duplicate.findIndex(
      (candidate) => candidate.type === "PROVIDER_RETRY_REQUESTED",
    );
    const duplicatedRetry = duplicate[retryIndex];
    assert.ok(duplicatedRetry);
    duplicate.splice(retryIndex, 0, structuredClone(duplicatedRetry));
    assert.ok(refusalsOf(duplicate).includes("PROVIDER_RETRY_SEQUENCE_INVALID"));

    const mismatched = structuredClone(finalRetry);
    const retry = mismatched.find((candidate) => candidate.type === "PROVIDER_RETRY_REQUESTED");
    assert.ok(retry?.type === "PROVIDER_RETRY_REQUESTED");
    retry.retryAttemptNumber = 99;
    assert.ok(refusalsOf(mismatched).includes("PROVIDER_RETRY_SEQUENCE_INVALID"));
  });

  it("permits only final bookkeeping and an optional trailing run failure after terminal failure", () => {
    const wrongStageBookkeeping = eligibleEvents();
    wrongStageBookkeeping.splice(
      wrongStageBookkeeping.length - 1,
      0,
      event({
        type: "BUDGET_EXHAUSTED",
        budget: "COST",
        stage: "PRELIMINARY",
        phase: "RESERVATION",
        spentUsd: 0.2,
        additionalUsd: 0.1,
      }),
    );
    assert.ok(refusalsOf(wrongStageBookkeeping).includes("POST_TERMINAL_EVENT_INVALID"));

    const duplicateBookkeeping = eligibleEvents();
    const budgetEvent = event({
      type: "BUDGET_EXHAUSTED",
      budget: "COST",
      stage: "FINAL",
      phase: "RESERVATION",
      spentUsd: 0.2,
      additionalUsd: 0.1,
    });
    duplicateBookkeeping.splice(
      duplicateBookkeeping.length - 1,
      0,
      budgetEvent,
      structuredClone(budgetEvent),
    );
    assert.ok(refusalsOf(duplicateBookkeeping).includes("POST_TERMINAL_EVENT_INVALID"));

    const noRunFailed = eligibleEvents();
    noRunFailed.pop();
    assert.deepEqual(refusalsOf(noRunFailed), []);
  });

  it("reports every failing predicate rather than the first", () => {
    const refusals = refusalsOf([]);

    assert.ok(refusals.length > 5, `expected several refusals, saw ${refusals.join(", ")}`);
    assert.ok(refusals.includes("NO_RUN_STARTED"));
    assert.ok(refusals.includes("NOT_TERMINALLY_FAILED"));
    assert.ok(refusals.includes("NO_FINAL_CALL_FAILED"));
  });
});
