import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  digestEvaluationArtifactV1,
  EvaluationAdjudicationRecordV1Schema,
  EvaluationAttemptRecordV1Schema,
  EvaluationCaseManifestV1Schema,
  EvaluationExperimentManifestV1Schema,
  EvaluationFamilySplitManifestV1Schema,
  EvaluationScoreReportV1Schema,
  serializeEvaluationArtifactV1,
  validateEvaluationFamilySplitV1,
} from "../../evaluation/artifact-contracts.js";

const sha = (value: string) => ({ algorithm: "SHA256" as const, value: value.repeat(64) });
const commit = "1".repeat(40);

const caseManifest = {
  schemaVersion: 1,
  corpusVersion: "corpus_v1",
  caseId: "case_001",
  familyId: "family_checkout",
  pairId: "pair_checkout",
  reviewMode: "REQUIREMENTS",
  source: {
    identityVersion: 1,
    kind: "CUMULATIVE_SNAPSHOT",
    repository: "synthetic://checkout",
    baseCommit: commit,
    baseTreeDigest: sha("a"),
    snapshotDigest: sha("b"),
    provenance: "Repository-owned synthetic fixture.",
  },
  obligations: [{ obligationId: "obligation_currency", text: "Convert dollars once." }],
  reviewerInputInventory: [
    { role: "REQUIREMENTS", reference: "control/requirements.md", digest: sha("c") },
    { role: "SOURCE_CHANGE", reference: "checkout.mjs", digest: sha("d") },
  ],
  oracleInventory: {
    expectedVerdict: "NOT_READY",
    expectedRoots: [
      {
        rootId: "root_double_conversion",
        obligationId: "obligation_currency",
        description: "Checkout converts cents a second time.",
      },
    ],
    expectedUncertainties: [],
    labelsExhaustive: true,
    artifacts: [
      { role: "HIDDEN_TEST", reference: "oracles/double-conversion.test.mjs", digest: sha("e") },
    ],
  },
};

const caseManifestDigest = () =>
  digestEvaluationArtifactV1(EvaluationCaseManifestV1Schema, caseManifest);

describe("evaluation artifact contracts", () => {
  it("keeps evaluator oracles structurally separate from permitted reviewer inputs", () => {
    const parsed = EvaluationCaseManifestV1Schema.parse(caseManifest);

    assert.equal(
      parsed.reviewerInputInventory.some((entry) => entry.reference.includes("oracles/")),
      false,
    );
    assert.equal(parsed.oracleInventory.artifacts[0]?.role, "HIDDEN_TEST");
    assert.throws(
      () =>
        EvaluationCaseManifestV1Schema.parse({
          ...caseManifest,
          reviewerInputInventory: [
            {
              role: "HIDDEN_TEST",
              reference: "oracles/double-conversion.test.mjs",
              digest: sha("e"),
            },
          ],
        }),
      /invalid option/i,
    );
    assert.throws(
      () =>
        EvaluationCaseManifestV1Schema.parse({
          ...caseManifest,
          reviewerInputInventory: [
            {
              role: "TEST_EVIDENCE",
              reference: "oracles/double-conversion.test.mjs",
              digest: sha("e"),
            },
          ],
        }),
      /oracle artifact.*reviewer input/i,
    );
  });

  it("rejects family assignments that split paired cases across development and holdout", () => {
    assert.throws(
      () =>
        EvaluationFamilySplitManifestV1Schema.parse({
          schemaVersion: 1,
          corpusVersion: "corpus_v1",
          splitVersion: "split_v1",
          assignments: [
            {
              caseId: "case_001",
              caseManifestDigest: sha("9"),
              familyId: "family_checkout",
              split: "DEVELOPMENT",
            },
            {
              caseId: "case_002",
              caseManifestDigest: sha("0"),
              familyId: "family_checkout",
              split: "HOLDOUT",
            },
          ],
        }),
      /family_checkout.*both/i,
    );
  });

  it("cross-checks split assignments against case family and corpus identities", () => {
    const split = {
      schemaVersion: 1,
      corpusVersion: "corpus_v1",
      splitVersion: "split_v1",
      assignments: [
        {
          caseId: "case_001",
          caseManifestDigest: caseManifestDigest(),
          familyId: "family_other",
          split: "DEVELOPMENT",
        },
      ],
    };

    assert.throws(() => validateEvaluationFamilySplitV1(split, [caseManifest]), /family identity/i);
  });

  it("keeps an explicit pair in one split even when its cases have different families", () => {
    const secondCase = {
      ...caseManifest,
      caseId: "case_002",
      familyId: "family_shipping",
    };
    const split = {
      schemaVersion: 1,
      corpusVersion: "corpus_v1",
      splitVersion: "split_v1",
      assignments: [
        {
          caseId: "case_001",
          caseManifestDigest: caseManifestDigest(),
          familyId: "family_checkout",
          split: "DEVELOPMENT",
        },
        {
          caseId: "case_002",
          caseManifestDigest: digestEvaluationArtifactV1(
            EvaluationCaseManifestV1Schema,
            secondCase,
          ),
          familyId: "family_shipping",
          split: "HOLDOUT",
        },
      ],
    };

    assert.throws(
      () => validateEvaluationFamilySplitV1(split, [caseManifest, secondCase]),
      /pair_checkout.*both/i,
    );
  });

  it("binds each split assignment to exact case-manifest bytes", () => {
    const split = {
      schemaVersion: 1,
      corpusVersion: "corpus_v1",
      splitVersion: "split_v1",
      assignments: [
        {
          caseId: "case_001",
          caseManifestDigest: sha("9"),
          familyId: "family_checkout",
          split: "DEVELOPMENT",
        },
      ],
    };

    assert.throws(
      () => validateEvaluationFamilySplitV1(split, [caseManifest]),
      /case manifest identity/i,
    );
  });

  it("requires exact source and engine identities instead of moving refs", () => {
    assert.throws(
      () =>
        EvaluationCaseManifestV1Schema.parse({
          ...caseManifest,
          source: { ...caseManifest.source, baseCommit: "main" },
        }),
      /invalid string/i,
    );

    assert.throws(
      () =>
        EvaluationExperimentManifestV1Schema.parse({
          schemaVersion: 1,
          experimentId: "experiment_baseline",
          corpusVersion: "corpus_v1",
          splitManifestDigest: sha("f"),
          scorerVersion: "scorer_v1",
          scorerPolicyDigest: sha("0"),
          engine: {
            commit: "main",
            sourceTreeDigest: sha("1"),
            dirtyStateDigest: null,
          },
          caseIds: ["case_001"],
          variants: [
            {
              variantId: "variant_baseline",
              modelId: "openai/gpt-oss-120b",
              providerPolicyDigest: sha("2"),
              promptVersions: ["preliminary-v17", "final-v17"],
              schemaVersions: ["preliminary-v1", "final-v1"],
            },
          ],
          environment: { nodeVersion: "24.8.0", platform: "darwin", architecture: "arm64" },
          repetitionCount: 1,
          seed: null,
          budgets: { maxTotalCostUsd: 0.4, maxElapsedMs: 3_600_000 },
          stopRules: ["Stop on oracle leakage."],
        }),
      /invalid string/i,
    );
  });

  it("distinguishes terminal provider failure from semantic abstention", () => {
    const common = {
      schemaVersion: 1,
      attemptId: "attempt_case_001_1",
      experimentId: "experiment_baseline",
      caseId: "case_001",
      familyId: "family_checkout",
      split: "DEVELOPMENT",
      variantId: "variant_baseline",
      repetition: 1,
      sourceIdentityDigest: sha("3"),
      engineIdentityDigest: sha("4"),
      runtimeRunReference: null,
      startedAt: "2026-09-15T12:00:00.000Z",
      completedAt: "2026-09-15T12:00:01.000Z",
      elapsedMs: 1_000,
      usage: {
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        knownCostUsd: null,
        unknownCostReservationUsd: 0.02,
      },
    };
    const providerFailure = EvaluationAttemptRecordV1Schema.parse({
      ...common,
      stageOutcomes: [{ stage: "FINAL", state: "FAILED", artifactDigest: null }],
      terminalOutcome: {
        kind: "PROVIDER_FAILURE",
        stage: "FINAL",
        failureCode: "HTTP_502",
        transportUncertain: false,
      },
    });
    const abstention = EvaluationAttemptRecordV1Schema.parse({
      ...common,
      runtimeRunReference: ".review-runs/case_001",
      stageOutcomes: [{ stage: "FINAL", state: "SUCCEEDED", artifactDigest: sha("5") }],
      terminalOutcome: {
        kind: "SEMANTIC_ABSTENTION",
        reportDigest: sha("5"),
        reason: "Required evidence was unavailable.",
      },
    });

    assert.equal(providerFailure.terminalOutcome.kind, "PROVIDER_FAILURE");
    assert.equal(abstention.terminalOutcome.kind, "SEMANTIC_ABSTENTION");
    assert.throws(
      () =>
        EvaluationAttemptRecordV1Schema.parse({
          ...common,
          stageOutcomes: [],
          terminalOutcome: {
            kind: "PROVIDER_FAILURE",
            stage: "FINAL",
            failureCode: "HTTP_502",
            transportUncertain: false,
          },
        }),
      /provider failure.*failed stage outcome/i,
    );
  });

  it("requires unresolved adjudication disagreement to remain explicit", () => {
    const unresolved = {
      schemaVersion: 1,
      adjudicationId: "adjudication_case_001_finding_1",
      attemptId: "attempt_case_001_1",
      findingReference: "finding_1",
      claimDigest: sha("6"),
      label: "UNRESOLVED",
      matchedRootId: null,
      causalEvidence: [],
      adjudicator: { type: "HUMAN", identity: "reviewer@example.invalid" },
      rationale: "Evidence supports two plausible interpretations.",
      unresolvedDisagreement: "Second adjudicator disagrees about reachability.",
      adjudicatedAt: "2026-09-15T12:05:00.000Z",
    };
    assert.equal(
      EvaluationAdjudicationRecordV1Schema.parse(unresolved).unresolvedDisagreement,
      unresolved.unresolvedDisagreement,
    );
    assert.throws(
      () =>
        EvaluationAdjudicationRecordV1Schema.parse({
          ...unresolved,
          unresolvedDisagreement: null,
        }),
      /unresolved disagreement/i,
    );
  });

  it("represents zero-denominator metrics as unavailable and preserves unresolved counts", () => {
    const score = {
      schemaVersion: 1,
      scoreId: "score_baseline",
      experimentId: "experiment_baseline",
      scorerVersion: "scorer_v1",
      scorerPolicyDigest: sha("7"),
      generatedAt: "2026-09-15T12:10:00.000Z",
      metrics: [{ metric: "CLEAN_FALSE_POSITIVE_RATE", numerator: 0, denominator: 0, value: null }],
      adjudicationCoverage: {
        totalClaims: 2,
        resolvedClaims: 1,
        unresolvedClaims: 1,
        unresolvedAdjudicationIds: ["adjudication_case_001_finding_1"],
      },
      missingness: { startedAttempts: 2, deliveredReports: 1, missingReports: 1 },
      caseBreakdowns: [],
      familyBreakdowns: [],
      pairedDeltas: [],
      rawArtifactDigests: [sha("8")],
    };
    assert.equal(EvaluationScoreReportV1Schema.parse(score).metrics[0]?.value, null);
    assert.throws(
      () =>
        EvaluationScoreReportV1Schema.parse({
          ...score,
          metrics: [
            { metric: "CLEAN_FALSE_POSITIVE_RATE", numerator: 0, denominator: 0, value: 1 },
          ],
        }),
      /zero denominator.*unavailable/i,
    );
    assert.throws(
      () =>
        EvaluationScoreReportV1Schema.parse({
          ...score,
          adjudicationCoverage: {
            totalClaims: 2,
            resolvedClaims: 0,
            unresolvedClaims: 2,
            unresolvedAdjudicationIds: [
              "adjudication_case_001_finding_1",
              "adjudication_case_001_finding_1",
            ],
          },
        }),
      /duplicate unresolved adjudication ID/i,
    );
  });

  it("serializes parsed artifacts deterministically and digests exact document bytes", () => {
    const reordered = {
      oracleInventory: caseManifest.oracleInventory,
      source: caseManifest.source,
      reviewerInputInventory: [...caseManifest.reviewerInputInventory].reverse(),
      obligations: caseManifest.obligations,
      reviewMode: caseManifest.reviewMode,
      pairId: caseManifest.pairId,
      familyId: caseManifest.familyId,
      caseId: caseManifest.caseId,
      corpusVersion: caseManifest.corpusVersion,
      schemaVersion: caseManifest.schemaVersion,
    };
    const first = serializeEvaluationArtifactV1(EvaluationCaseManifestV1Schema, caseManifest);
    const second = serializeEvaluationArtifactV1(EvaluationCaseManifestV1Schema, reordered);

    assert.equal(first, second);
    assert.equal(first.endsWith("\n"), true);
    assert.deepEqual(
      digestEvaluationArtifactV1(EvaluationCaseManifestV1Schema, caseManifest),
      digestEvaluationArtifactV1(EvaluationCaseManifestV1Schema, JSON.parse(first) as unknown),
    );
  });
});
