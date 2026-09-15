import {
  digestEvaluationArtifactV1,
  EvaluationAdjudicationRecordV1Schema,
  EvaluationAttemptRecordV1Schema,
  EvaluationCaseManifestV1Schema,
  EvaluationEngineIdentityV1Schema,
  EvaluationExperimentManifestV1Schema,
  EvaluationFamilySplitManifestV1Schema,
  EvaluationScoreReportV1Schema,
  EvaluationSourceIdentityV1Schema,
  validateEvaluationFamilySplitV1,
} from "./artifact-contracts.js";

export interface EvaluationArtifactGraphInputV1 {
  experiment: unknown;
  split: unknown;
  cases: readonly unknown[];
  attempts: readonly unknown[];
  adjudications: readonly unknown[];
  score: unknown;
}

function assertEqual(actual: string | number, expected: string | number, message: string): void {
  if (actual !== expected) throw new TypeError(message);
}

function summarize(values: readonly number[]): {
  count: number;
  minimum: number | null;
  median: number | null;
  p95: number | null;
  maximum: number | null;
} {
  if (values.length === 0) {
    return { count: 0, minimum: null, median: null, p95: null, maximum: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
      : (sorted[middle] as number);
  return {
    count: sorted.length,
    minimum: sorted[0] as number,
    median,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] as number,
    maximum: sorted.at(-1) as number,
  };
}

function assertDistribution(
  actual: {
    count: number;
    minimum: number | null;
    median: number | null;
    p95: number | null;
    maximum: number | null;
  },
  values: readonly number[],
  label: string,
): void {
  const expected = summarize(values);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError(`score ${label} distribution does not match attempts`);
  }
}

export function validateEvaluationArtifactGraphV1(input: EvaluationArtifactGraphInputV1): void {
  const experiment = EvaluationExperimentManifestV1Schema.parse(input.experiment);
  const split = EvaluationFamilySplitManifestV1Schema.parse(input.split);
  const cases = input.cases.map((value) => EvaluationCaseManifestV1Schema.parse(value));
  const attempts = input.attempts.map((value) => EvaluationAttemptRecordV1Schema.parse(value));
  const adjudications = input.adjudications.map((value) =>
    EvaluationAdjudicationRecordV1Schema.parse(value),
  );
  const score = EvaluationScoreReportV1Schema.parse(input.score);

  validateEvaluationFamilySplitV1(split, cases);
  const splitDigest = digestEvaluationArtifactV1(EvaluationFamilySplitManifestV1Schema, split);
  const experimentDigest = digestEvaluationArtifactV1(
    EvaluationExperimentManifestV1Schema,
    experiment,
  );
  assertEqual(
    experiment.splitManifestDigest.value,
    splitDigest.value,
    "experiment has a different split manifest identity",
  );
  assertEqual(
    experiment.corpusVersion,
    split.corpusVersion,
    "experiment has a different corpus identity",
  );

  const caseById = new Map(cases.map((caseManifest) => [caseManifest.caseId, caseManifest]));
  const assignmentByCase = new Map(split.assignments.map((entry) => [entry.caseId, entry]));
  const expectedCaseIds = [...caseById.keys()].sort();
  assertEqual(
    JSON.stringify(experiment.caseIds),
    JSON.stringify(expectedCaseIds),
    "experiment case set does not equal split case set",
  );

  const engineDigest = digestEvaluationArtifactV1(
    EvaluationEngineIdentityV1Schema,
    experiment.engine,
  );
  const variantIds = new Set(experiment.variants.map(({ variantId }) => variantId));
  const attemptByPlan = new Map<string, (typeof attempts)[number]>();
  const attemptById = new Map<string, (typeof attempts)[number]>();
  for (const attempt of attempts) {
    assertEqual(
      attempt.experimentId,
      experiment.experimentId,
      "attempt has a different experiment ID",
    );
    assertEqual(
      attempt.experimentManifestDigest.value,
      experimentDigest.value,
      "attempt has a different experiment manifest identity",
    );
    const caseManifest = caseById.get(attempt.caseId);
    if (!caseManifest) throw new TypeError(`attempt contains unknown case ${attempt.caseId}`);
    const assignment = assignmentByCase.get(attempt.caseId);
    if (!assignment) throw new TypeError(`attempt case ${attempt.caseId} has no split assignment`);
    assertEqual(attempt.familyId, caseManifest.familyId, "attempt has a different family identity");
    assertEqual(attempt.split, assignment.split, "attempt has a different split identity");
    assertEqual(
      attempt.sourceIdentityDigest.value,
      digestEvaluationArtifactV1(EvaluationSourceIdentityV1Schema, caseManifest.source).value,
      "attempt has a different source identity",
    );
    assertEqual(
      attempt.engineIdentityDigest.value,
      engineDigest.value,
      "attempt has a different engine identity",
    );
    if (!variantIds.has(attempt.variantId))
      throw new TypeError(`attempt contains unknown variant ${attempt.variantId}`);
    if (attempt.repetition > experiment.repetitionCount)
      throw new TypeError("attempt repetition exceeds experiment plan");
    const planKey = `${attempt.caseId}:${attempt.variantId}:${attempt.repetition}`;
    if (attemptByPlan.has(planKey)) throw new TypeError(`duplicate planned attempt ${planKey}`);
    if (attemptById.has(attempt.attemptId))
      throw new TypeError(`duplicate attempt ID ${attempt.attemptId}`);
    attemptByPlan.set(planKey, attempt);
    attemptById.set(attempt.attemptId, attempt);
  }
  for (const caseId of experiment.caseIds) {
    for (const variant of experiment.variants) {
      for (let repetition = 1; repetition <= experiment.repetitionCount; repetition += 1) {
        if (!attemptByPlan.has(`${caseId}:${variant.variantId}:${repetition}`)) {
          throw new TypeError(
            `missing planned attempt ${caseId}:${variant.variantId}:${repetition}`,
          );
        }
      }
    }
  }

  const adjudicationByClaim = new Map<string, (typeof adjudications)[number]>();
  const adjudicationById = new Map<string, (typeof adjudications)[number]>();
  for (const adjudication of adjudications) {
    assertEqual(
      adjudication.experimentId,
      experiment.experimentId,
      "adjudication has a different experiment ID",
    );
    assertEqual(
      adjudication.experimentManifestDigest.value,
      experimentDigest.value,
      "adjudication has a different experiment manifest identity",
    );
    const attempt = attemptById.get(adjudication.attemptId);
    if (!attempt)
      throw new TypeError(`adjudication contains unknown attempt ${adjudication.attemptId}`);
    assertEqual(adjudication.caseId, attempt.caseId, "adjudication has a different case identity");
    const claim = attempt.findingClaims.find(
      ({ findingReference }) => findingReference === adjudication.findingReference,
    );
    if (!claim) throw new TypeError("adjudication contains unknown finding claim");
    assertEqual(
      adjudication.claimDigest.value,
      claim.claimDigest.value,
      "adjudication has a different claim identity",
    );
    if (adjudication.matchedRootId !== null) {
      const caseManifest = caseById.get(adjudication.caseId);
      if (
        !caseManifest?.oracleInventory.expectedRoots.some(
          ({ rootId }) => rootId === adjudication.matchedRootId,
        )
      ) {
        throw new TypeError("adjudication matched root does not belong to case oracle");
      }
    }
    const claimKey = `${adjudication.attemptId}:${adjudication.findingReference}`;
    if (adjudicationByClaim.has(claimKey))
      throw new TypeError(`duplicate adjudication for ${claimKey}`);
    if (adjudicationById.has(adjudication.adjudicationId))
      throw new TypeError(`duplicate adjudication ID ${adjudication.adjudicationId}`);
    adjudicationByClaim.set(claimKey, adjudication);
    adjudicationById.set(adjudication.adjudicationId, adjudication);
  }
  for (const attempt of attempts) {
    for (const claim of attempt.findingClaims) {
      if (!adjudicationByClaim.has(`${attempt.attemptId}:${claim.findingReference}`)) {
        throw new TypeError(
          `missing adjudication for ${attempt.attemptId}:${claim.findingReference}`,
        );
      }
    }
  }

  assertEqual(score.experimentId, experiment.experimentId, "score has a different experiment ID");
  assertEqual(
    score.experimentManifestDigest.value,
    experimentDigest.value,
    "score has a different experiment manifest identity",
  );
  assertEqual(
    score.scorerVersion,
    experiment.scorerVersion,
    "score has a different scorer version",
  );
  assertEqual(
    score.scorerPolicyDigest.value,
    experiment.scorerPolicyDigest.value,
    "score has a different scorer policy identity",
  );
  assertEqual(
    score.missingness.startedAttempts,
    attempts.length,
    "score started-attempt count does not match graph",
  );
  const delivered = attempts.filter(
    ({ terminalOutcome }) =>
      terminalOutcome.kind === "DELIVERED" || terminalOutcome.kind === "SEMANTIC_ABSTENTION",
  ).length;
  assertEqual(
    score.missingness.deliveredReports,
    delivered,
    "score delivered-report count does not match graph",
  );
  assertEqual(
    score.adjudicationCoverage.totalClaims,
    adjudications.length,
    "score claim count does not match graph",
  );
  const unresolved = adjudications.filter(({ label }) => label === "UNRESOLVED");
  assertEqual(
    score.adjudicationCoverage.unresolvedClaims,
    unresolved.length,
    "score unresolved count does not match graph",
  );
  const unresolvedIds = unresolved.map(({ adjudicationId }) => adjudicationId).sort();
  assertEqual(
    JSON.stringify(score.adjudicationCoverage.unresolvedAdjudicationIds),
    JSON.stringify(unresolvedIds),
    "score unresolved adjudication IDs do not match graph",
  );
  assertEqual(
    score.resources.providerAttempts,
    attempts.reduce((sum, attempt) => sum + attempt.usage.providerAttempts, 0),
    "score provider-attempt total does not match attempts",
  );
  assertEqual(
    score.resources.evidenceBytes,
    attempts.reduce((sum, attempt) => sum + attempt.usage.evidenceBytes, 0),
    "score evidence-byte total does not match attempts",
  );
  assertEqual(
    score.resources.outputBytes,
    attempts.reduce((sum, attempt) => sum + attempt.usage.outputBytes, 0),
    "score output-byte total does not match attempts",
  );
  assertEqual(
    score.cost.reportedCostUsd,
    attempts.reduce((sum, attempt) => sum + (attempt.usage.knownCostUsd ?? 0), 0),
    "score reported cost does not match attempts",
  );
  assertEqual(
    score.cost.unknownCostAttempts,
    attempts.reduce((sum, attempt) => sum + attempt.usage.unknownCostAttempts, 0),
    "score unknown-cost total does not match attempts",
  );
  assertEqual(
    score.cost.conservativeChargeUsd,
    attempts.reduce((sum, attempt) => sum + attempt.usage.conservativeChargeUsd, 0),
    "score conservative charge does not match attempts",
  );
  assertEqual(
    score.cost.admittedCeilingUsd,
    attempts.reduce((sum, attempt) => sum + attempt.usage.admittedCeilingUsd, 0),
    "score admitted ceiling does not match attempts",
  );
  if (score.cost.admittedCeilingUsd > experiment.budgets.maxTotalCostUsd) {
    throw new TypeError("score admitted ceiling exceeds experiment budget");
  }
  assertDistribution(
    score.latency.perReviewMs,
    attempts.map(({ elapsedMs }) => elapsedMs),
    "per-review latency",
  );
  assertDistribution(
    score.latency.perStageMs.preliminary,
    attempts.flatMap(({ stageOutcomes }) =>
      stageOutcomes
        .filter(({ stage }) => stage === "PRELIMINARY")
        .map(({ elapsedMs }) => elapsedMs),
    ),
    "preliminary latency",
  );
  assertDistribution(
    score.latency.perStageMs.findingVerification,
    attempts.flatMap(({ stageOutcomes }) =>
      stageOutcomes
        .filter(({ stage }) => stage === "FINDING_VERIFICATION")
        .map(({ elapsedMs }) => elapsedMs),
    ),
    "finding-verification latency",
  );
  assertDistribution(
    score.latency.perStageMs.final,
    attempts.flatMap(({ stageOutcomes }) =>
      stageOutcomes.filter(({ stage }) => stage === "FINAL").map(({ elapsedMs }) => elapsedMs),
    ),
    "final latency",
  );

  const scoreCases = new Map(score.caseBreakdowns.map((entry) => [entry.caseId, entry]));
  assertEqual(scoreCases.size, cases.length, "score case breakdowns must cover every case");
  for (const caseManifest of cases) {
    const breakdown = scoreCases.get(caseManifest.caseId);
    if (!breakdown) throw new TypeError(`score omits case breakdown ${caseManifest.caseId}`);
    assertEqual(
      breakdown.familyId,
      caseManifest.familyId,
      "case breakdown has a different family identity",
    );
    assertEqual(
      breakdown.split,
      assignmentByCase.get(caseManifest.caseId)?.split ?? "",
      "case breakdown has a different split identity",
    );
  }
  const expectedFamilies = new Map<string, "DEVELOPMENT" | "HOLDOUT">();
  for (const assignment of split.assignments)
    expectedFamilies.set(assignment.familyId, assignment.split);
  assertEqual(
    score.familyBreakdowns.length,
    expectedFamilies.size,
    "score family breakdowns must cover every family",
  );
  for (const breakdown of score.familyBreakdowns) {
    assertEqual(
      breakdown.split,
      expectedFamilies.get(breakdown.familyId) ?? "",
      "family breakdown has a different split identity",
    );
  }
  const pairIds = new Set(cases.flatMap(({ pair }) => (pair === null ? [] : [pair.pairId])));
  for (const delta of score.pairedDeltas) {
    if (!pairIds.has(delta.pairId))
      throw new TypeError(`score contains unknown pair ${delta.pairId}`);
    if (!variantIds.has(delta.baselineVariantId) || !variantIds.has(delta.candidateVariantId)) {
      throw new TypeError("score paired delta contains unknown variant");
    }
  }

  const expectedArtifacts = new Map<string, string>();
  for (const caseManifest of cases)
    expectedArtifacts.set(
      `CASE:${caseManifest.caseId}`,
      digestEvaluationArtifactV1(EvaluationCaseManifestV1Schema, caseManifest).value,
    );
  expectedArtifacts.set(`SPLIT:${split.splitVersion}`, splitDigest.value);
  expectedArtifacts.set(`EXPERIMENT:${experiment.experimentId}`, experimentDigest.value);
  for (const attempt of attempts)
    expectedArtifacts.set(
      `ATTEMPT:${attempt.attemptId}`,
      digestEvaluationArtifactV1(EvaluationAttemptRecordV1Schema, attempt).value,
    );
  for (const adjudication of adjudications)
    expectedArtifacts.set(
      `ADJUDICATION:${adjudication.adjudicationId}`,
      digestEvaluationArtifactV1(EvaluationAdjudicationRecordV1Schema, adjudication).value,
    );
  const actualArtifacts = new Map(
    score.rawArtifactReferences.map((entry) => [`${entry.type}:${entry.id}`, entry.digest.value]),
  );
  assertEqual(
    actualArtifacts.size,
    expectedArtifacts.size,
    "score raw references must cover exact graph artifacts",
  );
  for (const [key, digest] of expectedArtifacts)
    assertEqual(
      actualArtifacts.get(key) ?? "",
      digest,
      `score raw reference has wrong or missing digest for ${key}`,
    );
}
