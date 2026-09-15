import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertNoEvaluationOracleLeakV1 } from "../../evaluation/oracle-leak.js";
import { sha256BytesDigestV1 } from "../../src/contracts/json-document.js";

const hiddenBytes = Buffer.from("assert.equal(chargeAmount([{ price: 1 }]), 100);", "utf8");
const hiddenDigest = sha256BytesDigestV1(hiddenBytes);

const oracle = {
  expectedRoots: [
    {
      rootId: "root_double_conversion",
      description: "Checkout converts cents a second time.",
    },
  ],
  expectedUncertainties: [],
  forbiddenLabels: ["known-bug-double-conversion"],
  artifacts: [{ reference: "oracles/hidden.test.mjs", digest: hiddenDigest, bytes: hiddenBytes }],
};

describe("evaluation oracle leak checking", () => {
  it("checks every available reviewer stage without rejecting ordinary messages", () => {
    assert.doesNotThrow(() =>
      assertNoEvaluationOracleLeakV1({
        oracle,
        messages: [
          { stage: "PRELIMINARY", reference: "request.json", content: { text: "Review change." } },
          {
            stage: "PRELIMINARY_REPAIR",
            reference: "repair.json",
            content: { text: "Repair JSON." },
          },
          {
            stage: "FINDING_VERIFICATION",
            reference: "verify.json",
            content: { text: "Check claim." },
          },
          { stage: "FINAL", reference: "final.json", content: { text: "Reconcile author input." } },
          {
            stage: "FINAL_REPAIR",
            reference: "final-repair.json",
            content: { text: "Repair JSON." },
          },
          { stage: "TOOL_RESULT", reference: "tool.json", content: { path: "checkout.mjs" } },
        ],
      }),
    );
  });

  it("detects a hidden artifact renamed before transmission", () => {
    assert.throws(
      () =>
        assertNoEvaluationOracleLeakV1({
          oracle,
          messages: [
            {
              stage: "PRELIMINARY",
              reference: "evidence/regression.mjs",
              content: "renamed attachment",
              bytes: hiddenBytes,
            },
          ],
        }),
      /oracle artifact.*PRELIMINARY/i,
    );
  });

  it("detects copied oracle content embedded in reconciliation metadata", () => {
    assert.throws(
      () =>
        assertNoEvaluationOracleLeakV1({
          oracle,
          messages: [
            {
              stage: "FINAL",
              reference: "author.json",
              content: { metadata: { copiedFixture: hiddenBytes.toString("utf8") } },
            },
          ],
        }),
      /oracle content.*FINAL/i,
    );
    assert.throws(
      () =>
        assertNoEvaluationOracleLeakV1({
          oracle,
          messages: [
            {
              stage: "FINAL_REPAIR",
              reference: "repair.json",
              content: { attachment: hiddenBytes.toString("base64") },
            },
          ],
        }),
      /oracle content.*FINAL_REPAIR/i,
    );
  });

  it("detects evaluator labels and root identities in nested metadata keys", () => {
    assert.throws(
      () =>
        assertNoEvaluationOracleLeakV1({
          oracle,
          messages: [
            {
              stage: "TOOL_RESULT",
              reference: "search.json",
              content: { metadata: { "known-bug-double-conversion": true } },
            },
          ],
        }),
      /forbidden evaluator label.*TOOL_RESULT/i,
    );
    assert.throws(
      () =>
        assertNoEvaluationOracleLeakV1({
          oracle,
          messages: [
            {
              stage: "FINDING_VERIFICATION",
              reference: "verify.json",
              content: { source: { rootId: "root_double_conversion" } },
            },
          ],
        }),
      /oracle root.*FINDING_VERIFICATION/i,
    );
  });

  it("detects oracle text fragmented across canonical metadata values", () => {
    assert.throws(
      () =>
        assertNoEvaluationOracleLeakV1({
          oracle,
          messages: [
            {
              stage: "FINAL",
              reference: "metadata.json",
              content: {
                a: "Checkout converts cents ",
                b: "a second time.",
              },
            },
          ],
        }),
      /oracle root.*FINAL/i,
    );

    const encoded = hiddenBytes.toString("base64");
    assert.throws(
      () =>
        assertNoEvaluationOracleLeakV1({
          oracle,
          messages: [
            {
              stage: "TOOL_RESULT",
              reference: "metadata.json",
              content: { a: encoded.slice(0, 20), b: encoded.slice(20) },
            },
          ],
        }),
      /oracle content.*TOOL_RESULT/i,
    );
  });

  it("does not join reordered or interrupted benign fragments into a leak", () => {
    assert.doesNotThrow(() =>
      assertNoEvaluationOracleLeakV1({
        oracle,
        messages: [
          {
            stage: "FINAL",
            reference: "metadata.json",
            content: {
              a: "a second time.",
              b: "Independent evaluator note.",
              c: "Checkout converts cents ",
            },
          },
        ],
      }),
    );
  });
});
