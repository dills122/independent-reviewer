import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assembleClaimVerificationV1 } from "../../src/contracts/claim-verification.js";
import { assembleReviewClaimSetV1 } from "../../src/contracts/review-claims.js";
import {
  planClaimTransitionsV1,
  projectVerifiedClaimsV1,
} from "../../src/report/claim-projection.js";

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

function judgment(overrides: Record<string, unknown> = {}) {
  return {
    kind: "VIOLATION",
    obligationStatus: "APPLICABLE",
    scenarioStatus: "IN_SCOPE",
    behaviorStatus: "SUPPORTED",
    correctionStatus: "SUPPORTED",
    duplicateOf: null,
    rationale: "Frozen evidence establishes this premise.",
    ...overrides,
  };
}

const empty = () => assembleReviewClaimSetV1(binding, []);
const proposal = () => ({
  continuedClaimIds: [] as string[],
  withdrawnClaimIds: [] as string[],
  newClaims: [] as ReturnType<typeof violation>[],
});

function prior(core = violation(), assessment = judgment()) {
  const claims = assembleReviewClaimSetV1(binding, [core]);
  const verification = assembleClaimVerificationV1(claims, empty(), {
    schemaVersion: 1,
    stage: "FINDING_VERIFICATION",
    assessments: [assessment],
  });
  const id = claims.claims[0]?.claimId;
  assert.ok(id);
  return { claims, verification, id };
}

function post(plan: ReturnType<typeof planClaimTransitionsV1>, assessments: unknown[]) {
  return assembleClaimVerificationV1(plan.targets, plan.catalog, {
    schemaVersion: 1,
    stage: "FINAL_CLAIM_VERIFICATION",
    assessments,
  });
}

describe("verified claim projection", () => {
  it("projects a clean claim set without a post-author call", () => {
    const verification = assembleClaimVerificationV1(empty(), empty(), {
      schemaVersion: 1,
      stage: "FINDING_VERIFICATION",
      assessments: [],
    });
    const result = projectVerifiedClaimsV1(empty(), verification, proposal(), null);
    assert.equal(result.verdict, "READY");
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(result.limitations, []);
  });

  it("requires fresh verification for a final-only claim and removes a rejected allegation", () => {
    const verification = assembleClaimVerificationV1(empty(), empty(), {
      schemaVersion: 1,
      stage: "FINDING_VERIFICATION",
      assessments: [],
    });
    const proposed = { ...proposal(), newClaims: [violation("FALSE_FINAL_ONLY_ALLEGATION")] };
    const plan = planClaimTransitionsV1(empty(), verification, proposed);
    assert.equal(plan.targets.claims.length, 1);
    assert.throws(() => projectVerifiedClaimsV1(empty(), verification, proposed, null));
    const result = projectVerifiedClaimsV1(
      empty(),
      verification,
      proposed,
      post(plan, [judgment({ scenarioStatus: "OUT_OF_SCOPE" })]),
    );
    assert.equal(result.verdict, "READY");
    assert.deepEqual(result.findings, []);
    assert.equal(result.rejectedClaimIds.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /FALSE_FINAL_ONLY_ALLEGATION/);
  });

  it("routes a changed premise through a new identity and explicit withdrawal", () => {
    const original = prior();
    const proposed = {
      ...proposal(),
      withdrawnClaimIds: [original.id],
      newClaims: [violation("Nonempty pages return stale entries.")],
    };
    const plan = planClaimTransitionsV1(original.claims, original.verification, proposed);
    assert.equal(plan.targets.claims.length, 2);
    assert.deepEqual(
      new Set(plan.transitions.map((entry) => entry.kind)),
      new Set(["WITHDRAWAL_PROPOSED", "NEW_OR_CHANGED"]),
    );
    assert.throws(() =>
      projectVerifiedClaimsV1(original.claims, original.verification, proposed, null),
    );
    assert.throws(() =>
      planClaimTransitionsV1(original.claims, original.verification, {
        ...proposal(),
        continuedClaimIds: [original.id],
        newClaims: [violation()],
      }),
    );
  });

  it("requires exact prior dispositions without unknown or duplicate IDs", () => {
    const original = prior();
    for (const proposed of [
      proposal(),
      { ...proposal(), continuedClaimIds: [original.id, original.id] },
      { ...proposal(), continuedClaimIds: [original.id], withdrawnClaimIds: [original.id] },
      { ...proposal(), continuedClaimIds: [`claim_${"0".repeat(64)}`] },
    ])
      assert.throws(() => planClaimTransitionsV1(original.claims, original.verification, proposed));
  });

  it("carries rejected claims terminally without another call or visible prose", () => {
    const original = prior(
      violation("FALSE_PRIOR_ALLEGATION"),
      judgment({ behaviorStatus: "REFUTED" }),
    );
    for (const proposed of [
      { ...proposal(), continuedClaimIds: [original.id] },
      { ...proposal(), withdrawnClaimIds: [original.id] },
    ]) {
      const plan = planClaimTransitionsV1(original.claims, original.verification, proposed);
      assert.equal(plan.targets.claims.length, 0);
      assert.equal(plan.transitions[0]?.kind, "REJECTED_CARRIED");
      const result = projectVerifiedClaimsV1(
        original.claims,
        original.verification,
        proposed,
        null,
      );
      assert.equal(result.verdict, "READY");
      assert.deepEqual(result.rejectedClaimIds, [original.id]);
      assert.doesNotMatch(JSON.stringify(result), /FALSE_PRIOR_ALLEGATION/);
    }
  });

  it("projects inconclusive violations as blocking uncertainty or follow-up by effect", () => {
    for (const severity of ["P1", "P2"] as const) {
      const claims = assembleReviewClaimSetV1(binding, [
        { ...violation(), effect: { kind: "REQUIREMENTS", severity } },
      ]);
      const verification = assembleClaimVerificationV1(claims, empty(), {
        schemaVersion: 1,
        stage: "FINDING_VERIFICATION",
        assessments: [judgment({ behaviorStatus: "NOT_ESTABLISHED" })],
      });
      const continuedClaimIds = claims.claims.map((claim) => claim.claimId);
      const result = projectVerifiedClaimsV1(
        claims,
        verification,
        { ...proposal(), continuedClaimIds },
        null,
      );
      assert.deepEqual(result.findings, []);
      assert.equal(result.uncertainties[0]?.blocking, severity === "P1");
      assert.equal(
        result.verdict,
        severity === "P1" ? "UNABLE_TO_VERIFY" : "READY_WITH_FOLLOW_UPS",
      );
    }
  });

  it("retains demonstrated withdrawal and prior correction unless fresh judgment rejects it", () => {
    const original = prior();
    const proposed = { ...proposal(), withdrawnClaimIds: [original.id] };
    const plan = planClaimTransitionsV1(original.claims, original.verification, proposed);
    for (const behaviorStatus of ["SUPPORTED", "NOT_ESTABLISHED"]) {
      const result = projectVerifiedClaimsV1(
        original.claims,
        original.verification,
        proposed,
        post(plan, [judgment({ behaviorStatus, correctionStatus: "REJECTED" })]),
      );
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0]?.correction, violation().correction);
      assert.equal(result.verdict, "NOT_READY");
    }
    const result = projectVerifiedClaimsV1(
      original.claims,
      original.verification,
      proposed,
      post(plan, [judgment({ behaviorStatus: "REFUTED" })]),
    );
    assert.equal(result.findings.length, 0);
    assert.equal(result.verdict, "READY");
  });

  it("merges demonstrated duplicates while retaining strongest effect and supported correction", () => {
    const strong = violation();
    const weak = {
      ...violation("A duplicate root cause."),
      obligations: [{ canonicalInputId: "input_other", ruleId: null }],
      evidence: [{ ...strong.evidence[0], path: "src/other.ts" }],
      effect: { kind: "REQUIREMENTS" as const, severity: "P2" as const },
      correction: "WEAK_ACTION_MUST_NOT_REPLACE_STRONG",
    };
    const claims = assembleReviewClaimSetV1(binding, [strong, weak]);
    const verification = assembleClaimVerificationV1(claims, empty(), {
      schemaVersion: 1,
      stage: "FINDING_VERIFICATION",
      assessments: claims.claims.map((_, index) =>
        judgment(index === 0 ? {} : { duplicateOf: { source: "TARGET", index: 0 } }),
      ),
    });
    const result = projectVerifiedClaimsV1(
      claims,
      verification,
      { ...proposal(), continuedClaimIds: claims.claims.map((claim) => claim.claimId) },
      null,
    );
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.claimIds.length, 2);
    assert.equal(result.findings[0]?.core.obligations.length, 2);
    assert.equal(result.findings[0]?.core.evidence.length, 2);
    assert.equal(result.findings[0]?.correction, strong.correction);
    assert.equal(result.verdict, "NOT_READY");
  });

  it("never publishes an unsupported correction as an action", () => {
    const core = { ...violation(), correction: "UNSUPPORTED_ACTION" };
    const original = prior(core, judgment({ correctionStatus: "REJECTED" }));
    const result = projectVerifiedClaimsV1(
      original.claims,
      original.verification,
      { ...proposal(), continuedClaimIds: [original.id] },
      null,
    );
    assert.equal(result.findings.length, 1);
    assert.notEqual(result.findings[0]?.correction, core.correction);
    assert.doesNotMatch(
      JSON.stringify([...result.blockers, ...result.fastFollows]),
      /UNSUPPORTED_ACTION/,
    );
  });

  it("requires verification when an allegation moves into uncertainty", () => {
    const original = prior();
    const uncertainty = {
      ...violation(),
      kind: "BLOCKING_UNCERTAINTY" as const,
      scenario: null,
      correction: null,
      effect: { kind: "BLOCKING_UNCERTAINTY" as const },
    };
    const proposed = { ...proposal(), withdrawnClaimIds: [original.id], newClaims: [uncertainty] };
    const plan = planClaimTransitionsV1(original.claims, original.verification, proposed);
    assert.equal(plan.targets.claims.length, 2);
    assert.throws(() =>
      projectVerifiedClaimsV1(original.claims, original.verification, proposed, null),
    );
  });

  it("projects inconclusive standards state to UNASSESSED and blocks outcome", () => {
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
        status: "CONFLICT" as const,
        conflictingRuleIds: ["rule_other"],
      },
    };
    const claims = assembleReviewClaimSetV1(binding, [core]);
    const verification = assembleClaimVerificationV1(claims, empty(), {
      schemaVersion: 1,
      stage: "FINDING_VERIFICATION",
      assessments: [
        {
          kind: "STANDARD_STATUS",
          status: "INCONCLUSIVE",
          correctionStatus: null,
          duplicateOf: null,
          rationale: "Rule relation is unresolved.",
        },
      ],
    });
    const result = projectVerifiedClaimsV1(
      claims,
      verification,
      { ...proposal(), continuedClaimIds: claims.claims.map((claim) => claim.claimId) },
      null,
    );
    assert.equal(result.standardStates[0]?.status, "UNASSESSED");
    assert.equal(result.verdict, "UNABLE_TO_VERIFY");
    assert.equal(result.findings.length, 0);
  });

  it("preserves runner coverage uncertainty and requirements blocker precedence", () => {
    const verification = assembleClaimVerificationV1(empty(), empty(), {
      schemaVersion: 1,
      stage: "FINDING_VERIFICATION",
      assessments: [],
    });
    const limitation = "One captured source file was omitted.";
    const clean = projectVerifiedClaimsV1(empty(), verification, proposal(), null, [limitation]);
    assert.equal(clean.verdict, "UNABLE_TO_VERIFY");
    assert.ok(clean.limitations.includes(limitation));
    const original = prior();
    const blocked = projectVerifiedClaimsV1(
      original.claims,
      original.verification,
      { ...proposal(), continuedClaimIds: [original.id] },
      null,
      [limitation],
    );
    assert.equal(blocked.verdict, "NOT_READY");
    assert.ok(blocked.limitations.includes(limitation));
  });
});
