import {
  digestEvaluationArtifactV1,
  EvaluationAdjudicationRecordV1Schema,
  EvaluationAttemptRecordV1Schema,
  EvaluationCaseManifestV1Schema,
  EvaluationEngineIdentityV1Schema,
  EvaluationExperimentManifestV1Schema,
  EvaluationFamilySplitManifestV1Schema,
  EvaluationSourceIdentityV1Schema,
} from "../../evaluation/artifact-contracts.js";
import {
  EVALUATION_SCORER_POLICY_DIGEST_V1,
  EVALUATION_SCORER_VERSION_V1,
} from "../../evaluation/scorer-policy.js";

export const sha = (value: string) => ({ algorithm: "SHA256" as const, value: value.repeat(64) });

const commit = "1".repeat(40);

function makeCase(caseId: "case_defect" | "case_clean", role: "DEFECT" | "CLEAN") {
  const defect = role === "DEFECT";
  return {
    schemaVersion: 1,
    corpusVersion: "corpus_v1",
    caseId,
    familyId: "family_checkout",
    pair: { pairId: "pair_checkout", role },
    reviewMode: "REQUIREMENTS",
    source: {
      identityVersion: 1,
      kind: "CUMULATIVE_SNAPSHOT",
      repository: `synthetic://${caseId}`,
      baseCommit: commit,
      baseTreeDigest: sha(defect ? "a" : "b"),
      snapshotDigest: sha(defect ? "c" : "d"),
      provenance: "Repository-owned synthetic fixture.",
    },
    obligations: [{ obligationId: "obligation_currency", text: "Convert dollars once." }],
    reviewerInputInventory: [
      { role: "REQUIREMENTS", reference: "control/requirements.md", digest: sha("e") },
      { role: "SOURCE_CHANGE", reference: "checkout.mjs", digest: sha(defect ? "f" : "0") },
    ],
    oracleInventory: {
      expectedVerdict: defect ? "NOT_READY" : "READY",
      expectedRoots: defect
        ? [
            {
              rootId: "root_double_conversion",
              obligationId: "obligation_currency",
              description: "Checkout converts cents a second time.",
            },
          ]
        : [],
      expectedUncertainties: [],
      labelsExhaustive: true,
      artifacts: defect
        ? [
            {
              role: "HIDDEN_TEST",
              reference: "oracles/double-conversion.test.mjs",
              digest: sha("2"),
            },
          ]
        : [],
    },
  };
}

const metricNames = [
  "KNOWN_DEFECT_RECALL_COMPLETED",
  "KNOWN_DEFECT_RECALL_ALL_STARTS",
  "ADJUDICATED_DEFECT_PRECISION",
  "CONSERVATIVE_PRECISION_BOUND",
  "UNIQUE_ACTION_YIELD",
  "CLEAN_FALSE_POSITIVE_RATE",
  "FALSE_ABSTENTION_RATE",
  "CORRECT_UNCERTAINTY_RATE",
  "DUPLICATE_RATE",
  "DELIVERY_RATE",
  "STAGE_RETENTION_RATE",
] as const;

const interval = {
  method: "Wilson score",
  confidenceLevel: 0.95,
  lower: 0,
  upper: 1,
  independentUnit: "CASE",
};
type MetricName = (typeof metricNames)[number];
type Count = { metric: MetricName; numerator: number; denominator: number };
const scoredMetrics = (counts: readonly Count[]) =>
  counts.map(({ metric, numerator, denominator }) => ({
    metric,
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
    interval: denominator === 0 ? null : interval,
  }));
const attemptCounts = (defect: boolean): Count[] => [
  {
    metric: "KNOWN_DEFECT_RECALL_COMPLETED",
    numerator: defect ? 1 : 0,
    denominator: defect ? 1 : 0,
  },
  {
    metric: "KNOWN_DEFECT_RECALL_ALL_STARTS",
    numerator: defect ? 1 : 0,
    denominator: defect ? 1 : 0,
  },
  { metric: "ADJUDICATED_DEFECT_PRECISION", numerator: defect ? 1 : 0, denominator: 1 },
  { metric: "CONSERVATIVE_PRECISION_BOUND", numerator: defect ? 1 : 0, denominator: 1 },
  { metric: "UNIQUE_ACTION_YIELD", numerator: defect ? 1 : 0, denominator: defect ? 2 : 1 },
  { metric: "CLEAN_FALSE_POSITIVE_RATE", numerator: defect ? 0 : 1, denominator: defect ? 0 : 1 },
  { metric: "FALSE_ABSTENTION_RATE", numerator: 0, denominator: 1 },
  { metric: "CORRECT_UNCERTAINTY_RATE", numerator: 0, denominator: 0 },
  { metric: "DUPLICATE_RATE", numerator: defect ? 1 : 0, denominator: defect ? 2 : 1 },
  { metric: "DELIVERY_RATE", numerator: 1, denominator: 1 },
  {
    metric: "STAGE_RETENTION_RATE",
    numerator: defect ? 2 : 0,
    denominator: defect ? 2 : 0,
  },
];
const addCounts = (groups: readonly Count[][]): Count[] =>
  metricNames.map((metric) => ({
    metric,
    numerator: groups.reduce(
      (sum, counts) => sum + (counts.find((entry) => entry.metric === metric)?.numerator ?? 0),
      0,
    ),
    denominator: groups.reduce(
      (sum, counts) => sum + (counts.find((entry) => entry.metric === metric)?.denominator ?? 0),
      0,
    ),
  }));
const distribution = (value: number) => ({
  count: 4,
  minimum: value,
  median: value,
  p95: value,
  maximum: value,
});

export function makeEvaluationGraph() {
  const cases = [makeCase("case_defect", "DEFECT"), makeCase("case_clean", "CLEAN")];
  const split = {
    schemaVersion: 1,
    corpusVersion: "corpus_v1",
    splitVersion: "split_v1",
    assignments: cases.map((caseManifest) => ({
      caseId: caseManifest.caseId,
      caseManifestDigest: digestEvaluationArtifactV1(EvaluationCaseManifestV1Schema, caseManifest),
      familyId: caseManifest.familyId,
      split: "DEVELOPMENT",
    })),
  };
  const experiment = {
    schemaVersion: 1,
    experimentId: "experiment_baseline",
    corpusVersion: "corpus_v1",
    splitManifestDigest: digestEvaluationArtifactV1(EvaluationFamilySplitManifestV1Schema, split),
    scorerVersion: EVALUATION_SCORER_VERSION_V1,
    scorerPolicyDigest: EVALUATION_SCORER_POLICY_DIGEST_V1,
    engine: { commit, sourceTreeDigest: sha("4"), dirtyStateDigest: null },
    caseIds: cases.map(({ caseId }) => caseId),
    variants: ["baseline", "candidate"].map((name) => ({
      variantId: `variant_${name}`,
      modelId: "openai/gpt-oss-120b",
      providerPolicyDigest: sha(name === "baseline" ? "5" : "6"),
      promptVersions: ["preliminary-v17", "final-v17"],
      schemaVersions: ["preliminary-v1", "final-v1"],
    })),
    environment: { nodeVersion: "24.8.0", platform: "darwin", architecture: "arm64" },
    repetitionCount: 1,
    seed: 7,
    budgets: { maxTotalCostUsd: 0.08, maxElapsedMs: 3_600_000 },
    stopRules: ["Stop on oracle leakage."],
    metricSet: [...metricNames],
    comparisons: [
      {
        comparisonId: "comparison_candidate",
        baselineVariantId: "variant_baseline",
        candidateVariantId: "variant_candidate",
        pairIds: ["pair_checkout"],
        metrics: ["KNOWN_DEFECT_RECALL_COMPLETED"],
      },
    ],
  };
  const experimentManifestDigest = digestEvaluationArtifactV1(
    EvaluationExperimentManifestV1Schema,
    experiment,
  );
  const engineIdentityDigest = digestEvaluationArtifactV1(
    EvaluationEngineIdentityV1Schema,
    experiment.engine,
  );
  const attempts = cases.flatMap((caseManifest) =>
    experiment.variants.map((variant, index) => {
      const defect = caseManifest.pair.role === "DEFECT";
      const suffix = `${caseManifest.caseId}_${index + 1}`;
      const reportDigest = sha(index === 0 ? "7" : "8");
      return {
        schemaVersion: 1,
        attemptId: `attempt_${suffix}`,
        experimentId: experiment.experimentId,
        experimentManifestDigest,
        caseId: caseManifest.caseId,
        familyId: caseManifest.familyId,
        split: "DEVELOPMENT",
        variantId: variant.variantId,
        repetition: 1,
        sourceIdentityDigest: digestEvaluationArtifactV1(
          EvaluationSourceIdentityV1Schema,
          caseManifest.source,
        ),
        engineIdentityDigest,
        runtimeRunReference: `.review-runs/${suffix}`,
        startedAt: "2026-09-15T12:00:00.000Z",
        completedAt: "2026-09-15T12:00:01.000Z",
        elapsedMs: 1_000,
        stageOutcomes: [
          {
            stage: "PRELIMINARY",
            state: "SUCCEEDED",
            artifactDigest: sha("9"),
            elapsedMs: 300,
            providerCall: true,
          },
          {
            stage: "FINDING_VERIFICATION",
            state: "SUCCEEDED",
            artifactDigest: sha("a"),
            elapsedMs: 300,
            providerCall: defect,
          },
          {
            stage: "FINAL",
            state: "SUCCEEDED",
            artifactDigest: reportDigest,
            elapsedMs: 400,
            providerCall: true,
          },
        ],
        findingClaims: defect
          ? [
              {
                findingReference: `finding_preliminary_true_${suffix}`,
                claimDigest: sha("d"),
                emittedAtStage: "PRELIMINARY",
                claimKind: "DEFECT",
              },
              {
                findingReference: `finding_preliminary_false_${suffix}`,
                claimDigest: sha("e"),
                emittedAtStage: "PRELIMINARY",
                claimKind: "DEFECT",
              },
              {
                findingReference: `finding_${suffix}`,
                claimDigest: sha(index === 0 ? "b" : "c"),
                emittedAtStage: "FINAL",
                claimKind: "DEFECT",
              },
              {
                findingReference: `finding_duplicate_${suffix}`,
                claimDigest: sha("f"),
                emittedAtStage: "FINAL",
                claimKind: "DEFECT",
              },
            ]
          : [
              {
                findingReference: `finding_${suffix}`,
                claimDigest: sha(index === 0 ? "b" : "c"),
                emittedAtStage: "FINAL",
                claimKind: "DEFECT",
              },
            ],
        terminalOutcome: {
          kind: "DELIVERED",
          reportReference: `.review-runs/${suffix}/report.json`,
          reportDigest,
          verdict: caseManifest.pair.role === "DEFECT" ? "NOT_READY" : "READY",
        },
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          knownCostUsd: 0.01,
          providerAttempts: defect ? 3 : 2,
          knownCostAttempts: defect ? 3 : 2,
          unknownCostAttempts: 0,
          conservativeChargeUsd: 0.01,
          admittedCeilingUsd: 0.02,
          evidenceBytes: 100,
          outputBytes: 50,
        },
      };
    }),
  );
  const adjudications = attempts.flatMap((attempt, attemptIndex) => {
    const defect = attempt.caseId === "case_defect";
    const caseManifest = cases.find(({ caseId }) => caseId === attempt.caseId);
    if (caseManifest === undefined) throw new TypeError("fixture attempt case must exist");
    const sourceInput = caseManifest.reviewerInputInventory.find(
      ({ role }) => role === "SOURCE_CHANGE",
    );
    if (sourceInput === undefined) throw new TypeError("fixture case needs source input");
    return attempt.findingClaims.map((claim, claimIndex) => {
      const preliminaryTrue = claim.findingReference.includes("preliminary_true");
      const duplicate = claim.findingReference.includes("duplicate");
      const supported =
        defect && (preliminaryTrue || duplicate || claim.emittedAtStage === "FINAL");
      const label = supported ? (duplicate ? "DUPLICATE" : "MATCHED_DEFECT") : "INVALID_DEFECT";
      return {
        schemaVersion: 1,
        adjudicationId: `adjudication_${attemptIndex + 1}_${claimIndex + 1}`,
        experimentId: experiment.experimentId,
        experimentManifestDigest,
        attemptId: attempt.attemptId,
        caseId: attempt.caseId,
        findingReference: claim.findingReference,
        claimDigest: claim.claimDigest,
        label,
        matchedRootId: supported ? "root_double_conversion" : null,
        causalEvidence: supported
          ? [{ source: "CASE_INPUT", reference: sourceInput.reference, digest: sourceInput.digest }]
          : [],
        matchedUncertaintyId: null,
        severityCalibration: supported
          ? { expected: "BLOCKING", observed: "BLOCKING" }
          : { expected: "NOT_APPLICABLE", observed: "BLOCKING" },
        enforcementClassification: null,
        adjudicator: { type: "MODEL_ASSISTED", identity: "judge-v1" },
        promotionAuthority: supported
          ? { type: "HUMAN", identity: "reviewer@example.invalid" }
          : null,
        rationale: supported
          ? "Reachable wrong conversion with causal source evidence."
          : "Scenario is not present.",
        unresolvedDisagreement: null,
        adjudicatedAt: "2026-09-15T12:05:00.000Z",
      };
    });
  });
  const rawArtifactReferences = [
    ...cases.map((value) => ({
      type: "CASE",
      id: value.caseId,
      reference: `cases/${value.caseId}.json`,
      digest: digestEvaluationArtifactV1(EvaluationCaseManifestV1Schema, value),
    })),
    {
      type: "SPLIT",
      id: split.splitVersion,
      reference: "split.json",
      digest: digestEvaluationArtifactV1(EvaluationFamilySplitManifestV1Schema, split),
    },
    {
      type: "EXPERIMENT",
      id: experiment.experimentId,
      reference: "experiment.json",
      digest: experimentManifestDigest,
    },
    ...attempts.map((value) => ({
      type: "ATTEMPT",
      id: value.attemptId,
      reference: `attempts/${value.attemptId}.json`,
      digest: digestEvaluationArtifactV1(EvaluationAttemptRecordV1Schema, value),
    })),
    ...adjudications.map((value) => ({
      type: "ADJUDICATION",
      id: value.adjudicationId,
      reference: `adjudications/${value.adjudicationId}.json`,
      digest: digestEvaluationArtifactV1(EvaluationAdjudicationRecordV1Schema, value),
    })),
  ];
  const score = {
    schemaVersion: 1,
    scoreId: "score_baseline",
    experimentId: experiment.experimentId,
    experimentManifestDigest,
    scorerVersion: experiment.scorerVersion,
    scorerPolicyDigest: experiment.scorerPolicyDigest,
    generatedAt: "2026-09-15T12:10:00.000Z",
    metrics: scoredMetrics(
      addCounts(attempts.map((attempt) => attemptCounts(attempt.caseId === "case_defect"))),
    ),
    adjudicationCoverage: {
      totalClaims: 10,
      resolvedClaims: 10,
      unresolvedClaims: 0,
      unresolvedAdjudicationIds: [],
    },
    missingness: { startedAttempts: 4, deliveredReports: 4, missingReports: 0 },
    caseBreakdowns: cases.map((value) => ({
      caseId: value.caseId,
      familyId: value.familyId,
      split: "DEVELOPMENT",
      metrics: scoredMetrics(
        addCounts(
          attempts
            .filter(({ caseId }) => caseId === value.caseId)
            .map(() => attemptCounts(value.caseId === "case_defect")),
        ),
      ),
    })),
    familyBreakdowns: [
      {
        familyId: "family_checkout",
        split: "DEVELOPMENT",
        metrics: scoredMetrics(
          addCounts(attempts.map((attempt) => attemptCounts(attempt.caseId === "case_defect"))),
        ),
      },
    ],
    attemptEvidence: attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      attemptDigest: digestEvaluationArtifactV1(EvaluationAttemptRecordV1Schema, attempt),
      adjudicationIds: adjudications
        .filter(({ attemptId }) => attemptId === attempt.attemptId)
        .map(({ adjudicationId }) => adjudicationId),
      metrics: attemptCounts(attempt.caseId === "case_defect"),
      resources: {
        providerAttempts: attempt.usage.providerAttempts,
        knownCostAttempts: attempt.usage.knownCostAttempts,
        evidenceBytes: attempt.usage.evidenceBytes,
        outputBytes: attempt.usage.outputBytes,
        reportedCostUsd: attempt.usage.knownCostUsd ?? 0,
        unknownCostAttempts: attempt.usage.unknownCostAttempts,
        conservativeChargeUsd: attempt.usage.conservativeChargeUsd,
        admittedCeilingUsd: attempt.usage.admittedCeilingUsd,
      },
    })),
    severityCalibration: {
      eligibleAdjudications: 10,
      classifiedAdjudications: 10,
      exact: 6,
      underclassified: 0,
      overclassified: 4,
      unavailableAdjudicationIds: [],
    },
    enforcementConfusion: {
      eligibleAdjudications: 0,
      classifiedAdjudications: 0,
      cells: ["REQUIRED", "RECOMMENDED", "NOT_APPLICABLE", "UNAVAILABLE"].flatMap((expected) =>
        ["REQUIRED", "RECOMMENDED", "NOT_APPLICABLE", "UNAVAILABLE"].map((observed) => ({
          expected,
          observed,
          count: 0,
        })),
      ),
      unavailableAdjudicationIds: [],
    },
    pairedDeltas: [
      {
        comparisonId: "comparison_candidate",
        pairId: "pair_checkout",
        baselineVariantId: "variant_baseline",
        candidateVariantId: "variant_candidate",
        metric: "KNOWN_DEFECT_RECALL_COMPLETED",
        baselineValue: 1,
        candidateValue: 1,
        delta: 0,
      },
    ],
    latency: {
      perReviewMs: distribution(1_000),
      perStageMs: {
        preliminary: distribution(300),
        findingVerification: distribution(300),
        final: distribution(400),
      },
    },
    resources: { providerAttempts: 10, evidenceBytes: 400, outputBytes: 200, execution: [] },
    cost: {
      reportedCostUsd: 0.04,
      knownCostAttempts: 10,
      unknownCostAttempts: 0,
      conservativeChargeUsd: 0.04,
      admittedCeilingUsd: 0.08,
    },
    rawArtifactReferences,
  };
  return { cases, split, experiment, attempts, adjudications, score };
}
