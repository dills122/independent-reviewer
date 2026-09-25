import type { RunRecordEventV2 } from "../contracts/run-record-v2.js";

export type ClaimResumeStageV1 = "FINAL" | "FINAL_CLAIM_VERIFICATION" | "PROJECTION";

/**
 * Named so a caller (or a test) can match a specific reason instead of coupling to prose, and so
 * a future change to one message cannot silently drift out of sync with the other reader.
 *
 * This validates the four-stage ledger grammar separately from `evaluateResumeShapeV1`'s
 * three-stage one (`./resume-eligibility.js`) rather than generalizing it over an arbitrary stage
 * sequence: the V2 ledger adds checkpoint types (PRELIMINARY_CLAIMS_PERSISTED,
 * FINAL_CANDIDATE_PERSISTED, FINAL_CLAIM_VERIFICATION_PERSISTED) and a no-provider-call PROJECTION
 * resume target that the V1 grammar has no shape for. That file's own header documents #121, the
 * bug a second unmaintained copy caused before; unifying the two into one parameterized validator
 * remains open follow-up work, not something to redo casually under time pressure given both
 * guard real provider spend.
 */
export const CLAIM_RESUME_REFUSAL_V1 = {
  RUN_START_NOT_FIRST: "Run start must be first",
  RUN_COMPLETED: "Completed runs cannot resume",
  BUDGET_EXHAUSTED: "Budget-exhausted runs cannot resume",
  NOT_TERMINALLY_FAILED: "Resume requires an explicit non-uncertain failure",
  DUPLICATE_TERMINAL_FAILURE: "Duplicate terminal failure without resume boundary",
  MISSING_FAILURE_BOUNDARY: "Resume requires a preceding failure boundary",
  MISSING_RESUME_BOUNDARY: "Events after failure require a resume boundary",
  NONCONTIGUOUS_ATTEMPTS: "Call attempts must be contiguous and sequential",
  UNMATCHED_CALL_OUTCOME: "Call result has no matching active attempt",
  UNFINISHED_CALL: "Unfinished call has uncertain transport",
  AUTHOR_RELEASE_ORDER: "Blind persistence must precede author release exactly once",
  CANDIDATE_BEFORE_AUTHOR: "Final candidate must follow author release",
  VERIFICATION_BEFORE_CANDIDATE: "Final verification requires an earlier candidate checkpoint",
  REPORT_BEFORE_VERIFICATION: "Final report requires an earlier verification checkpoint",
  RETRY_NOT_ADJACENT: "Provider retry requires adjacent matching failure and call",
  PRELIMINARY_CHECKPOINT_UNSUPPORTED: "Preliminary checkpoint lacks a successful call",
  VERIFICATION_PROVENANCE_MISMATCH: "Verification checkpoint provider provenance mismatch",
  PRELIMINARY_CALL_AFTER_PERSISTENCE: "Preliminary call after persisted assessment",
  BLIND_CALL_OUT_OF_BOUNDS: "Blind verification crossed its persistence boundary",
  FINAL_CALL_OUT_OF_BOUNDS: "Final call crossed its author or candidate boundary",
  POST_AUTHOR_CALL_NEEDS_CANDIDATE: "Post-author call requires a persisted candidate",
  CANDIDATE_UNSUPPORTED: "Final candidate lacks a successful final call",
  PROJECTION_AFTER_CALL: "Local projection cannot follow more provider calls",
  NO_RESUMABLE_CHECKPOINT: "No resumable failed call or local projection checkpoint",
} as const;

/** Shape proves where work stopped; the resume loader separately rechecks every artifact digest. */
export function evaluateClaimResumeV1(events: readonly RunRecordEventV2[]) {
  const refusals: string[] = [];
  const starts = events.filter((event) => event.type === "CALL_STARTED");
  const nextAttemptNumber = Math.max(0, ...starts.map((event) => event.attemptNumber)) + 1;
  let stage: ClaimResumeStageV1 | null = null;
  const positions = (type: RunRecordEventV2["type"]) =>
    events.flatMap((event, index) => (event.type === type ? [index] : []));
  const one = (type: RunRecordEventV2["type"], required = true): number => {
    const found = positions(type);
    if (found.length > 1 || (required && found.length !== 1))
      refusals.push(`Expected ${required ? "one" : "at most one"} ${type} checkpoint`);
    return found[0] ?? -1;
  };
  if (one("RUN_STARTED") !== 0) refusals.push(CLAIM_RESUME_REFUSAL_V1.RUN_START_NOT_FIRST);
  if (positions("RUN_COMPLETED").length) refusals.push(CLAIM_RESUME_REFUSAL_V1.RUN_COMPLETED);
  if (positions("BUDGET_EXHAUSTED").length || positions("TOKEN_BUDGET_EXHAUSTED").length)
    refusals.push(CLAIM_RESUME_REFUSAL_V1.BUDGET_EXHAUSTED);
  // Deliberately broader than V1's rate-limit-only gate (ADR-018): every artifact this resume
  // replays is digest-revalidated against the frozen inputs below, so a deterministic failure
  // (a rejected request, a schema mismatch) costs at most one wasted attempt on re-resume rather
  // than corrupting state. Only uncertain transport (unknown whether the provider was ever
  // reached) stays categorically ineligible.
  const terminal = events.at(-1);
  if (terminal?.type !== "RUN_FAILED" || terminal.terminalState !== "FAILED")
    refusals.push(CLAIM_RESUME_REFUSAL_V1.NOT_TERMINALLY_FAILED);
  let pending: Extract<RunRecordEventV2, { type: "CALL_STARTED" }> | null = null;
  let expectedAttempt = 1;
  let failedBoundary = false;
  for (const event of events) {
    if (event.type === "RUN_FAILED") {
      if (failedBoundary) refusals.push(CLAIM_RESUME_REFUSAL_V1.DUPLICATE_TERMINAL_FAILURE);
      failedBoundary = true;
    } else if (event.type === "RUN_RESUMED") {
      if (!failedBoundary) refusals.push(CLAIM_RESUME_REFUSAL_V1.MISSING_FAILURE_BOUNDARY);
      failedBoundary = false;
    } else if (failedBoundary && event.type !== "RUN_RECORD_TAIL_RECOVERED")
      refusals.push(CLAIM_RESUME_REFUSAL_V1.MISSING_RESUME_BOUNDARY);
    if (event.type === "CALL_STARTED") {
      if (
        pending ||
        event.attemptNumber !== expectedAttempt ||
        !Number.isSafeInteger(event.attemptNumber)
      )
        refusals.push(CLAIM_RESUME_REFUSAL_V1.NONCONTIGUOUS_ATTEMPTS);
      expectedAttempt++;
      pending = event;
    } else if (event.type === "CALL_SUCCEEDED" || event.type === "CALL_FAILED") {
      if (
        !pending ||
        pending.attemptNumber !== event.attemptNumber ||
        pending.stage !== event.stage
      )
        refusals.push(CLAIM_RESUME_REFUSAL_V1.UNMATCHED_CALL_OUTCOME);
      pending = null;
    }
  }
  if (pending) refusals.push(CLAIM_RESUME_REFUSAL_V1.UNFINISHED_CALL);
  const preliminary = one("PRELIMINARY_PERSISTED");
  const claims = one("PRELIMINARY_CLAIMS_PERSISTED");
  const blind = one("FINDING_VERIFICATION_PERSISTED");
  const authorEvents = [...positions("AUTHOR_DELIVERED"), ...positions("AUTHOR_CONTEXT_RELEASED")];
  const author = authorEvents[0] ?? -1;
  if (
    authorEvents.length !== 1 ||
    !(preliminary > 0 && claims > preliminary && blind > claims && author > blind)
  )
    refusals.push(CLAIM_RESUME_REFUSAL_V1.AUTHOR_RELEASE_ORDER);
  const candidate = one("FINAL_CANDIDATE_PERSISTED", false);
  const verification = one("FINAL_CLAIM_VERIFICATION_PERSISTED", false);
  const report = one("FINAL_REPORT_PERSISTED", false);
  if (candidate >= 0 && candidate <= author)
    refusals.push(CLAIM_RESUME_REFUSAL_V1.CANDIDATE_BEFORE_AUTHOR);
  if (verification >= 0 && !(candidate >= 0 && verification > candidate))
    refusals.push(CLAIM_RESUME_REFUSAL_V1.VERIFICATION_BEFORE_CANDIDATE);
  if (report >= 0 && !(verification >= 0 && report > verification))
    refusals.push(CLAIM_RESUME_REFUSAL_V1.REPORT_BEFORE_VERIFICATION);
  const succeededBefore = (index: number, callStage: string, attempt?: number) =>
    events
      .slice(0, index)
      .some(
        (event) =>
          event.type === "CALL_SUCCEEDED" &&
          event.stage === callStage &&
          (attempt === undefined || event.attemptNumber === attempt),
      );
  for (const [index, event] of events.entries()) {
    if (event.type === "PROVIDER_RETRY_REQUESTED") {
      const previous = events[index - 1];
      const next = events[index + 1];
      if (
        previous?.type !== "CALL_FAILED" ||
        previous.stage !== event.stage ||
        previous.attemptNumber !== event.failedAttemptNumber ||
        next?.type !== "CALL_STARTED" ||
        next.stage !== event.stage ||
        next.attemptNumber !== event.retryAttemptNumber ||
        event.retryAttemptNumber !== event.failedAttemptNumber + 1 ||
        event.retriesUsed !== 1 ||
        event.maxRetries !== 1
      )
        refusals.push(CLAIM_RESUME_REFUSAL_V1.RETRY_NOT_ADJACENT);
    }
    if (
      event.type === "PRELIMINARY_PERSISTED" &&
      !succeededBefore(index, "PRELIMINARY", event.acceptedAttemptNumber)
    )
      refusals.push(CLAIM_RESUME_REFUSAL_V1.PRELIMINARY_CHECKPOINT_UNSUPPORTED);
    if (
      event.type === "FINDING_VERIFICATION_PERSISTED" ||
      event.type === "FINAL_CLAIM_VERIFICATION_PERSISTED"
    ) {
      const callStage =
        event.type === "FINDING_VERIFICATION_PERSISTED"
          ? "FINDING_VERIFICATION"
          : "FINAL_CLAIM_VERIFICATION";
      if (
        event.providerCall
          ? event.acceptedAttemptNumber === undefined ||
            event.responseArtifact === null ||
            !succeededBefore(index, callStage, event.acceptedAttemptNumber)
          : event.acceptedAttemptNumber !== undefined || event.responseArtifact !== null
      )
        refusals.push(CLAIM_RESUME_REFUSAL_V1.VERIFICATION_PROVENANCE_MISMATCH);
    }
    if (event.type === "CALL_STARTED") {
      if (event.stage === "PRELIMINARY" && index >= preliminary)
        refusals.push(CLAIM_RESUME_REFUSAL_V1.PRELIMINARY_CALL_AFTER_PERSISTENCE);
      if (event.stage === "FINDING_VERIFICATION" && !(index > claims && index < blind))
        refusals.push(CLAIM_RESUME_REFUSAL_V1.BLIND_CALL_OUT_OF_BOUNDS);
      if (event.stage === "FINAL" && !(index > author && (candidate < 0 || index < candidate)))
        refusals.push(CLAIM_RESUME_REFUSAL_V1.FINAL_CALL_OUT_OF_BOUNDS);
      if (
        event.stage === "FINAL_CLAIM_VERIFICATION" &&
        !(candidate >= 0 && index > candidate && (verification < 0 || index < verification))
      )
        refusals.push(CLAIM_RESUME_REFUSAL_V1.POST_AUTHOR_CALL_NEEDS_CANDIDATE);
    }
  }
  if (candidate >= 0 && !succeededBefore(candidate, "FINAL"))
    refusals.push(CLAIM_RESUME_REFUSAL_V1.CANDIDATE_UNSUPPORTED);
  const lastCall = events.findLast(
    (event) => event.type === "CALL_SUCCEEDED" || event.type === "CALL_FAILED",
  );
  if (verification >= 0) {
    if (events.slice(verification + 1).some((event) => event.type === "CALL_STARTED"))
      refusals.push(CLAIM_RESUME_REFUSAL_V1.PROJECTION_AFTER_CALL);
    stage = "PROJECTION";
  } else if (lastCall?.type === "CALL_FAILED" && lastCall.error.code !== "TRANSPORT_UNCERTAIN") {
    if (lastCall.stage === "FINAL" && candidate < 0) stage = "FINAL";
    else if (lastCall.stage === "FINAL_CLAIM_VERIFICATION" && candidate >= 0)
      stage = "FINAL_CLAIM_VERIFICATION";
  }
  if (stage === null) refusals.push(CLAIM_RESUME_REFUSAL_V1.NO_RESUMABLE_CHECKPOINT);
  return {
    eligible: refusals.length === 0,
    stage: refusals.length === 0 ? stage : null,
    refusals: [...new Set(refusals)],
    nextAttemptNumber,
  };
}
