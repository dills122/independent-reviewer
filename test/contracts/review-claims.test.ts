import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalizeJson, digestCanonicalJson } from "../../src/contracts/canonical-json.js";
import {
  assembleReviewClaimSetV1,
  ClaimIdentityPreimageV1Schema,
  identifyReviewClaimV1,
  ReviewClaimCoreV1Schema,
  ReviewClaimSetV1Schema,
} from "../../src/contracts/review-claims.js";

const binding = {
  snapshotDigest: { algorithm: "SHA256" as const, value: "a".repeat(64) },
  briefDigest: { algorithm: "SHA256" as const, value: "b".repeat(64) },
};

function violation() {
  return {
    mode: "REQUIREMENTS" as const,
    kind: "VIOLATION" as const,
    obligations: [{ canonicalInputId: "input_requirement", ruleId: null }],
    scenario: {
      preconditions: "An empty page is requested.",
      action: "Read the next page.",
      observedResult: "The previous page is returned.",
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
    assertion: "Empty pages return stale entries.",
    correction: "Return an empty array when the page has no entries.",
    effect: { kind: "REQUIREMENTS" as const, severity: "P1" as const },
  };
}

function uncertainty() {
  return {
    ...violation(),
    kind: "BLOCKING_UNCERTAINTY" as const,
    scenario: null,
    correction: null,
    effect: { kind: "BLOCKING_UNCERTAINTY" as const },
  };
}

function standardStatus() {
  return {
    ...uncertainty(),
    mode: "STANDARDS" as const,
    kind: "STANDARD_STATUS" as const,
    obligations: [{ canonicalInputId: "input_standard", ruleId: "rule_paging" }],
    effect: {
      kind: "STANDARD_STATUS" as const,
      ruleId: "rule_paging",
      status: "UNASSESSED" as const,
      conflictingRuleIds: [] as string[],
    },
  };
}

describe("content-bound review claims", () => {
  it("hashes the strict versioned identity envelope", () => {
    const core = violation();
    const preimage = {
      schemaVersion: 1,
      type: "REVIEW_CLAIM_IDENTITY",
      ...binding,
      claimCore: core,
    };
    assert.deepEqual(ClaimIdentityPreimageV1Schema.parse(preimage), preimage);
    assert.deepEqual(identifyReviewClaimV1(binding, core), {
      claimId: `claim_${digestCanonicalJson(preimage).value}`,
      core,
    });
    assert.equal(
      ClaimIdentityPreimageV1Schema.safeParse({ ...preimage, schemaVersion: 2 }).success,
      false,
    );
    assert.equal(
      ClaimIdentityPreimageV1Schema.safeParse({ ...preimage, type: "CLAIM" }).success,
      false,
    );
    assert.equal(
      ClaimIdentityPreimageV1Schema.safeParse({ ...preimage, title: "Presentation" }).success,
      false,
    );
  });

  it("preserves identity across object-key order and repeated assembly", () => {
    const core = violation();
    const reordered = Object.fromEntries(Object.entries(core).reverse());
    assert.equal(
      identifyReviewClaimV1(binding, ReviewClaimCoreV1Schema.parse(reordered)).claimId,
      identifyReviewClaimV1(binding, core).claimId,
    );
    assert.equal(
      canonicalizeJson(assembleReviewClaimSetV1(binding, [core, uncertainty()])),
      canonicalizeJson(assembleReviewClaimSetV1(binding, [uncertainty(), core])),
    );
  });

  it("binds both frozen snapshot and brief independently", () => {
    const core = violation();
    const original = identifyReviewClaimV1(binding, core).claimId;
    for (const field of ["snapshotDigest", "briefDigest"] as const) {
      const changed = {
        ...binding,
        [field]: { algorithm: "SHA256" as const, value: "c".repeat(64) },
      };
      assert.notEqual(identifyReviewClaimV1(changed, core).claimId, original, field);
    }
  });

  it("changes identity for every material semantic carrier", () => {
    const core = violation();
    const changes = [
      { ...core, obligations: [{ canonicalInputId: "input_other", ruleId: null }] },
      ...Object.keys(core.scenario).map((key) => ({
        ...core,
        scenario: { ...core.scenario, [key]: "Changed premise." },
      })),
      { ...core, assertion: "Nonempty pages return stale entries." },
      { ...core, correction: "Reject empty page requests." },
      { ...core, evidence: [{ ...core.evidence[0], startLine: 7 }] },
      { ...core, evidence: [{ ...core.evidence[0], side: "BASE" }] },
      { ...core, effect: { kind: "REQUIREMENTS", severity: "P2" } },
      uncertainty(),
      standardStatus(),
    ];
    const original = identifyReviewClaimV1(binding, core).claimId;
    for (const changed of changes) {
      assert.notEqual(
        identifyReviewClaimV1(binding, ReviewClaimCoreV1Schema.parse(changed)).claimId,
        original,
      );
    }
  });

  it("binds standards rule, enforcement, and adverse state", () => {
    const core = {
      ...violation(),
      mode: "STANDARDS" as const,
      obligations: standardStatus().obligations,
      effect: { kind: "STANDARDS" as const, enforcement: "REQUIRED" as const },
    };
    assert.notEqual(
      identifyReviewClaimV1(binding, core).claimId,
      identifyReviewClaimV1(binding, {
        ...core,
        effect: { kind: "STANDARDS", enforcement: "RECOMMENDED" },
      }).claimId,
    );
    assert.notEqual(
      identifyReviewClaimV1(binding, core).claimId,
      identifyReviewClaimV1(binding, {
        ...core,
        obligations: [{ canonicalInputId: "input_standard", ruleId: "rule_other" }],
      }).claimId,
    );
    const status = standardStatus();
    assert.notEqual(
      identifyReviewClaimV1(binding, status).claimId,
      identifyReviewClaimV1(binding, {
        ...status,
        effect: { ...status.effect, status: "CONFLICT", conflictingRuleIds: ["rule_other"] },
      }).claimId,
    );
  });

  it("rejects forged identity, changed core, and rebound claim sets", () => {
    const set = assembleReviewClaimSetV1(binding, [violation()]);
    const claim = set.claims[0];
    assert.ok(claim);
    assert.deepEqual(ReviewClaimSetV1Schema.parse(set), set);
    for (const changed of [
      { ...set, claims: [{ ...claim, claimId: `claim_${"0".repeat(64)}` }] },
      { ...set, claims: [{ ...claim, core: { ...claim.core, assertion: "Changed premise." } }] },
      { ...set, snapshotDigest: binding.briefDigest },
      { ...set, briefDigest: binding.snapshotDigest },
      { ...set, summary: "Unverified allegation." },
      { ...set, claims: [{ ...claim, title: "Presentation" }] },
    ])
      assert.equal(ReviewClaimSetV1Schema.safeParse(changed).success, false);
  });

  it("requires unique claim IDs in canonical order", () => {
    const set = assembleReviewClaimSetV1(binding, [violation(), uncertainty()]);
    assert.deepEqual(
      set.claims.map((claim) => claim.claimId),
      set.claims.map((claim) => claim.claimId).sort(),
    );
    assert.equal(
      ReviewClaimSetV1Schema.safeParse({ ...set, claims: [...set.claims].reverse() }).success,
      false,
    );
    assert.equal(
      ReviewClaimSetV1Schema.safeParse({ ...set, claims: [set.claims[0], set.claims[0]] }).success,
      false,
    );
    assert.deepEqual(assembleReviewClaimSetV1(binding, []).claims, []);
  });
});

describe("canonical claim inputs", () => {
  it("keeps mode-specific rule references and conflict sets canonical", () => {
    const status = standardStatus();
    const conflict = {
      ...status,
      effect: { ...status.effect, status: "CONFLICT", conflictingRuleIds: ["rule_a", "rule_z"] },
    };
    assert.equal(ReviewClaimCoreV1Schema.safeParse(conflict).success, true);
    for (const changed of [
      { ...violation(), obligations: status.obligations },
      { ...status, obligations: [{ canonicalInputId: "input_standard", ruleId: null }] },
      { ...conflict, effect: { ...conflict.effect, conflictingRuleIds: ["rule_z", "rule_a"] } },
      { ...conflict, effect: { ...conflict.effect, conflictingRuleIds: ["rule_a", "rule_a"] } },
    ])
      assert.equal(ReviewClaimCoreV1Schema.safeParse(changed).success, false);
  });

  it("rejects noncanonical text rather than trimming or truncating", () => {
    for (const value of [
      "",
      " leading",
      "trailing ",
      "two\nlines",
      "two\rlines",
      "two\u2028lines",
      "a".repeat(601),
      "😀".repeat(601),
      "\ud800",
    ]) {
      const core = violation();
      for (const changed of [
        { ...core, assertion: value },
        { ...core, correction: value },
        ...Object.keys(core.scenario).map((key) => ({
          ...core,
          scenario: { ...core.scenario, [key]: value },
        })),
      ])
        assert.equal(
          ReviewClaimCoreV1Schema.safeParse(changed).success,
          false,
          JSON.stringify(value),
        );
    }
    const assertion = "😀".repeat(600);
    assert.equal(Buffer.byteLength(assertion), 2400);
    assert.equal(ReviewClaimCoreV1Schema.parse({ ...violation(), assertion }).assertion, assertion);
    assert.notEqual(
      identifyReviewClaimV1(binding, { ...violation(), assertion: "é" }).claimId,
      identifyReviewClaimV1(binding, { ...violation(), assertion: "e\u0301" }).claimId,
    );
  });

  it("requires sorted unique obligations and evidence without rewriting them", () => {
    const core = violation();
    const obligations = [
      { canonicalInputId: "input_a", ruleId: null },
      { canonicalInputId: "input_z", ruleId: null },
    ];
    const evidence = [
      { path: "src/a.ts", anchor: "SYMBOL" as const, side: "HEAD" as const, symbol: "load" },
      { path: "src/z.ts", anchor: "SYMBOL" as const, side: "HEAD" as const, symbol: "save" },
    ];
    assert.equal(
      ReviewClaimCoreV1Schema.safeParse({ ...core, obligations, evidence }).success,
      true,
    );
    for (const changed of [
      { ...core, obligations: [...obligations].reverse() },
      { ...core, obligations: [obligations[0], obligations[0]] },
      { ...core, evidence: [...evidence].reverse() },
      { ...core, evidence: [evidence[0], evidence[0]] },
    ])
      assert.equal(ReviewClaimCoreV1Schema.safeParse(changed).success, false);
    assert.throws(() =>
      identifyReviewClaimV1(binding, { ...core, obligations: [...obligations].reverse() }),
    );
  });

  it("rejects presentation, noncanonical identifiers, and invalid frozen anchors", () => {
    const core = violation();
    for (const changed of [
      { ...core, title: "Presentation" },
      { ...core, impact: "Adverse prose" },
      { ...core, obligations: [{ canonicalInputId: "requirement", ruleId: null }] },
      { ...core, obligations: [{ canonicalInputId: "input_a", ruleId: null, detail: "Extra" }] },
      { ...core, evidence: [{ ...core.evidence[0], detail: "Unbound prose" }] },
      { ...core, evidence: [{ ...core.evidence[0], path: "../outside.ts" }] },
      { ...core, evidence: [{ ...core.evidence[0], startLine: 0 }] },
      { ...core, evidence: [{ ...core.evidence[0], endLine: 7 }] },
      { ...core, scenario: { ...core.scenario, explanation: "Extra" } },
      { ...core, effect: { ...core.effect, explanation: "Extra" } },
    ])
      assert.equal(ReviewClaimCoreV1Schema.safeParse(changed).success, false);
  });

  it("prevents kind and mode changes from escaping effect and action constraints", () => {
    const core = violation();
    for (const changed of [
      { ...core, scenario: null },
      { ...core, correction: null },
      { ...core, evidence: [] },
      { ...core, effect: { kind: "STANDARDS", enforcement: "REQUIRED" } },
      { ...core, mode: "STANDARDS" },
      { ...uncertainty(), correction: core.correction },
      { ...uncertainty(), scenario: core.scenario },
      { ...uncertainty(), effect: core.effect },
      { ...standardStatus(), mode: "REQUIREMENTS" },
      { ...standardStatus(), correction: core.correction },
      { ...standardStatus(), scenario: core.scenario },
      { ...standardStatus(), effect: { kind: "BLOCKING_UNCERTAINTY" } },
    ])
      assert.equal(ReviewClaimCoreV1Schema.safeParse(changed).success, false);
    assert.equal(
      ReviewClaimCoreV1Schema.safeParse({ ...uncertainty(), evidence: [] }).success,
      true,
    );
    assert.equal(ReviewClaimCoreV1Schema.safeParse(standardStatus()).success, true);
  });
});
