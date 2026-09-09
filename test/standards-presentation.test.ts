import assert from "node:assert/strict";
import { test } from "node:test";
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
  assert.match(
    formatRunCost([{ type: "CALL_SUCCEEDED", usage: { cost: 0.001 } }, { type: "CALL_FAILED" }]),
    /\$0\.001000; 1 call\(s\) have unknown cost/,
  );
});
