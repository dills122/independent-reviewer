import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assembleClaimVerificationV1 } from "../../src/contracts/claim-verification.js";
import { assembleFinalClaimCandidateV4 } from "../../src/contracts/final-claim-candidate.js";
import type { ReviewBrief } from "../../src/contracts/neutral-review-brief.js";
import {
  assembleReviewClaimSetV1,
  ReviewClaimCoreV1Schema,
} from "../../src/contracts/review-claims.js";
import {
  FinalReviewReportV2Schema,
  StandardsReportV4Schema,
} from "../../src/contracts/verified-report.js";
import { materializeVerifiedReportV1 } from "../../src/report/verified-report.js";

const binding = {
  snapshotDigest: { algorithm: "SHA256" as const, value: "a".repeat(64) },
  briefDigest: { algorithm: "SHA256" as const, value: "b".repeat(64) },
};

function core(standards = false) {
  return ReviewClaimCoreV1Schema.parse({
    mode: standards ? "STANDARDS" : "REQUIREMENTS",
    kind: "VIOLATION",
    obligations: [
      {
        canonicalInputId: standards ? "input_standard" : "input_requirement",
        ruleId: standards ? "rule_paging" : null,
      },
    ],
    scenario: {
      preconditions: "An empty page is requested.",
      action: "Read the page.",
      observedResult: "Stale entries are returned.",
      expectedResult: "An empty page is returned.",
    },
    evidence: [
      { path: "src/page.ts", anchor: "LINE_RANGE", side: "HEAD", startLine: 8, endLine: 9 },
    ],
    assertion: "Empty pages return stale entries.",
    correction: "Return an empty array.",
    effect: standards
      ? { kind: "STANDARDS", enforcement: "REQUIRED" }
      : { kind: "REQUIREMENTS", severity: "P1" },
  });
}

function fixture(standards = false, cores = [core(standards)], assessments?: unknown[]) {
  const inputId = standards ? "input_standard" : "input_requirement";
  const profile = {
    schemaVersion: 1,
    name: "Paging",
    source: "STANDARDS.md",
    rules: ["rule_paging", "rule_other"].map((id) => ({
      id,
      text: "Return stable pages.",
      enforcement: "REQUIRED",
      paths: ["src/**"],
      exceptions: null,
    })),
  };
  const brief = {
    schemaVersion: standards ? 2 : 1,
    mode: standards ? "STANDARDS" : "REQUIREMENTS",
    briefDigest: binding.briefDigest,
    canonicalInputs: standards
      ? { standards: [{ id: inputId, content: JSON.stringify(profile) }] }
      : {},
    snapshotManifest: {
      snapshotDigest: binding.snapshotDigest,
      paths: [{ path: "src/page.ts", changeType: "MODIFIED" }],
      canonicalInputs: [{ id: inputId }],
    },
  } as unknown as ReviewBrief;
  const prior = assembleReviewClaimSetV1(binding, cores);
  const empty = assembleReviewClaimSetV1(binding, []);
  const priorVerification = assembleClaimVerificationV1(prior, empty, {
    schemaVersion: 1,
    stage: "FINDING_VERIFICATION",
    assessments: assessments ?? prior.claims.map(() => judgment()),
  });
  const candidate = assembleFinalClaimCandidateV4(prior, {
    schemaVersion: 4,
    stage: "FINAL",
    mode: standards ? "STANDARDS" : "REQUIREMENTS",
    ...binding,
    continuedClaimIds: prior.claims.map((claim) => claim.claimId),
    withdrawnClaimIds: [],
    newClaims: [],
  });
  return {
    brief,
    prior,
    priorVerification,
    candidate,
    finalVerification: null,
    coverage: {
      changedPathCoverage: [
        {
          path: "src/page.ts",
          status: "INSPECTED" as const,
          explanation: "UNTRUSTED_COVERAGE_ALLEGATION",
        },
      ],
      canonicalInputCoverage: [
        {
          canonicalInputId: inputId,
          status: "ASSESSED" as const,
          explanation: "UNTRUSTED_INPUT_ALLEGATION",
        },
      ],
      blockingLimitations: [] as string[],
    },
    claimedVerification: [],
    authorContext: null,
    authorStatements: [] as string[],
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
    rationale: "Frozen evidence establishes the premise.",
    ...overrides,
  };
}

describe("verified report materialization", () => {
  it("publishes demonstrated claims with explicit binding and runner-owned presentation", () => {
    const input = fixture();
    const report = materializeVerifiedReportV1(input);
    assert.equal(FinalReviewReportV2Schema.safeParse(report).success, true);
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.mode, "REQUIREMENTS");
    assert.equal(report.verdict, "NOT_READY");
    const finding = report.findings[0];
    assert.ok(finding);
    assert.deepEqual(
      finding.claimIds,
      input.prior.claims.map((claim) => claim.claimId),
    );
    assert.equal(finding.representativeClaimId, input.prior.claims[0]?.claimId);
    assert.equal(finding.correction, core().correction);
    if ("scenario" in finding) assert.equal(finding.scenario, core().assertion);
    assert.deepEqual(report.preliminaryFindingDispositions, []);
    assert.deepEqual(report.preliminaryConcernDispositions, []);
    assert.ok(report.projection);
    assert.doesNotMatch(
      JSON.stringify(report),
      /UNTRUSTED_COVERAGE_ALLEGATION|UNTRUSTED_INPUT_ALLEGATION/,
    );
    assert.equal(report.changedPathCoverage[0]?.status, "INSPECTED");
    assert.equal(report.canonicalInputCoverage[0]?.canonicalInputId, "input_requirement");
  });

  it("excludes rejected malicious assertions and actions from every report field", () => {
    const rejected = {
      ...core(),
      assertion: "REJECTED_MALICIOUS_ASSERTION",
      correction: "REJECTED_MALICIOUS_ACTION",
    };
    const report = materializeVerifiedReportV1(
      fixture(false, [rejected], [judgment({ behaviorStatus: "REFUTED" })]),
    );
    assert.equal(report.verdict, "READY");
    assert.deepEqual(report.findings, []);
    assert.doesNotMatch(JSON.stringify(report), /REJECTED_MALICIOUS/);
  });

  it("keeps a demonstrated finding but substitutes an unsupported correction", () => {
    const unsupported = { ...core(), correction: "UNSUPPORTED_MALICIOUS_ACTION" };
    const report = materializeVerifiedReportV1(
      fixture(false, [unsupported], [judgment({ correctionStatus: "REJECTED" })]),
    );
    assert.equal(report.findings.length, 1);
    assert.equal(report.verdict, "NOT_READY");
    assert.doesNotMatch(JSON.stringify(report), /UNSUPPORTED_MALICIOUS_ACTION/);
  });

  it("routes inconclusive defects to uncertainty rather than findings", () => {
    const report = materializeVerifiedReportV1(
      fixture(false, [core()], [judgment({ behaviorStatus: "NOT_ESTABLISHED" })]),
    );
    assert.deepEqual(report.findings, []);
    assert.equal(report.uncertainties.length, 1);
    assert.equal(report.uncertainties[0]?.blocking, true);
    assert.equal(report.verdict, "UNABLE_TO_VERIFY");
  });

  it("attributes author statements and command outcomes without runner confirmation", () => {
    const report = materializeVerifiedReportV1({
      ...fixture(false, []),
      authorContext: { status: "PROVIDED", digest: binding.briefDigest, noteCode: null },
      authorStatements: ["AUTHOR_SAYS_THE_BEHAVIOR_IS_SAFE"],
      claimedVerification: [
        { command: "npm test", outcome: "PASSED", summary: "AUTHOR_REPORTS_ALL_TESTS_PASSED" },
      ],
    });
    assert.equal(report.authorClaims[0]?.claim, "AUTHOR_SAYS_THE_BEHAVIOR_IS_SAFE");
    assert.equal(report.authorClaims[0]?.status, "UNVERIFIED");
    const command = report.authorVerificationClaims[0];
    assert.equal(command?.command, "npm test");
    assert.equal(command?.claimedOutcome, "PASSED");
    assert.equal(command?.claimedSummary, "AUTHOR_REPORTS_ALL_TESTS_PASSED");
    assert.equal(command?.status, "UNVERIFIED");
    assert.doesNotMatch(report.summary, /AUTHOR_SAYS|AUTHOR_REPORTS/);
    assert.equal(report.verdict, "READY");
  });

  it("refuses author evidence paired with declined author context", () => {
    const input = {
      ...fixture(false, []),
      authorContext: {
        status: "DECLINED" as const,
        digest: binding.briefDigest,
        noteCode: "AUTHOR_CONTEXT_DECLINED" as const,
      },
    };
    assert.throws(() =>
      materializeVerifiedReportV1({ ...input, authorStatements: ["An author assertion."] }),
    );
    assert.throws(() =>
      materializeVerifiedReportV1({
        ...input,
        claimedVerification: [{ command: "npm test", outcome: "PASSED", summary: "Passed." }],
      }),
    );
    assert.doesNotThrow(() => materializeVerifiedReportV1(input));
  });

  it("blocks unassessed coverage while retaining requirements blocker precedence", () => {
    for (const cores of [[], [core()]]) {
      const input = fixture(false, cores);
      const report = materializeVerifiedReportV1({
        ...input,
        coverage: {
          ...input.coverage,
          changedPathCoverage: [
            { path: "src/page.ts", status: "UNASSESSED", explanation: "UNVERIFIED_COVERAGE_STORY" },
          ],
        },
      });
      assert.equal(report.verdict, cores.length ? "NOT_READY" : "UNABLE_TO_VERIFY");
      assert.ok(report.limitations.length > 0);
      assert.doesNotMatch(JSON.stringify(report), /UNVERIFIED_COVERAGE_STORY/);
    }
  });

  it("rejects omitted, duplicate, and invented frozen coverage scope", () => {
    const input = fixture(false, []);
    for (const coverage of [
      { ...input.coverage, changedPathCoverage: [] },
      {
        ...input.coverage,
        changedPathCoverage: [
          ...input.coverage.changedPathCoverage,
          ...input.coverage.changedPathCoverage,
        ],
      },
      {
        ...input.coverage,
        changedPathCoverage: [
          { path: "src/unknown.ts", status: "INSPECTED" as const, explanation: "Read." },
        ],
      },
      { ...input.coverage, canonicalInputCoverage: [] },
      {
        ...input.coverage,
        canonicalInputCoverage: [
          ...input.coverage.canonicalInputCoverage,
          ...input.coverage.canonicalInputCoverage,
        ],
      },
      {
        ...input.coverage,
        canonicalInputCoverage: [
          { canonicalInputId: "input_unknown", status: "ASSESSED" as const, explanation: "Read." },
        ],
      },
    ])
      assert.throws(() => materializeVerifiedReportV1({ ...input, coverage }));
  });

  it("builds standards V4 with exact rule mapping and uncertainty before blocker precedence", () => {
    const input = fixture(true);
    const report = materializeVerifiedReportV1(input);
    assert.equal(StandardsReportV4Schema.safeParse(report).success, true);
    assert.equal(report.schemaVersion, 4);
    assert.equal(report.verdict, "NOT_READY");
    assert.ok("ruleAssessments" in report);
    assert.equal(report.ruleAssessments.length, 2);
    assert.ok(report.ruleAssessments.every((rule) => rule.status === "ASSESSED"));
    const uncertain = materializeVerifiedReportV1({
      ...input,
      coverage: {
        ...input.coverage,
        blockingLimitations: ["A source file could not be captured."],
      },
    });
    assert.equal(uncertain.verdict, "UNABLE_TO_VERIFY");
  });

  it("excludes rejected standards states and conservatively retains inconclusive states", () => {
    const state = ReviewClaimCoreV1Schema.parse({
      ...core(true),
      kind: "STANDARD_STATUS",
      correction: null,
      scenario: null,
      assertion: "ADVERSE_RULE_STATE",
      effect: {
        kind: "STANDARD_STATUS",
        ruleId: "rule_paging",
        status: "UNASSESSED",
        conflictingRuleIds: [],
      },
    });
    for (const status of ["REJECTED", "INCONCLUSIVE"]) {
      const report = materializeVerifiedReportV1(
        fixture(
          true,
          [state],
          [
            {
              kind: "STANDARD_STATUS",
              status,
              correctionStatus: null,
              duplicateOf: null,
              rationale: "Rule availability was checked.",
            },
          ],
        ),
      );
      assert.ok("ruleAssessments" in report);
      assert.equal(
        report.ruleAssessments.find((rule) => rule.ruleId === "rule_paging")?.status,
        status === "REJECTED" ? "ASSESSED" : "UNASSESSED",
      );
      assert.equal(report.verdict, status === "REJECTED" ? "READY" : "UNABLE_TO_VERIFY");
      if (status === "REJECTED") assert.doesNotMatch(JSON.stringify(report), /ADVERSE_RULE_STATE/);
    }
  });

  it("refuses unknown obligations and brief identity or mode mismatch", () => {
    const unknown = {
      ...core(),
      obligations: [{ canonicalInputId: "input_unknown", ruleId: null }],
    };
    assert.throws(() => materializeVerifiedReportV1(fixture(false, [unknown])));
    const input = fixture();
    assert.throws(() =>
      materializeVerifiedReportV1({
        ...input,
        brief: { ...input.brief, briefDigest: binding.snapshotDigest },
      }),
    );
    assert.throws(() => materializeVerifiedReportV1({ ...input, brief: fixture(true).brief }));
  });

  it("prefers demonstrated conflict over unassessed state for the same selected rule", () => {
    const state = { ...core(true), kind: "STANDARD_STATUS", correction: null, scenario: null };
    const states = [
      ReviewClaimCoreV1Schema.parse({
        ...state,
        assertion: "The selected rules conflict.",
        effect: {
          kind: "STANDARD_STATUS",
          ruleId: "rule_paging",
          status: "CONFLICT",
          conflictingRuleIds: ["rule_other"],
        },
      }),
      ReviewClaimCoreV1Schema.parse({
        ...state,
        assertion: "The selected rule remains unassessed.",
        effect: {
          kind: "STANDARD_STATUS",
          ruleId: "rule_paging",
          status: "UNASSESSED",
          conflictingRuleIds: [],
        },
      }),
    ];
    const report = materializeVerifiedReportV1(
      fixture(
        true,
        states,
        states.map(() => ({
          kind: "STANDARD_STATUS",
          status: "DEMONSTRATED",
          correctionStatus: null,
          duplicateOf: null,
          rationale: "The rule state is demonstrated.",
        })),
      ),
    );
    assert.ok("ruleAssessments" in report);
    const rule = report.ruleAssessments.find((entry) => entry.ruleId === "rule_paging");
    assert.equal(rule?.status, "CONFLICT");
    assert.deepEqual(rule?.conflictingRuleIds, ["rule_other"]);
    assert.equal(report.verdict, "UNABLE_TO_VERIFY");
  });
});
