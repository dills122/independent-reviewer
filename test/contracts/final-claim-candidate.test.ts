import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assembleFinalClaimCandidateV4,
  FINAL_CLAIM_CANDIDATE_V4_JSON_SCHEMA,
  FinalClaimCandidateV4Schema,
} from "../../src/contracts/final-claim-candidate.js";
import { assembleReviewClaimSetV1 } from "../../src/contracts/review-claims.js";

const binding = {
  snapshotDigest: { algorithm: "SHA256" as const, value: "a".repeat(64) },
  briefDigest: { algorithm: "SHA256" as const, value: "b".repeat(64) },
};

function core(assertion = "Empty pages return stale entries.") {
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

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 4,
    stage: "FINAL",
    mode: "REQUIREMENTS",
    ...binding,
    continuedClaimIds: [],
    withdrawnClaimIds: [],
    newClaims: [],
    ...overrides,
  };
}

describe("final claim candidate V4", () => {
  it("admits a strict empty candidate in either mode", () => {
    const prior = assembleReviewClaimSetV1(binding, []);
    for (const mode of ["REQUIREMENTS", "STANDARDS"]) {
      const input = candidate({ mode });
      assert.deepEqual(FinalClaimCandidateV4Schema.parse(input), input);
      assert.deepEqual(assembleFinalClaimCandidateV4(prior, input), input);
    }
    assert.equal(typeof FINAL_CLAIM_CANDIDATE_V4_JSON_SCHEMA, "object");
  });

  it("accepts exact continuation and explicit withdrawal with a fresh changed premise", () => {
    const prior = assembleReviewClaimSetV1(binding, [core(), core("Another root cause.")]);
    const first = prior.claims[0];
    const second = prior.claims[1];
    assert.ok(first && second);
    const input = candidate({
      continuedClaimIds: [first.claimId],
      withdrawnClaimIds: [second.claimId],
      newClaims: [core("A changed premise requiring fresh judgment.")],
    });
    assert.deepEqual(assembleFinalClaimCandidateV4(prior, input), input);
  });

  it("rejects prose and source-ID channels that could bypass claim verification", () => {
    for (const extra of [
      { summary: "An unverified adverse premise." },
      { findings: [] },
      { preliminaryFindingDispositions: [] },
      { authorClaims: [] },
      { limitations: [] },
      { blockers: [] },
      { verdict: "READY" },
    ])
      assert.equal(FinalClaimCandidateV4Schema.safeParse(candidate(extra)).success, false);
    for (const override of [{ schemaVersion: 3 }, { stage: "PRELIMINARY" }, { mode: "OTHER" }]) {
      assert.equal(FinalClaimCandidateV4Schema.safeParse(candidate(override)).success, false);
    }
  });

  it("rejects noncanonical identifier arrays and excess new claims", () => {
    const ids = [`claim_${"a".repeat(64)}`, `claim_${"b".repeat(64)}`];
    for (const field of ["continuedClaimIds", "withdrawnClaimIds"]) {
      for (const values of [[ids[0], ids[0]], [...ids].reverse(), ["finding_old"], [" claim_a"]]) {
        assert.equal(
          FinalClaimCandidateV4Schema.safeParse(candidate({ [field]: values })).success,
          false,
        );
      }
    }
    assert.equal(
      FinalClaimCandidateV4Schema.safeParse(
        candidate({ newClaims: Array.from({ length: 1025 }, () => core()) }),
      ).success,
      false,
    );
    assert.equal(
      FinalClaimCandidateV4Schema.safeParse(
        candidate({ newClaims: [{ ...core(), assertion: " trailing " }] }),
      ).success,
      false,
    );
  });

  it("requires every prior identity exactly once and refuses unknown identities", () => {
    const prior = assembleReviewClaimSetV1(binding, [core(), core("Another root cause.")]);
    const ids = prior.claims.map((claim) => claim.claimId);
    const first = ids[0];
    assert.ok(first);
    for (const override of [
      { continuedClaimIds: [first] },
      { continuedClaimIds: ids, withdrawnClaimIds: [first] },
      { continuedClaimIds: [...ids, `claim_${"f".repeat(64)}`].sort() },
      { withdrawnClaimIds: [`claim_${"0".repeat(64)}`] },
    ])
      assert.throws(() => assembleFinalClaimCandidateV4(prior, candidate(override)));
  });

  it("rejects duplicate new semantic cores and attempts to relabel prior identities", () => {
    const prior = assembleReviewClaimSetV1(binding, [core()]);
    const ids = prior.claims.map((claim) => claim.claimId);
    assert.throws(() =>
      assembleFinalClaimCandidateV4(
        prior,
        candidate({
          continuedClaimIds: ids,
          newClaims: [core("New root cause."), core("New root cause.")],
        }),
      ),
    );
    assert.throws(() =>
      assembleFinalClaimCandidateV4(
        prior,
        candidate({ withdrawnClaimIds: ids, newClaims: [core()] }),
      ),
    );
    assert.throws(() =>
      assembleFinalClaimCandidateV4(
        prior,
        candidate({ continuedClaimIds: ids, newClaims: [core()] }),
      ),
    );
  });

  it("rejects either frozen binding mismatch", () => {
    const prior = assembleReviewClaimSetV1(binding, []);
    for (const override of [
      { snapshotDigest: binding.briefDigest },
      { briefDigest: binding.snapshotDigest },
    ]) {
      assert.throws(() => assembleFinalClaimCandidateV4(prior, candidate(override)));
    }
  });

  it("checks candidate mode against both prior and newly introduced claims", () => {
    const prior = assembleReviewClaimSetV1(binding, [core()]);
    assert.throws(() =>
      assembleFinalClaimCandidateV4(
        prior,
        candidate({
          mode: "STANDARDS",
          continuedClaimIds: prior.claims.map((claim) => claim.claimId),
        }),
      ),
    );
    const empty = assembleReviewClaimSetV1(binding, []);
    assert.throws(() =>
      assembleFinalClaimCandidateV4(empty, candidate({ mode: "STANDARDS", newClaims: [core()] })),
    );
    const standard = {
      ...core(),
      mode: "STANDARDS" as const,
      obligations: [{ canonicalInputId: "input_standard", ruleId: "rule_paging" }],
      effect: { kind: "STANDARDS" as const, enforcement: "REQUIRED" as const },
    };
    assert.throws(() => assembleFinalClaimCandidateV4(empty, candidate({ newClaims: [standard] })));
    assert.doesNotThrow(() =>
      assembleFinalClaimCandidateV4(empty, candidate({ mode: "STANDARDS", newClaims: [standard] })),
    );
  });
});
