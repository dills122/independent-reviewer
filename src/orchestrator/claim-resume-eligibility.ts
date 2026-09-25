import type { RunRecordEventV2 } from "../contracts/run-record-v2.js";

export type ClaimResumeStageV1 = "FINAL" | "FINAL_CLAIM_VERIFICATION" | "PROJECTION";

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
  if (one("RUN_STARTED") !== 0) refusals.push("Run start must be first");
  if (positions("RUN_COMPLETED").length) refusals.push("Completed runs cannot resume");
  if (positions("BUDGET_EXHAUSTED").length) refusals.push("Budget-exhausted runs cannot resume");
  const terminal = events.at(-1);
  if (terminal?.type !== "RUN_FAILED" || terminal.terminalState !== "FAILED")
    refusals.push("Resume requires an explicit non-uncertain failure");
  let pending: Extract<RunRecordEventV2, { type: "CALL_STARTED" }> | null = null;
  let expectedAttempt = 1;
  let failedBoundary = false;
  for (const event of events) {
    if (event.type === "RUN_FAILED") {
      if (failedBoundary) refusals.push("Duplicate terminal failure without resume boundary");
      failedBoundary = true;
    } else if (event.type === "RUN_RESUMED") {
      if (!failedBoundary) refusals.push("Resume requires a preceding failure boundary");
      failedBoundary = false;
    } else if (failedBoundary && event.type !== "RUN_RECORD_TAIL_RECOVERED")
      refusals.push("Events after failure require a resume boundary");
    if (event.type === "CALL_STARTED") {
      if (
        pending ||
        event.attemptNumber !== expectedAttempt ||
        !Number.isSafeInteger(event.attemptNumber)
      )
        refusals.push("Call attempts must be contiguous and sequential");
      expectedAttempt++;
      pending = event;
    } else if (event.type === "CALL_SUCCEEDED" || event.type === "CALL_FAILED") {
      if (
        !pending ||
        pending.attemptNumber !== event.attemptNumber ||
        pending.stage !== event.stage
      )
        refusals.push("Call result has no matching active attempt");
      pending = null;
    }
  }
  if (pending) refusals.push("Unfinished call has uncertain transport");
  const preliminary = one("PRELIMINARY_PERSISTED");
  const claims = one("PRELIMINARY_CLAIMS_PERSISTED");
  const blind = one("FINDING_VERIFICATION_PERSISTED");
  const authorEvents = [...positions("AUTHOR_DELIVERED"), ...positions("AUTHOR_CONTEXT_RELEASED")];
  const author = authorEvents[0] ?? -1;
  if (
    authorEvents.length !== 1 ||
    !(preliminary > 0 && claims > preliminary && blind > claims && author > blind)
  )
    refusals.push("Blind persistence must precede author release exactly once");
  const candidate = one("FINAL_CANDIDATE_PERSISTED", false);
  const verification = one("FINAL_CLAIM_VERIFICATION_PERSISTED", false);
  const report = one("FINAL_REPORT_PERSISTED", false);
  if (candidate >= 0 && candidate <= author)
    refusals.push("Final candidate must follow author release");
  if (verification >= 0 && !(candidate >= 0 && verification > candidate))
    refusals.push("Final verification requires an earlier candidate checkpoint");
  if (report >= 0 && !(verification >= 0 && report > verification))
    refusals.push("Final report requires an earlier verification checkpoint");
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
        refusals.push("Provider retry requires adjacent matching failure and call");
    }
    if (
      event.type === "PRELIMINARY_PERSISTED" &&
      !succeededBefore(index, "PRELIMINARY", event.acceptedAttemptNumber)
    )
      refusals.push("Preliminary checkpoint lacks a successful call");
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
        refusals.push("Verification checkpoint provider provenance mismatch");
    }
    if (event.type === "CALL_STARTED") {
      if (event.stage === "PRELIMINARY" && index >= preliminary)
        refusals.push("Preliminary call after persisted assessment");
      if (event.stage === "FINDING_VERIFICATION" && !(index > claims && index < blind))
        refusals.push("Blind verification crossed its persistence boundary");
      if (event.stage === "FINAL" && !(index > author && (candidate < 0 || index < candidate)))
        refusals.push("Final call crossed its author or candidate boundary");
      if (
        event.stage === "FINAL_CLAIM_VERIFICATION" &&
        !(candidate >= 0 && index > candidate && (verification < 0 || index < verification))
      )
        refusals.push("Post-author call requires a persisted candidate");
    }
  }
  if (candidate >= 0 && !succeededBefore(candidate, "FINAL"))
    refusals.push("Final candidate lacks a successful final call");
  const lastCall = events.findLast(
    (event) => event.type === "CALL_SUCCEEDED" || event.type === "CALL_FAILED",
  );
  if (verification >= 0) {
    if (events.slice(verification + 1).some((event) => event.type === "CALL_STARTED"))
      refusals.push("Local projection cannot follow more provider calls");
    stage = "PROJECTION";
  } else if (lastCall?.type === "CALL_FAILED" && lastCall.error.code !== "TRANSPORT_UNCERTAIN") {
    if (lastCall.stage === "FINAL" && candidate < 0) stage = "FINAL";
    else if (lastCall.stage === "FINAL_CLAIM_VERIFICATION" && candidate >= 0)
      stage = "FINAL_CLAIM_VERIFICATION";
  }
  if (stage === null) refusals.push("No resumable failed call or local projection checkpoint");
  return {
    eligible: refusals.length === 0,
    stage: refusals.length === 0 ? stage : null,
    refusals: [...new Set(refusals)],
    nextAttemptNumber,
  };
}
