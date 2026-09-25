import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assembleClaimVerificationV1,
  assertClaimVerificationV1,
} from "../../src/contracts/claim-verification.js";
import { assembleReviewClaimSetV1 } from "../../src/contracts/review-claims.js";

const binding = {
  snapshotDigest: { algorithm: "SHA256" as const, value: "a".repeat(64) },
  briefDigest: { algorithm: "SHA256" as const, value: "b".repeat(64) },
};

function violation(assertion = "Empty pages return stale entries.") {
  return {
    mode: "REQUIREMENTS" as const,
    kind: "VIOLATION" as const,
    obligations: [{ canonicalInputId: "input_requirement", ruleId: null }],
    scenario: {
      preconditions: "An empty page is requested.",
      action: "Read the page.",
      observedResult: "Stale entries are returned.",
      expectedResult: "An empty page is returned.",
    },
    evidence: [
      {
        path: "src/page.ts",
        anchor: "LINE_RANGE" as const,
        side: "HEAD" as const,
        startLine: 8,
        endLine: 9,
      },
    ],
    assertion,
    correction: "Return an empty array.",
    effect: { kind: "REQUIREMENTS" as const, severity: "P1" as const },
  };
}

function assessment() {
  return {
    kind: "VIOLATION",
    obligationStatus: "APPLICABLE",
    scenarioStatus: "IN_SCOPE",
    behaviorStatus: "SUPPORTED",
    correctionStatus: "SUPPORTED",
    duplicateOf: null,
    rationale: "The captured branch returns stale entries for an empty page.",
  };
}

function candidate(assessments: unknown[] = [assessment()]) {
  return { schemaVersion: 1, stage: "FINDING_VERIFICATION", assessments };
}

const targets = () => assembleReviewClaimSetV1(binding, [violation()]);
const catalog = () => assembleReviewClaimSetV1(binding, []);

describe("bound claim verification", () => {
  it("binds ordered judgments to target and carried sets in both stages", () => {
    const targetSet = targets();
    for (const stage of ["FINDING_VERIFICATION", "FINAL_CLAIM_VERIFICATION"]) {
      const result = assembleClaimVerificationV1(targetSet, catalog(), { ...candidate(), stage });
      assert.equal(result.stage, stage);
      assert.deepEqual(result.snapshotDigest, binding.snapshotDigest);
      assert.deepEqual(result.briefDigest, binding.briefDigest);
      assert.equal(result.assessments[0]?.claimId, targetSet.claims[0]?.claimId);
      assert.equal(result.assessments[0]?.status, "DEMONSTRATED");
      assert.equal(result.assessments[0]?.correctionStatus, "SUPPORTED");
      assert.doesNotThrow(() => assertClaimVerificationV1(result, targetSet, catalog()));
    }
  });

  it("rejects out-of-domain scenarios even when alleged behavior is supported", () => {
    const result = assembleClaimVerificationV1(
      targets(),
      catalog(),
      candidate([{ ...assessment(), scenarioStatus: "OUT_OF_SCOPE" }]),
    );
    assert.equal(result.assessments[0]?.status, "REJECTED");
  });

  it("demonstrates applicable input-independent rules without an input scenario", () => {
    const result = assembleClaimVerificationV1(
      targets(),
      catalog(),
      candidate([{ ...assessment(), scenarioStatus: "NO_INPUT_SCENARIO" }]),
    );
    assert.equal(result.assessments[0]?.status, "DEMONSTRATED");
  });

  it("preserves unsupported obligation and unresolved behavior as uncertainty", () => {
    for (const changed of [
      { obligationStatus: "ABSENT_OR_INAPPLICABLE" },
      { obligationStatus: "UNDETERMINED" },
      { scenarioStatus: "UNDETERMINED" },
      { behaviorStatus: "NOT_ESTABLISHED" },
    ]) {
      const result = assembleClaimVerificationV1(
        targets(),
        catalog(),
        candidate([{ ...assessment(), ...changed }]),
      );
      assert.equal(result.assessments[0]?.status, "INCONCLUSIVE");
    }
    const refuted = assembleClaimVerificationV1(
      targets(),
      catalog(),
      candidate([{ ...assessment(), behaviorStatus: "REFUTED" }]),
    );
    assert.equal(refuted.assessments[0]?.status, "REJECTED");
  });

  it("keeps correction judgment independent from demonstrated defect", () => {
    for (const correctionStatus of ["REJECTED", "INCONCLUSIVE"]) {
      const result = assembleClaimVerificationV1(
        targets(),
        catalog(),
        candidate([{ ...assessment(), correctionStatus }]),
      );
      assert.equal(result.assessments[0]?.status, "DEMONSTRATED");
      assert.equal(result.assessments[0]?.correctionStatus, correctionStatus);
    }
  });

  it("requires exact count, target kind, and bounded canonical rationale", () => {
    for (const input of [
      candidate([]),
      candidate([assessment(), assessment()]),
      candidate([
        {
          kind: "BLOCKING_UNCERTAINTY",
          status: "DEMONSTRATED",
          correctionStatus: null,
          duplicateOf: null,
          rationale: "A prerequisite is missing.",
        },
      ]),
      ...["", " Leading", "Two\nlines", "a".repeat(401)].map((rationale) =>
        candidate([{ ...assessment(), rationale }]),
      ),
      candidate([{ ...assessment(), correctionStatus: null }]),
      { ...candidate(), summary: "Unbound allegation." },
    ])
      assert.throws(() => assembleClaimVerificationV1(targets(), catalog(), input));
  });

  it("rejects tampered digests, ordered identities, and correction shape", () => {
    const targetSet = assembleReviewClaimSetV1(binding, [
      violation(),
      violation("A different root cause."),
    ]);
    const result = assembleClaimVerificationV1(
      targetSet,
      catalog(),
      candidate([assessment(), assessment()]),
    );
    const first = result.assessments[0];
    assert.ok(first);
    for (const record of [
      { ...result, targetSetDigest: binding.snapshotDigest },
      { ...result, catalogSetDigest: binding.snapshotDigest },
      { ...result, snapshotDigest: binding.briefDigest },
      { ...result, briefDigest: binding.snapshotDigest },
      { ...result, assessments: [...result.assessments].reverse() },
      { ...result, assessments: [first] },
      { ...result, assessments: [{ ...first, correctionStatus: null }, result.assessments[1]] },
    ])
      assert.throws(() => assertClaimVerificationV1(record, targetSet, catalog()));
  });

  it("refuses binding mismatch and target/catalog overlap", () => {
    const otherBinding = { ...binding, briefDigest: binding.snapshotDigest };
    assert.throws(() =>
      assembleClaimVerificationV1(
        targets(),
        assembleReviewClaimSetV1(otherBinding, []),
        candidate(),
      ),
    );
    assert.throws(() => assembleClaimVerificationV1(targets(), targets(), candidate()));
  });

  it("preserves adverse standards-state judgments without granting correction authority", () => {
    const core = {
      ...violation(),
      mode: "STANDARDS" as const,
      kind: "STANDARD_STATUS" as const,
      obligations: [{ canonicalInputId: "input_standard", ruleId: "rule_paging" }],
      scenario: null,
      correction: null,
      effect: {
        kind: "STANDARD_STATUS" as const,
        ruleId: "rule_paging",
        status: "UNASSESSED" as const,
        conflictingRuleIds: [],
      },
    };
    const targetSet = assembleReviewClaimSetV1(binding, [core]);
    for (const status of ["DEMONSTRATED", "REJECTED", "INCONCLUSIVE"]) {
      const judgment = {
        kind: "STANDARD_STATUS",
        status,
        correctionStatus: null,
        duplicateOf: null,
        rationale: "The selected rule cannot be assessed from frozen evidence.",
      };
      const result = assembleClaimVerificationV1(targetSet, catalog(), candidate([judgment]));
      assert.equal(result.assessments[0]?.status, status);
      assert.equal(result.assessments[0]?.correctionStatus, null);
      assert.doesNotThrow(() => assertClaimVerificationV1(result, targetSet, catalog()));
      assert.throws(() =>
        assembleClaimVerificationV1(
          targetSet,
          catalog(),
          candidate([{ ...judgment, correctionStatus: "SUPPORTED" }]),
        ),
      );
    }
  });
});

describe("verified duplicate references", () => {
  it("resolves an earlier demonstrated target into its exact claim identity", () => {
    const targetSet = assembleReviewClaimSetV1(binding, [
      violation(),
      violation("A duplicate wording of the root cause."),
    ]);
    const result = assembleClaimVerificationV1(
      targetSet,
      catalog(),
      candidate([assessment(), { ...assessment(), duplicateOf: { source: "TARGET", index: 0 } }]),
    );
    assert.equal(result.assessments[1]?.duplicateOf, targetSet.claims[0]?.claimId);
    assert.doesNotThrow(() => assertClaimVerificationV1(result, targetSet, catalog()));
  });

  it("resolves carried references and rejects unknown, self, or forward references", () => {
    const carried = assembleReviewClaimSetV1(binding, [
      violation("Previously demonstrated root cause."),
    ]);
    const targetSet = targets();
    const result = assembleClaimVerificationV1(
      targetSet,
      carried,
      candidate([{ ...assessment(), duplicateOf: { source: "CARRIED", index: 0 } }]),
    );
    assert.equal(result.assessments[0]?.duplicateOf, carried.claims[0]?.claimId);
    assert.doesNotThrow(() => assertClaimVerificationV1(result, targetSet, carried));
    for (const duplicateOf of [
      { source: "TARGET", index: 0 },
      { source: "TARGET", index: 1 },
      { source: "CARRIED", index: 1 },
      { source: "CARRIED", index: -1 },
    ])
      assert.throws(() =>
        assembleClaimVerificationV1(
          targetSet,
          carried,
          candidate([{ ...assessment(), duplicateOf }]),
        ),
      );
    const first = result.assessments[0];
    assert.ok(first);
    assert.throws(() =>
      assertClaimVerificationV1(
        { ...result, assessments: [{ ...first, duplicateOf: `claim_${"0".repeat(64)}` }] },
        targetSet,
        carried,
      ),
    );
  });

  it("rejects duplication when either target judgment is not demonstrated", () => {
    const targetSet = assembleReviewClaimSetV1(binding, [
      violation(),
      violation("Another root cause."),
    ]);
    const duplicate = { ...assessment(), duplicateOf: { source: "TARGET", index: 0 } };
    for (const behaviorStatus of ["REFUTED", "NOT_ESTABLISHED"]) {
      assert.throws(() =>
        assembleClaimVerificationV1(
          targetSet,
          catalog(),
          candidate([{ ...assessment(), behaviorStatus }, duplicate]),
        ),
      );
      assert.throws(() =>
        assembleClaimVerificationV1(
          targetSet,
          catalog(),
          candidate([assessment(), { ...duplicate, behaviorStatus }]),
        ),
      );
    }
  });

  it("rejects cross-kind and cross-mode carried duplicate references", () => {
    const uncertainty = {
      ...violation(),
      kind: "BLOCKING_UNCERTAINTY" as const,
      scenario: null,
      correction: null,
      effect: { kind: "BLOCKING_UNCERTAINTY" as const },
    };
    const standards = {
      ...violation(),
      mode: "STANDARDS" as const,
      obligations: [{ canonicalInputId: "input_standard", ruleId: "rule_paging" }],
      effect: { kind: "STANDARDS" as const, enforcement: "REQUIRED" as const },
    };
    for (const core of [uncertainty, standards]) {
      const carried = assembleReviewClaimSetV1(binding, [core]);
      assert.throws(() =>
        assembleClaimVerificationV1(
          targets(),
          carried,
          candidate([{ ...assessment(), duplicateOf: { source: "CARRIED", index: 0 } }]),
        ),
      );
    }
  });

  it("accepts nonviolation judgments only with null correction and no duplicates", () => {
    const core = {
      ...violation(),
      kind: "BLOCKING_UNCERTAINTY" as const,
      scenario: null,
      correction: null,
      effect: { kind: "BLOCKING_UNCERTAINTY" as const },
    };
    const targetSet = assembleReviewClaimSetV1(binding, [core]);
    const judgment = {
      kind: "BLOCKING_UNCERTAINTY",
      status: "INCONCLUSIVE",
      correctionStatus: null,
      duplicateOf: null,
      rationale: "Missing prerequisite prevents a conclusion.",
    };
    const result = assembleClaimVerificationV1(targetSet, catalog(), candidate([judgment]));
    assert.equal(result.assessments[0]?.status, "INCONCLUSIVE");
    assert.equal(result.assessments[0]?.correctionStatus, null);
    assert.doesNotThrow(() => assertClaimVerificationV1(result, targetSet, catalog()));
    const carried = assembleReviewClaimSetV1(binding, [
      { ...core, assertion: "Another missing prerequisite." },
    ]);
    assert.throws(() =>
      assembleClaimVerificationV1(
        targetSet,
        carried,
        candidate([
          { ...judgment, status: "DEMONSTRATED", duplicateOf: { source: "CARRIED", index: 0 } },
        ]),
      ),
    );
    assert.throws(() =>
      assembleClaimVerificationV1(
        targetSet,
        catalog(),
        candidate([{ ...judgment, correctionStatus: "SUPPORTED" }]),
      ),
    );
  });
});
