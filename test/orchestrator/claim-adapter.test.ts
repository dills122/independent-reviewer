import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalizeJson } from "../../src/contracts/canonical-json.js";
import type { ReviewBrief } from "../../src/contracts/neutral-review-brief.js";
import type { ReviewPreliminary, ReviewReport } from "../../src/contracts/standards-results.js";
import { prepareClaimProposalV1, reviewClaimSetV1 } from "../../src/orchestrator/claim-adapter.js";

const snapshotDigest = { algorithm: "SHA256", value: "a".repeat(64) };
const briefDigest = { algorithm: "SHA256", value: "b".repeat(64) };

function brief(standards = false): ReviewBrief {
  const profile = {
    schemaVersion: 1,
    name: "Paging rules",
    source: "STANDARDS.md",
    rules: ["rule_paging", "rule_other"].map((id) => ({
      id,
      text: "Return stable pages.",
      enforcement: "REQUIRED",
      paths: ["src/**"],
      exceptions: null,
    })),
  };
  const inputs = standards
    ? [{ id: "input_standard", content: JSON.stringify(profile) }]
    : [
        { id: "input_requirement", content: "Return empty pages." },
        { id: "input_plan", content: "Keep page order stable." },
      ];
  return {
    schemaVersion: standards ? 2 : 1,
    mode: standards ? "STANDARDS" : "REQUIREMENTS",
    briefDigest,
    canonicalInputs: standards ? { standards: inputs } : { requirements: inputs },
    snapshotManifest: {
      snapshotDigest,
      canonicalInputs: inputs.map(({ id }) => ({
        id,
        digest: snapshotDigest,
        byteLength: 20,
        disposition: "INCLUDED",
      })),
    },
  } as unknown as ReviewBrief;
}

function finding(standards = false) {
  const common = {
    id: "finding_page",
    title: "PRESENTATION_TITLE",
    impact: "PRESENTATION_IMPACT",
    correction: "Return an empty array for an empty page.",
    evidence: [
      {
        path: "src/page.ts",
        anchor: "LINE_RANGE",
        side: "HEAD",
        startLine: 8,
        endLine: 9,
        detail: "PRESENTATION_EVIDENCE_DETAIL",
      },
    ],
  };
  return standards
    ? {
        ...common,
        severity: "REQUIRED",
        ruleIds: ["rule_paging"],
        problem: "Empty pages return stale entries.",
      }
    : { ...common, severity: "P1", scenario: "Empty pages return stale entries." };
}

function review(overrides: Record<string, unknown> = {}, standards = false): ReviewPreliminary {
  return {
    schemaVersion: standards ? 2 : 1,
    mode: standards ? "STANDARDS" : "REQUIREMENTS",
    stage: "PRELIMINARY",
    snapshotDigest,
    briefDigest,
    findings: [finding(standards)],
    evidenceGaps: [],
    limitations: [],
    ruleAssessments: [],
    ...overrides,
  } as unknown as ReviewPreliminary;
}

describe("legacy review to bound claim adapter", () => {
  it("binds findings to brief identities and excludes presentation and oracle fields", () => {
    const result = reviewClaimSetV1(
      brief(),
      review({ oracleLabel: "ORACLE_SECRET", expectedVerdict: "ORACLE_VERDICT" }),
    );
    assert.deepEqual(result.set.snapshotDigest, snapshotDigest);
    assert.deepEqual(result.set.briefDigest, briefDigest);
    const claim = result.set.claims[0];
    assert.ok(claim);
    assert.equal(result.findingClaims.finding_page, claim.claimId);
    assert.equal(claim.core.assertion, "Empty pages return stale entries.");
    assert.equal(claim.core.scenario?.observedResult, claim.core.assertion);
    assert.equal(claim.core.correction, finding().correction);
    assert.deepEqual(claim.core.obligations, [
      { canonicalInputId: "input_plan", ruleId: null },
      { canonicalInputId: "input_requirement", ruleId: null },
    ]);
    assert.doesNotMatch(JSON.stringify(result.set), /PRESENTATION_|ORACLE_/);
  });

  it("retains exact identity when only presentation or source finding ID changes", () => {
    const original = reviewClaimSetV1(brief(), review());
    const changed = reviewClaimSetV1(
      brief(),
      review({
        findings: [
          {
            ...finding(),
            id: "finding_renamed",
            title: "Different title",
            impact: "Different impact",
          },
        ],
      }),
    );
    assert.deepEqual(changed.set, original.set);
    assert.equal(changed.findingClaims.finding_renamed, original.findingClaims.finding_page);
    const proposal = prepareClaimProposalV1(original.set, changed.set);
    assert.deepEqual(
      proposal.continuedClaimIds,
      original.set.claims.map((claim) => claim.claimId),
    );
    assert.deepEqual(proposal.withdrawnClaimIds, []);
    assert.deepEqual(proposal.newClaims, []);
  });

  it("deduplicates identical cores while preserving all source finding mappings", () => {
    const result = reviewClaimSetV1(
      brief(),
      review({ findings: [finding(), { ...finding(), id: "finding_duplicate" }] }),
    );
    assert.equal(result.set.claims.length, 1);
    assert.equal(result.findingClaims.finding_page, result.findingClaims.finding_duplicate);
  });

  it("strips evidence detail and sorts unique anchors canonically", () => {
    const anchor = finding().evidence[0];
    assert.ok(anchor);
    const result = reviewClaimSetV1(
      brief(),
      review({
        findings: [
          {
            ...finding(),
            evidence: [
              { ...anchor, path: "src/z.ts" },
              { ...anchor, path: "src/a.ts" },
              { ...anchor, path: "src/a.ts", detail: "Other explanation" },
            ],
          },
        ],
      }),
    );
    const evidence = result.set.claims[0]?.core.evidence;
    assert.ok(evidence);
    assert.equal(evidence.length, 2);
    assert.deepEqual(evidence.map(canonicalizeJson), evidence.map(canonicalizeJson).sort());
    assert.equal("detail" in (evidence[0] ?? {}), false);
  });

  it("makes changed scenario, correction, evidence, or effect a fresh claim", () => {
    const original = reviewClaimSetV1(brief(), review());
    const anchor = finding().evidence[0];
    assert.ok(anchor);
    for (const change of [
      { scenario: "Nonempty pages return stale entries." },
      { correction: "Reject empty page requests." },
      { evidence: [{ ...anchor, startLine: 7 }] },
      { severity: "P2" },
    ]) {
      const changed = reviewClaimSetV1(
        brief(),
        review({ findings: [{ ...finding(), ...change }] }),
      );
      const proposal = prepareClaimProposalV1(original.set, changed.set);
      assert.deepEqual(proposal.continuedClaimIds, []);
      assert.deepEqual(
        proposal.withdrawnClaimIds,
        original.set.claims.map((claim) => claim.claimId),
      );
      assert.equal(proposal.newClaims.length, 1);
    }
  });

  it("binds preliminary gaps and limitations as blocking concerns", () => {
    const result = reviewClaimSetV1(
      brief(),
      review({
        findings: [],
        evidenceGaps: ["The paging contract was not captured."],
        limitations: ["The reverse caller was not captured."],
      }),
    );
    assert.equal(result.set.claims.length, 2);
    assert.deepEqual(
      result.concernClaims.map(({ kind, concernIndex }) => ({ kind, concernIndex })),
      [
        { kind: "EVIDENCE_GAP", concernIndex: 0 },
        { kind: "LIMITATION", concernIndex: 0 },
      ],
    );
    for (const claim of result.set.claims) {
      assert.equal(claim.core.kind, "BLOCKING_UNCERTAINTY");
      assert.equal(claim.core.correction, null);
      assert.equal(claim.core.scenario, null);
      assert.deepEqual(claim.core.evidence, []);
    }
  });

  it("carries only remaining final concerns and excludes runner coverage limitations", () => {
    const report = review({
      stage: "FINAL",
      findings: [],
      limitations: ["RUNNER_COVERAGE_ONLY"],
      preliminaryConcernDispositions: [
        {
          kind: "EVIDENCE_GAP",
          preliminaryConcern: "The paging contract was not captured.",
          disposition: "REMAINS",
          rationale: "It remains absent.",
        },
        {
          kind: "LIMITATION",
          preliminaryConcern: "RESOLVED_CONCERN",
          disposition: "RESOLVED",
          rationale: "Evidence resolved it.",
        },
      ],
    }) as unknown as ReviewReport;
    const result = reviewClaimSetV1(brief(), report);
    assert.equal(result.set.claims.length, 1);
    assert.equal(result.set.claims[0]?.core.assertion, "The paging contract was not captured.");
    assert.doesNotMatch(JSON.stringify(result.set), /RUNNER_COVERAGE_ONLY|RESOLVED_CONCERN/);
  });

  it("maps standards findings and concerns to owning canonical rule inputs", () => {
    const result = reviewClaimSetV1(
      brief(true),
      review({ evidenceGaps: ["The required paging contract is absent."] }, true),
    );
    const findingCore = result.set.claims.find(
      (claim) => claim.claimId === result.findingClaims.finding_page,
    )?.core;
    assert.ok(findingCore);
    assert.equal(findingCore.assertion, "Empty pages return stale entries.");
    assert.deepEqual(findingCore.effect, { kind: "STANDARDS", enforcement: "REQUIRED" });
    assert.deepEqual(findingCore.obligations, [
      { canonicalInputId: "input_standard", ruleId: "rule_paging" },
    ]);
    const concernCore = result.set.claims.find(
      (claim) => claim.core.kind === "BLOCKING_UNCERTAINTY",
    )?.core;
    assert.deepEqual(concernCore?.obligations, [
      { canonicalInputId: "input_standard", ruleId: "rule_other" },
      { canonicalInputId: "input_standard", ruleId: "rule_paging" },
    ]);
  });

  it("binds adverse rule states while excluding assessed rule bookkeeping", () => {
    const result = reviewClaimSetV1(
      brief(true),
      review(
        {
          findings: [],
          ruleAssessments: [
            {
              ruleId: "rule_paging",
              status: "UNASSESSED",
              conflictingRuleIds: [],
              explanation: "The paging contract was not captured.",
            },
            {
              ruleId: "rule_other",
              status: "ASSESSED",
              conflictingRuleIds: [],
              explanation: "No deviation found.",
            },
          ],
        },
        true,
      ),
    );
    assert.equal(result.set.claims.length, 1);
    assert.equal(result.ruleClaims.rule_paging, result.set.claims[0]?.claimId);
    assert.equal(result.ruleClaims.rule_other, undefined);
    assert.deepEqual(result.set.claims[0]?.core.effect, {
      kind: "STANDARD_STATUS",
      ruleId: "rule_paging",
      status: "UNASSESSED",
      conflictingRuleIds: [],
    });
  });

  it("rejects unknown rule references and noncanonical semantic prose", () => {
    assert.throws(() =>
      reviewClaimSetV1(
        brief(true),
        review({ findings: [{ ...finding(true), ruleIds: ["rule_unknown"] }] }, true),
      ),
    );
    assert.throws(() =>
      reviewClaimSetV1(
        brief(true),
        review(
          {
            findings: [],
            ruleAssessments: [
              {
                ruleId: "rule_unknown",
                status: "UNASSESSED",
                conflictingRuleIds: [],
                explanation: "The rule could not be assessed.",
              },
            ],
          },
          true,
        ),
      ),
    );
    for (const scenario of [" leading", "two\nlines", "a".repeat(601)]) {
      assert.throws(() =>
        reviewClaimSetV1(brief(), review({ findings: [{ ...finding(), scenario }] })),
      );
    }
  });

  it("rejects review identity mismatch and mixed review modes", () => {
    for (const change of [{ snapshotDigest: briefDigest }, { briefDigest: snapshotDigest }]) {
      assert.throws(() => reviewClaimSetV1(brief(), review(change)));
    }
    assert.throws(() => reviewClaimSetV1(brief(), review({}, true)));
    assert.throws(() => reviewClaimSetV1(brief(true), review()));
  });
});
