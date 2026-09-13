import type { RunRecordEventOfTypeV1, RunRecordEventV1 } from "../contracts/run-record.js";

/**
 * Decides whether a persisted run record is shaped for a final-stage resume.
 *
 * One function, two callers. `resumeFinalReview` runs it to admit a resume, and the CLI runs it
 * after a failed review to decide whether to offer one. Those used to be separate judgements: the
 * CLI compared the serialized event-type sequence against an eight-element literal that had not
 * been updated when the finding-verification stage was added, so the offer was unreachable on
 * every run (#121). A single predicate set is what keeps them from drifting apart again.
 *
 * Only the run record is examined here. Whether the packet's response protocol and the supplied
 * configuration still match the persisted run is a separate question, answered by the caller that
 * has those things; the CLI has neither.
 */

/** The events a resume needs, once the shape has been admitted. */
export interface ResumeShapeV1 {
  started: RunRecordEventOfTypeV1<"RUN_STARTED">;
  runFailed: RunRecordEventOfTypeV1<"RUN_FAILED">;
  startedCalls: RunRecordEventOfTypeV1<"CALL_STARTED">[];
  preliminaryStarted: RunRecordEventOfTypeV1<"CALL_STARTED">;
  preliminarySucceeded: RunRecordEventOfTypeV1<"CALL_SUCCEEDED">;
  /** In order, so a stored provider response can be correlated with the call that produced it. */
  preliminarySucceededCalls: RunRecordEventOfTypeV1<"CALL_SUCCEEDED">[];
  preliminaryPersisted: RunRecordEventOfTypeV1<"PRELIMINARY_PERSISTED">;
  findingVerificationPersisted: RunRecordEventOfTypeV1<"FINDING_VERIFICATION_PERSISTED">;
  findingVerificationSucceededCalls: RunRecordEventOfTypeV1<"CALL_SUCCEEDED">[];
  authorDelivered: RunRecordEventOfTypeV1<"AUTHOR_DELIVERED">;
  finalStarted: RunRecordEventOfTypeV1<"CALL_STARTED">;
  finalFailed: RunRecordEventOfTypeV1<"CALL_FAILED">;
  acceptedAttemptNumber: number;
}

/**
 * Why a run record cannot be resumed.
 *
 * Named because a refusal used to be one sentence covering nineteen separate conditions, which
 * told a user nothing about which one fired and made the gate untestable clause by clause (#124).
 * These identifiers name conditions, never contents, so they are safe to print.
 */
export type ResumeRefusalV1 =
  | "ALREADY_COMPLETED"
  | "ALREADY_RESUMED"
  | "NO_RUN_STARTED"
  | "NOT_TERMINALLY_FAILED"
  | "UNEXPECTED_SUCCEEDED_CALL_STAGE"
  | "NO_PRELIMINARY_CALL_SUCCEEDED"
  | "TOO_MANY_PRELIMINARY_CALLS"
  | "TOO_MANY_FINDING_VERIFICATION_CALLS"
  | "PRELIMINARY_ATTEMPT_MISMATCH"
  | "PRELIMINARY_ARTIFACT_UNRECOGNIZED"
  | "NO_PRELIMINARY_CALL_STARTED"
  | "NO_PRELIMINARY_PERSISTED"
  | "NO_FINDING_VERIFICATION_PERSISTED"
  | "NO_AUTHOR_DELIVERED"
  | "NO_FINAL_CALL_STARTED"
  | "NO_FINAL_CALL_FAILED"
  | "CALL_ATTEMPTED_AFTER_FINAL_FAILURE"
  | "PRELIMINARY_DID_NOT_START_FIRST"
  | "ATTEMPT_NUMBERS_NOT_MONOTONIC"
  | "FINAL_ATTEMPT_MISMATCH"
  | "TRANSPORT_UNCERTAIN"
  | "NOT_A_PROVIDER_ERROR"
  | "NOT_A_RATE_LIMIT";

export type ResumeShapeResultV1 =
  | { readonly eligible: true; readonly shape: ResumeShapeV1 }
  | { readonly eligible: false; readonly refusals: readonly ResumeRefusalV1[] };

const ACCEPTED_PRELIMINARY_ARTIFACTS_V1 = [
  "preliminary-provider-response.json",
  "preliminary-repair-provider-response.json",
];

function eventsOfType<T extends RunRecordEventV1["type"]>(
  events: readonly RunRecordEventV1[],
  type: T,
): RunRecordEventOfTypeV1<T>[] {
  return events.filter((event): event is RunRecordEventOfTypeV1<T> => event.type === type);
}

/**
 * Evaluates every predicate rather than short-circuiting, so a refusal reports all of its causes.
 *
 * Eligibility is structural, never a literal event sequence: an in-run retry inserts extra
 * CALL_STARTED/CALL_FAILED/PROVIDER_RETRY_REQUESTED events, and a retried run is exactly the kind
 * of run resume exists for.
 */
export function evaluateResumeShapeV1(events: readonly RunRecordEventV1[]): ResumeShapeResultV1 {
  const refusals: ResumeRefusalV1[] = [];
  const refuse = (reason: ResumeRefusalV1, failed: boolean): void => {
    if (failed) refusals.push(reason);
  };

  const startedCalls = eventsOfType(events, "CALL_STARTED");
  const succeededCalls = eventsOfType(events, "CALL_SUCCEEDED");
  const preliminarySucceededCalls = succeededCalls.filter((event) => event.stage === "PRELIMINARY");
  const findingVerificationSucceededCalls = succeededCalls.filter(
    (event) => event.stage === "FINDING_VERIFICATION",
  );
  const first = events[0];
  const last = events.at(-1);
  const started = first?.type === "RUN_STARTED" ? first : undefined;
  const runFailed = last?.type === "RUN_FAILED" ? last : undefined;
  const preliminaryStarted = startedCalls.find((event) => event.stage === "PRELIMINARY");
  const preliminarySucceeded = preliminarySucceededCalls.at(-1);
  const preliminaryPersisted = eventsOfType(events, "PRELIMINARY_PERSISTED")[0];
  const findingVerificationPersisted = eventsOfType(events, "FINDING_VERIFICATION_PERSISTED")[0];
  const authorDelivered = eventsOfType(events, "AUTHOR_DELIVERED")[0];
  const finalStarted = startedCalls.findLast((event) => event.stage === "FINAL");
  const failedCalls = eventsOfType(events, "CALL_FAILED");
  const finalFailed = failedCalls.at(-1)?.stage === "FINAL" ? failedCalls.at(-1) : undefined;

  refuse(
    "ALREADY_COMPLETED",
    events.some((event) => event.type === "RUN_COMPLETED"),
  );
  refuse(
    "ALREADY_RESUMED",
    events.some((event) => event.type === "RUN_RESUMED"),
  );
  refuse("NO_RUN_STARTED", started === undefined);
  refuse("NOT_TERMINALLY_FAILED", runFailed === undefined);
  refuse(
    "UNEXPECTED_SUCCEEDED_CALL_STAGE",
    succeededCalls.length !==
      preliminarySucceededCalls.length + findingVerificationSucceededCalls.length,
  );
  refuse("NO_PRELIMINARY_CALL_SUCCEEDED", preliminarySucceededCalls.length < 1);
  // One initial call, plus at most one output repair.
  refuse("TOO_MANY_PRELIMINARY_CALLS", preliminarySucceededCalls.length > 2);
  refuse("TOO_MANY_FINDING_VERIFICATION_CALLS", findingVerificationSucceededCalls.length > 1);
  refuse("NO_PRELIMINARY_CALL_STARTED", preliminaryStarted === undefined);
  refuse("NO_PRELIMINARY_PERSISTED", preliminaryPersisted === undefined);
  refuse("NO_FINDING_VERIFICATION_PERSISTED", findingVerificationPersisted === undefined);
  refuse("NO_AUTHOR_DELIVERED", authorDelivered === undefined);
  refuse("NO_FINAL_CALL_STARTED", finalStarted === undefined);
  refuse("NO_FINAL_CALL_FAILED", finalFailed === undefined);
  refuse(
    "PRELIMINARY_ATTEMPT_MISMATCH",
    preliminarySucceeded?.attemptNumber !== preliminaryPersisted?.acceptedAttemptNumber,
  );
  refuse(
    "PRELIMINARY_ARTIFACT_UNRECOGNIZED",
    preliminaryPersisted !== undefined &&
      !ACCEPTED_PRELIMINARY_ARTIFACTS_V1.includes(preliminaryPersisted.responseArtifact),
  );

  if (finalFailed !== undefined) {
    // Structural, not positional. The previous form required the failure to sit exactly at
    // `events.length - 2`, which refused a resume whenever a bookkeeping event landed between the
    // failure and RUN_FAILED -- BUDGET_EXHAUSTED does exactly that when a retryable 429 cannot
    // reserve its retry, which is the case resume exists for (#125). What actually matters is
    // that no further call was attempted after the failure.
    const afterFailure = events.slice(events.indexOf(finalFailed) + 1);
    refuse(
      "CALL_ATTEMPTED_AFTER_FINAL_FAILURE",
      afterFailure.some(
        (event) => event.type === "CALL_STARTED" || event.type === "CALL_SUCCEEDED",
      ),
    );
    refuse("TRANSPORT_UNCERTAIN", finalFailed.error.code === "TRANSPORT_UNCERTAIN");
    refuse("NOT_A_PROVIDER_ERROR", finalFailed.error.code !== "PROVIDER_ERROR");
    refuse("NOT_A_RATE_LIMIT", finalFailed.error.diagnostic?.httpStatus !== 429);
    refuse("FINAL_ATTEMPT_MISMATCH", finalStarted?.attemptNumber !== finalFailed.attemptNumber);
  }
  if (runFailed !== undefined) {
    refuse("TRANSPORT_UNCERTAIN", runFailed.terminalState === "TRANSPORT_UNCERTAIN");
    refuse("NOT_A_PROVIDER_ERROR", runFailed.terminalState !== "FAILED");
  }

  refuse("PRELIMINARY_DID_NOT_START_FIRST", preliminaryStarted?.attemptNumber !== 1);
  const lastPreFinalAttempt =
    findingVerificationSucceededCalls.at(-1)?.attemptNumber ?? preliminarySucceeded?.attemptNumber;
  refuse(
    "ATTEMPT_NUMBERS_NOT_MONOTONIC",
    finalStarted === undefined ||
      lastPreFinalAttempt === undefined ||
      !Number.isSafeInteger(finalStarted.attemptNumber) ||
      !Number.isSafeInteger(lastPreFinalAttempt) ||
      finalStarted.attemptNumber <= lastPreFinalAttempt,
  );

  if (
    refusals.length > 0 ||
    started === undefined ||
    runFailed === undefined ||
    preliminaryStarted === undefined ||
    preliminarySucceeded === undefined ||
    preliminaryPersisted === undefined ||
    findingVerificationPersisted === undefined ||
    authorDelivered === undefined ||
    finalStarted === undefined ||
    finalFailed === undefined
  ) {
    return { eligible: false, refusals: [...new Set(refusals)] };
  }

  return {
    eligible: true,
    shape: {
      started,
      runFailed,
      startedCalls,
      preliminaryStarted,
      preliminarySucceeded,
      preliminarySucceededCalls,
      preliminaryPersisted,
      findingVerificationPersisted,
      findingVerificationSucceededCalls,
      authorDelivered,
      finalStarted,
      finalFailed,
      acceptedAttemptNumber: preliminaryPersisted.acceptedAttemptNumber,
    },
  };
}

/** Renders refusal identifiers into the sentence a user sees. */
export function describeResumeRefusalsV1(refusals: readonly ResumeRefusalV1[]): string {
  return `The persisted run state is not eligible for a final-stage resume (${refusals.join(", ")}).`;
}
