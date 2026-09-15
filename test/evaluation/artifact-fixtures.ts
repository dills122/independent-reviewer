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
const metrics = () =>
  metricNames.map((metric) => ({ metric, numerator: 1, denominator: 2, value: 0.5, interval }));
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
    scorerVersion: "scorer_v1",
    scorerPolicyDigest: sha("3"),
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
          { stage: "PRELIMINARY", state: "SUCCEEDED", artifactDigest: sha("9"), elapsedMs: 300 },
          {
            stage: "FINDING_VERIFICATION",
            state: "SUCCEEDED",
            artifactDigest: sha("a"),
            elapsedMs: 300,
          },
          { stage: "FINAL", state: "SUCCEEDED", artifactDigest: reportDigest, elapsedMs: 400 },
        ],
        findingClaims: [
          {
            findingReference: `finding_${suffix}`,
            claimDigest: sha(index === 0 ? "b" : "c"),
            emittedAtStage: "FINAL",
          },
        ],
        terminalOutcome: {
          kind: "DELIVERED",
          reportDigest,
          verdict: caseManifest.pair.role === "DEFECT" ? "NOT_READY" : "READY",
        },
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          knownCostUsd: 0.01,
          providerAttempts: 3,
          unknownCostAttempts: 0,
          conservativeChargeUsd: 0.01,
          admittedCeilingUsd: 0.02,
          evidenceBytes: 100,
          outputBytes: 50,
        },
      };
    }),
  );
  const adjudications = attempts.map((attempt, index) => {
    const defect = attempt.caseId === "case_defect";
    const claim = attempt.findingClaims[0];
    if (claim === undefined) throw new TypeError("fixture attempt must contain one claim");
    return {
      schemaVersion: 1,
      adjudicationId: `adjudication_${index + 1}`,
      experimentId: experiment.experimentId,
      experimentManifestDigest,
      attemptId: attempt.attemptId,
      caseId: attempt.caseId,
      findingReference: claim.findingReference,
      claimDigest: claim.claimDigest,
      label: defect ? "MATCHED_DEFECT" : "INVALID_DEFECT",
      matchedRootId: defect ? "root_double_conversion" : null,
      causalEvidence: defect ? [{ reference: "checkout.mjs:10", digest: sha("d") }] : [],
      adjudicator: { type: "MODEL_ASSISTED", identity: "judge-v1" },
      promotionAuthority: defect ? { type: "HUMAN", identity: "reviewer@example.invalid" } : null,
      rationale: defect
        ? "Reachable wrong conversion with causal source evidence."
        : "Scenario is not present.",
      unresolvedDisagreement: null,
      adjudicatedAt: "2026-09-15T12:05:00.000Z",
    };
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
    metrics: metrics(),
    adjudicationCoverage: {
      totalClaims: 4,
      resolvedClaims: 4,
      unresolvedClaims: 0,
      unresolvedAdjudicationIds: [],
    },
    missingness: { startedAttempts: 4, deliveredReports: 4, missingReports: 0 },
    caseBreakdowns: cases.map((value) => ({
      caseId: value.caseId,
      familyId: value.familyId,
      split: "DEVELOPMENT",
      metrics: metrics(),
    })),
    familyBreakdowns: [{ familyId: "family_checkout", split: "DEVELOPMENT", metrics: metrics() }],
    pairedDeltas: [
      {
        pairId: "pair_checkout",
        baselineVariantId: "variant_baseline",
        candidateVariantId: "variant_candidate",
        metric: "KNOWN_DEFECT_RECALL_COMPLETED",
        baselineValue: 0.5,
        candidateValue: 0.5,
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
    resources: { providerAttempts: 12, evidenceBytes: 400, outputBytes: 200, execution: [] },
    cost: {
      reportedCostUsd: 0.04,
      unknownCostAttempts: 0,
      conservativeChargeUsd: 0.04,
      admittedCeilingUsd: 0.08,
    },
    rawArtifactReferences,
  };
  return { cases, split, experiment, attempts, adjudications, score };
}
