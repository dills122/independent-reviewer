import assert from "node:assert/strict";
import { test } from "node:test";
import { RunRecordEventV1Schema } from "../src/contracts/run-record.js";
import { formatRunCost, terminalText } from "../src/cli/review-output.js";
import { emitReviewProgress, withReviewProgress } from "../src/orchestrator/progress.js";

test("progress observers cannot interrupt work and receive no author or raw response data", async () => {
  let completed = 0;
  await withReviewProgress(
    (event) => {
      assert.deepEqual(event, { type: "CALL_STARTED", stage: "FINAL" });
      throw new Error("broken UI");
    },
    async () => {
      emitReviewProgress({
        type: "CALL_STARTED",
        stage: "FINAL",
        authorPacket: "private",
        rawContent: "private",
      });
      completed++;
    },
  );
  assert.equal(completed, 1);
});
test("terminal output strips control sequences and labels unknown failed-call cost", () => {
  assert.equal(terminalText("\u001b[2JTitle\nForged status"), "Title Forged status");
  // Built through the contract, so a change to the run-record event shape reaches this test
  // rather than leaving it asserting against a payload the orchestrator no longer writes.
  const at = "2026-09-12T00:00:00.000Z";
  const priced = RunRecordEventV1Schema.parse({
    schemaVersion: 1,
    at,
    type: "CALL_SUCCEEDED",
    attemptNumber: 1,
    stage: "PRELIMINARY",
    durationMs: 10,
    responseId: null,
    returnedModel: null,
    returnedProvider: null,
    usage: { promptTokens: null, completionTokens: null, totalTokens: null, cost: 0.001 },
  });
  const unpriced = RunRecordEventV1Schema.parse({
    schemaVersion: 1,
    at,
    type: "CALL_FAILED",
    attemptNumber: 2,
    stage: "FINAL",
    durationMs: 10,
    error: { name: "ProviderCallError", code: "PROVIDER_ERROR", message: "429" },
  });

  assert.match(formatRunCost([priced, unpriced]), /\$0\.001000; 1 call\(s\) have unknown cost/);
});
