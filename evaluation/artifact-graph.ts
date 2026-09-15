import { compareUtf16 } from "../src/contracts/primitives.js";
import {
  digestEvaluationArtifactV1,
  EvaluationAdjudicationRecordV1Schema,
  EvaluationAttemptRecordV1Schema,
  EvaluationCaseManifestV1Schema,
  EvaluationEngineIdentityV1Schema,
  EvaluationExperimentManifestV1Schema,
  EvaluationFamilySplitManifestV1Schema,
  EvaluationMetricNameV1Schema,
  EvaluationScoreReportV1Schema,
  EvaluationSourceIdentityV1Schema,
  validateEvaluationFamilySplitV1,
} from "./artifact-contracts.js";
import { assertEvaluationScorerIdentityV1, EVALUATION_SCORER_POLICY_V1 } from "./scorer-policy.js";

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

export interface EvaluationNumericContributionV1 {
  artifactId: string;
  value: number;
}

export function sumEvaluationNumbersV1(
  contributions: readonly EvaluationNumericContributionV1[],
): number {
  const sorted = [...contributions].sort(
    (left, right) =>
      Math.abs(left.value) - Math.abs(right.value) ||
      left.value - right.value ||
      compareUtf16(left.artifactId, right.artifactId),
  );
  let sum = 0;
  let correction = 0;
  for (const { value } of sorted) {
    const next = sum + value;
    correction += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
    sum = next;
  }
  return sum + correction;
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

type MetricName = (typeof EvaluationMetricNameV1Schema.options)[number];
type MetricCount = { metric: MetricName; numerator: number; denominator: number };
type ClaimKind = "DEFECT" | "UNCERTAINTY" | "RECOMMENDATION";
type AdjudicationLabel = ReturnType<typeof EvaluationAdjudicationRecordV1Schema.parse>["label"];

const ADJUDICATION_LABELS_BY_CLAIM_KIND: Readonly<
  Record<ClaimKind, ReadonlySet<AdjudicationLabel>>
> = {
  DEFECT: new Set([
    "MATCHED_DEFECT",
    "NOVEL_VALID_DEFECT",
    "INVALID_DEFECT",
    "UNRESOLVED",
    "DUPLICATE",
  ]),
  UNCERTAINTY: new Set(["SUPPORTED_UNCERTAINTY", "UNRESOLVED"]),
  RECOMMENDATION: new Set(["USEFUL_RECOMMENDATION", "INVALID_RECOMMENDATION", "UNRESOLVED"]),
};

export function isEvaluationAdjudicationLabelAllowedV1(
  claimKind: ClaimKind,
  label: AdjudicationLabel,
): boolean {
  return ADJUDICATION_LABELS_BY_CLAIM_KIND[claimKind].has(label);
}

export function deriveEvaluationAttemptMetricCountsV1(
  attempt: ReturnType<typeof EvaluationAttemptRecordV1Schema.parse>,
  caseManifest: ReturnType<typeof EvaluationCaseManifestV1Schema.parse>,
  adjudications: readonly ReturnType<typeof EvaluationAdjudicationRecordV1Schema.parse>[],
): MetricCount[] {
  const claimByReference = new Map(
    attempt.findingClaims.map((claim) => [claim.findingReference, claim]),
  );
  const finalAdjudications = adjudications.filter(
    ({ findingReference }) => claimByReference.get(findingReference)?.emittedAtStage === "FINAL",
  );
  const finalDefects = finalAdjudications.filter(
    ({ findingReference }) => claimByReference.get(findingReference)?.claimKind === "DEFECT",
  );
  const completed =
    attempt.terminalOutcome.kind === "DELIVERED" ||
    attempt.terminalOutcome.kind === "SEMANTIC_ABSTENTION";
  const expectedRoots = new Set(
    caseManifest.oracleInventory.expectedRoots.map(({ rootId }) => rootId),
  );
  const matchedFinalRoots = new Set(
    finalDefects.flatMap(({ label, matchedRootId }) =>
      label === "MATCHED_DEFECT" && matchedRootId !== null ? [matchedRootId] : [],
    ),
  );
  const supportedRoots = new Set(
    finalDefects.flatMap(({ label, matchedRootId }) =>
      (label === "MATCHED_DEFECT" || label === "NOVEL_VALID_DEFECT") && matchedRootId !== null
        ? [matchedRootId]
        : [],
    ),
  );
  const invalid = finalDefects.filter(({ label }) => label === "INVALID_DEFECT").length;
  const unresolved = finalDefects.filter(({ label }) => label === "UNRESOLVED").length;
  const duplicates = finalDefects.filter(({ label }) => label === "DUPLICATE").length;
  const clean = caseManifest.pair?.role === "CLEAN";
  const completeEvidence = caseManifest.oracleInventory.expectedUncertainties.length === 0;
  const expectedUncertainties = new Set(
    caseManifest.oracleInventory.expectedUncertainties.map(({ uncertaintyId }) => uncertaintyId),
  );
  const matchedUncertainties = new Set(
    finalAdjudications
      .filter(
        ({ findingReference }) =>
          claimByReference.get(findingReference)?.claimKind === "UNCERTAINTY",
      )
      .flatMap(({ label, matchedUncertaintyId }) =>
        label === "SUPPORTED_UNCERTAINTY" && matchedUncertaintyId !== null
          ? [matchedUncertaintyId]
          : [],
      ),
  );
  const preliminaryDefects = adjudications.filter(({ findingReference }) => {
    const claim = claimByReference.get(findingReference);
    return claim?.emittedAtStage === "PRELIMINARY" && claim.claimKind === "DEFECT";
  });
  const preliminaryRoots = new Set(
    preliminaryDefects.flatMap(({ label, matchedRootId }) =>
      (label === "MATCHED_DEFECT" || label === "NOVEL_VALID_DEFECT") && matchedRootId !== null
        ? [matchedRootId]
        : [],
    ),
  );
  const retainedRoots = [...preliminaryRoots].filter((rootId) => supportedRoots.has(rootId));
  const preliminaryFalseRoots = new Set(
    preliminaryDefects.flatMap(({ findingReference, label }) => {
      const digest = claimByReference.get(findingReference)?.claimDigest.value;
      return label === "INVALID_DEFECT" && digest !== undefined ? [digest] : [];
    }),
  );
  const finalDefectDigests = new Set(
    finalDefects.flatMap(({ findingReference }) => {
      const digest = claimByReference.get(findingReference)?.claimDigest.value;
      return digest === undefined ? [] : [digest];
    }),
  );
  const removedFalseRoots = [...preliminaryFalseRoots].filter(
    (digest) => !finalDefectDigests.has(digest),
  );
  const expectedRootCount = expectedRoots.size;
  const supported = supportedRoots.size;
  return [
    {
      metric: "KNOWN_DEFECT_RECALL_COMPLETED",
      numerator: completed ? matchedFinalRoots.size : 0,
      denominator: completed ? expectedRootCount : 0,
    },
    {
      metric: "KNOWN_DEFECT_RECALL_ALL_STARTS",
      numerator: completed ? matchedFinalRoots.size : 0,
      denominator: expectedRootCount,
    },
    {
      metric: "ADJUDICATED_DEFECT_PRECISION",
      numerator: supported,
      denominator: supported + invalid,
    },
    {
      metric: "CONSERVATIVE_PRECISION_BOUND",
      numerator: supported,
      denominator: supported + invalid + unresolved,
    },
    { metric: "UNIQUE_ACTION_YIELD", numerator: supported, denominator: finalDefects.length },
    {
      metric: "CLEAN_FALSE_POSITIVE_RATE",
      numerator: completed && clean && invalid > 0 ? 1 : 0,
      denominator: completed && clean ? 1 : 0,
    },
    {
      metric: "FALSE_ABSTENTION_RATE",
      numerator:
        completed && completeEvidence && attempt.terminalOutcome.kind === "SEMANTIC_ABSTENTION"
          ? 1
          : 0,
      denominator: completed && completeEvidence ? 1 : 0,
    },
    {
      metric: "CORRECT_UNCERTAINTY_RATE",
      numerator:
        completed &&
        expectedUncertainties.size > 0 &&
        [...expectedUncertainties].every((id) => matchedUncertainties.has(id))
          ? 1
          : 0,
      denominator: completed && expectedUncertainties.size > 0 ? 1 : 0,
    },
    { metric: "DUPLICATE_RATE", numerator: duplicates, denominator: finalDefects.length },
    { metric: "DELIVERY_RATE", numerator: completed ? 1 : 0, denominator: 1 },
    {
      metric: "STAGE_RETENTION_RATE",
      numerator: completed ? retainedRoots.length + removedFalseRoots.length : 0,
      denominator: completed ? preliminaryRoots.size + preliminaryFalseRoots.size : 0,
    },
  ];
}

function aggregateMetricCounts(groups: readonly (readonly MetricCount[])[]): MetricCount[] {
  return EvaluationMetricNameV1Schema.options.map((metric) => ({
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
}

function assertMetricCounts(
  actual: readonly { metric: string; numerator: number; denominator: number }[],
  expected: readonly MetricCount[],
  label: string,
): void {
  const actualByMetric = new Map(actual.map((entry) => [entry.metric, entry]));
  for (const count of expected) {
    const entry = actualByMetric.get(count.metric);
    if (entry?.numerator !== count.numerator || entry.denominator !== count.denominator) {
      throw new TypeError(`score ${label} metric ${count.metric} does not match artifacts`);
    }
  }
}

function assertMetricIntervals(
  actual: readonly {
    metric: string;
    interval: {
      method: string;
      confidenceLevel: number;
      lower: number;
      upper: number;
      independentUnit: "CASE" | "FAMILY";
    } | null;
  }[],
  independentUnit: "CASE" | "FAMILY",
  label: string,
): void {
  const expected = {
    method: EVALUATION_SCORER_POLICY_V1.interval.method,
    confidenceLevel: EVALUATION_SCORER_POLICY_V1.interval.confidenceLevel,
    lower: EVALUATION_SCORER_POLICY_V1.interval.lower,
    upper: EVALUATION_SCORER_POLICY_V1.interval.upper,
    independentUnit,
  };
  for (const metric of actual) {
    if (metric.interval === null) continue;
    for (const field of [
      "method",
      "confidenceLevel",
      "lower",
      "upper",
      "independentUnit",
    ] as const) {
      if (metric.interval[field] !== expected[field]) {
        const fieldLabel =
          field === "confidenceLevel"
            ? "confidence"
            : field === "independentUnit"
              ? "unit"
              : field === "lower" || field === "upper"
                ? `${field} bound`
                : field;
        throw new TypeError(`score ${label} interval ${fieldLabel} does not match scorer policy`);
      }
    }
  }
}

function metricValue(count: MetricCount): number | null {
  return count.denominator === 0 ? null : count.numerator / count.denominator;
}

export function validateEvaluationArtifactGraphV1(input: EvaluationArtifactGraphInputV1): void {
  const experiment = EvaluationExperimentManifestV1Schema.parse(input.experiment);
  const split = EvaluationFamilySplitManifestV1Schema.parse(input.split);
  const cases = input.cases
    .map((value) => EvaluationCaseManifestV1Schema.parse(value))
    .sort((left, right) => compareUtf16(left.caseId, right.caseId));
  const attempts = input.attempts
    .map((value) => EvaluationAttemptRecordV1Schema.parse(value))
    .sort((left, right) => compareUtf16(left.attemptId, right.attemptId));
  const adjudications = input.adjudications
    .map((value) => EvaluationAdjudicationRecordV1Schema.parse(value))
    .sort((left, right) => compareUtf16(left.adjudicationId, right.adjudicationId));
  const score = EvaluationScoreReportV1Schema.parse(input.score);

  assertEvaluationScorerIdentityV1(experiment);

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
    if (!isEvaluationAdjudicationLabelAllowedV1(claim.claimKind, adjudication.label)) {
      throw new TypeError(
        `claim kind ${claim.claimKind} cannot use adjudication label ${adjudication.label}`,
      );
    }
    assertEqual(
      adjudication.claimDigest.value,
      claim.claimDigest.value,
      "adjudication has a different claim identity",
    );
    if (adjudication.matchedRootId !== null) {
      const caseManifest = caseById.get(adjudication.caseId);
      const isOracleRoot = caseManifest?.oracleInventory.expectedRoots.some(
        ({ rootId }) => rootId === adjudication.matchedRootId,
      );
      if (adjudication.label === "MATCHED_DEFECT" && !isOracleRoot) {
        throw new TypeError("matched defect must reference a case-oracle semantic root");
      }
      if (adjudication.label === "NOVEL_VALID_DEFECT" && isOracleRoot) {
        throw new TypeError("novel valid defect must reference a non-oracle semantic root");
      }
    }
    if (adjudication.matchedUncertaintyId !== null) {
      const caseManifest = caseById.get(adjudication.caseId);
      if (
        !caseManifest?.oracleInventory.expectedUncertainties.some(
          ({ uncertaintyId }) => uncertaintyId === adjudication.matchedUncertaintyId,
        )
      ) {
        throw new TypeError("adjudication matched uncertainty does not belong to case oracle");
      }
    }
    const caseManifest = caseById.get(adjudication.caseId);
    if (!caseManifest) throw new TypeError("adjudication case is unavailable");
    for (const evidence of adjudication.causalEvidence) {
      if (evidence.source === "CASE_INPUT") {
        const retained = caseManifest.reviewerInputInventory.some(
          ({ role, reference, digest }) =>
            (role === "SOURCE_CHANGE" || role === "SUPPORTING_SOURCE") &&
            reference === evidence.reference &&
            digest.value === evidence.digest.value,
        );
        if (!retained)
          throw new TypeError("adjudication causal evidence is not retained case input");
      } else {
        const report =
          attempt.terminalOutcome.kind === "DELIVERED" ||
          attempt.terminalOutcome.kind === "SEMANTIC_ABSTENTION"
            ? attempt.terminalOutcome
            : null;
        if (
          report?.reportReference !== evidence.reference ||
          report.reportDigest.value !== evidence.digest.value
        ) {
          throw new TypeError("adjudication causal evidence is not retained report bytes");
        }
      }
    }
    if (
      ["MATCHED_DEFECT", "NOVEL_VALID_DEFECT", "DUPLICATE"].includes(adjudication.label) &&
      !adjudication.causalEvidence.some(({ source }) => source === "CASE_INPUT")
    ) {
      throw new TypeError("supported defect adjudication requires retained case causal evidence");
    }
    if (Date.parse(adjudication.adjudicatedAt) < Date.parse(attempt.completedAt)) {
      throw new TypeError("adjudication cannot precede attempt completion");
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
    const attemptAdjudications = adjudications.filter(
      ({ attemptId }) => attemptId === attempt.attemptId,
    );
    const claimByReference = new Map(
      attempt.findingClaims.map((claim) => [claim.findingReference, claim]),
    );
    for (const stage of ["PRELIMINARY", "FINDING_VERIFICATION", "FINAL"] as const) {
      const stageAdjudications = attemptAdjudications.filter(
        ({ findingReference }) => claimByReference.get(findingReference)?.emittedAtStage === stage,
      );
      const creditedRoots = new Set<string>();
      for (const adjudication of stageAdjudications) {
        if (
          (adjudication.label === "MATCHED_DEFECT" ||
            adjudication.label === "NOVEL_VALID_DEFECT") &&
          adjudication.matchedRootId !== null
        ) {
          if (creditedRoots.has(adjudication.matchedRootId)) {
            throw new TypeError(
              `semantic root cannot receive more than one semantic-root credit in ${stage} per attempt`,
            );
          }
          creditedRoots.add(adjudication.matchedRootId);
        }
      }
      for (const adjudication of stageAdjudications) {
        if (
          adjudication.label === "DUPLICATE" &&
          adjudication.matchedRootId !== null &&
          !creditedRoots.has(adjudication.matchedRootId)
        ) {
          throw new TypeError(
            `duplicate must reference a credited semantic root in ${stage} for same attempt`,
          );
        }
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
  if (
    adjudications.some(
      ({ adjudicatedAt }) => Date.parse(adjudicatedAt) > Date.parse(score.generatedAt),
    )
  ) {
    throw new TypeError("score generation cannot precede adjudication");
  }
  if (attempts.some(({ completedAt }) => Date.parse(completedAt) > Date.parse(score.generatedAt))) {
    throw new TypeError("score generation cannot precede attempt completion");
  }
  assertEqual(
    JSON.stringify(score.metrics.map(({ metric }) => metric)),
    JSON.stringify(experiment.metricSet),
    "score metric set does not match experiment declaration",
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
  const evidenceByAttempt = new Map(score.attemptEvidence.map((entry) => [entry.attemptId, entry]));
  assertEqual(
    evidenceByAttempt.size,
    attempts.length,
    "score attempt evidence must cover every attempt",
  );
  const contributionByAttempt = new Map<string, MetricCount[]>();
  for (const attempt of attempts) {
    const evidence = evidenceByAttempt.get(attempt.attemptId);
    if (!evidence) throw new TypeError(`score omits attempt evidence ${attempt.attemptId}`);
    assertEqual(
      evidence.attemptDigest.value,
      digestEvaluationArtifactV1(EvaluationAttemptRecordV1Schema, attempt).value,
      "score attempt evidence has a different attempt identity",
    );
    const attemptAdjudications = adjudications.filter(
      ({ attemptId }) => attemptId === attempt.attemptId,
    );
    assertEqual(
      JSON.stringify(evidence.adjudicationIds),
      JSON.stringify(attemptAdjudications.map(({ adjudicationId }) => adjudicationId).sort()),
      "score attempt evidence has different adjudication coverage",
    );
    const caseManifest = caseById.get(attempt.caseId);
    if (!caseManifest) throw new TypeError("attempt evidence case is unavailable");
    const contribution = deriveEvaluationAttemptMetricCountsV1(
      attempt,
      caseManifest,
      attemptAdjudications,
    );
    contributionByAttempt.set(attempt.attemptId, contribution);
    assertMetricCounts(evidence.metrics, contribution, `attempt ${attempt.attemptId}`);
    const expectedResources = {
      providerAttempts: attempt.usage.providerAttempts,
      knownCostAttempts: attempt.usage.knownCostAttempts,
      evidenceBytes: attempt.usage.evidenceBytes,
      outputBytes: attempt.usage.outputBytes,
      reportedCostUsd: attempt.usage.knownCostUsd ?? 0,
      unknownCostAttempts: attempt.usage.unknownCostAttempts,
      conservativeChargeUsd: attempt.usage.conservativeChargeUsd,
      admittedCeilingUsd: attempt.usage.admittedCeilingUsd,
    };
    if (JSON.stringify(evidence.resources) !== JSON.stringify(expectedResources)) {
      throw new TypeError(
        `score attempt ${attempt.attemptId} resource evidence does not match attempt`,
      );
    }
  }
  assertMetricCounts(
    score.metrics,
    aggregateMetricCounts([...contributionByAttempt.values()]),
    "global",
  );
  assertMetricIntervals(score.metrics, "FAMILY", "global");
  assertEqual(
    score.resources.providerAttempts,
    sumEvaluationNumbersV1(
      attempts.map((attempt) => ({
        artifactId: attempt.attemptId,
        value: attempt.usage.providerAttempts,
      })),
    ),
    "score provider-attempt total does not match attempts",
  );
  assertEqual(
    score.resources.evidenceBytes,
    sumEvaluationNumbersV1(
      attempts.map((attempt) => ({
        artifactId: attempt.attemptId,
        value: attempt.usage.evidenceBytes,
      })),
    ),
    "score evidence-byte total does not match attempts",
  );
  assertEqual(
    score.resources.outputBytes,
    sumEvaluationNumbersV1(
      attempts.map((attempt) => ({
        artifactId: attempt.attemptId,
        value: attempt.usage.outputBytes,
      })),
    ),
    "score output-byte total does not match attempts",
  );
  assertEqual(
    score.cost.reportedCostUsd,
    sumEvaluationNumbersV1(
      attempts.map((attempt) => ({
        artifactId: attempt.attemptId,
        value: attempt.usage.knownCostUsd ?? 0,
      })),
    ),
    "score reported cost does not match attempts",
  );
  assertEqual(
    score.cost.knownCostAttempts,
    sumEvaluationNumbersV1(
      attempts.map((attempt) => ({
        artifactId: attempt.attemptId,
        value: attempt.usage.knownCostAttempts,
      })),
    ),
    "score known-cost total does not match attempts",
  );
  assertEqual(
    score.cost.unknownCostAttempts,
    sumEvaluationNumbersV1(
      attempts.map((attempt) => ({
        artifactId: attempt.attemptId,
        value: attempt.usage.unknownCostAttempts,
      })),
    ),
    "score unknown-cost total does not match attempts",
  );
  assertEqual(
    score.cost.conservativeChargeUsd,
    sumEvaluationNumbersV1(
      attempts.map((attempt) => ({
        artifactId: attempt.attemptId,
        value: attempt.usage.conservativeChargeUsd,
      })),
    ),
    "score conservative charge does not match attempts",
  );
  assertEqual(
    score.cost.admittedCeilingUsd,
    sumEvaluationNumbersV1(
      attempts.map((attempt) => ({
        artifactId: attempt.attemptId,
        value: attempt.usage.admittedCeilingUsd,
      })),
    ),
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
    assertMetricCounts(
      breakdown.metrics,
      aggregateMetricCounts(
        attempts
          .filter(({ caseId }) => caseId === caseManifest.caseId)
          .map(({ attemptId }) => contributionByAttempt.get(attemptId) ?? []),
      ),
      `case ${caseManifest.caseId}`,
    );
    assertMetricIntervals(breakdown.metrics, "CASE", "case");
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
    assertMetricCounts(
      breakdown.metrics,
      aggregateMetricCounts(
        attempts
          .filter(({ familyId }) => familyId === breakdown.familyId)
          .map(({ attemptId }) => contributionByAttempt.get(attemptId) ?? []),
      ),
      `family ${breakdown.familyId}`,
    );
    assertMetricIntervals(breakdown.metrics, "CASE", "family");
  }
  const pairIds = new Set(cases.flatMap(({ pair }) => (pair === null ? [] : [pair.pairId])));
  const expectedDeltaKeys = new Set<string>();
  for (const comparison of experiment.comparisons) {
    for (const pairId of comparison.pairIds) {
      if (!pairIds.has(pairId))
        throw new TypeError(`experiment comparison contains unknown pair ${pairId}`);
      for (const metric of comparison.metrics) {
        const key = `${comparison.comparisonId}:${pairId}:${metric}`;
        if (expectedDeltaKeys.has(key))
          throw new TypeError(`duplicate declared score delta ${key}`);
        expectedDeltaKeys.add(key);
        const delta = score.pairedDeltas.find(
          (entry) =>
            entry.comparisonId === comparison.comparisonId &&
            entry.pairId === pairId &&
            entry.metric === metric,
        );
        if (!delta) throw new TypeError(`score omits declared paired delta ${key}`);
        assertEqual(
          delta.baselineVariantId,
          comparison.baselineVariantId,
          "score delta has different baseline variant",
        );
        assertEqual(
          delta.candidateVariantId,
          comparison.candidateVariantId,
          "score delta has different candidate variant",
        );
        const pairCaseIds = new Set(
          cases.flatMap(({ caseId, pair }) => (pair?.pairId === pairId ? [caseId] : [])),
        );
        const countsForVariant = (variantId: string) =>
          aggregateMetricCounts(
            attempts
              .filter(
                ({ caseId, variantId: attemptVariantId }) =>
                  pairCaseIds.has(caseId) && attemptVariantId === variantId,
              )
              .map(({ attemptId }) => contributionByAttempt.get(attemptId) ?? []),
          ).find((entry) => entry.metric === metric) as MetricCount;
        const baselineValue = metricValue(countsForVariant(comparison.baselineVariantId));
        const candidateValue = metricValue(countsForVariant(comparison.candidateVariantId));
        if (delta.baselineValue !== baselineValue || delta.candidateValue !== candidateValue) {
          throw new TypeError(`score paired delta ${key} values do not match attempts`);
        }
      }
    }
  }
  assertEqual(
    score.pairedDeltas.length,
    expectedDeltaKeys.size,
    "score paired deltas must exactly match experiment declarations",
  );

  const severityEligible = adjudications.filter((adjudication) => {
    const attempt = attemptById.get(adjudication.attemptId);
    return (
      attempt?.findingClaims.find(
        ({ findingReference }) => findingReference === adjudication.findingReference,
      )?.claimKind === "DEFECT"
    );
  });
  const severityClassified = severityEligible.filter(
    ({ severityCalibration }) => severityCalibration !== null,
  );
  const severityUnavailable = severityEligible
    .filter(({ severityCalibration }) => severityCalibration === null)
    .map(({ adjudicationId }) => adjudicationId)
    .sort();
  const severityRank = { NOT_APPLICABLE: 0, NON_BLOCKING: 1, BLOCKING: 2 } as const;
  const exact = severityClassified.filter(
    ({ severityCalibration }) => severityCalibration?.expected === severityCalibration?.observed,
  ).length;
  const underclassified = severityClassified.filter(
    ({ severityCalibration }) =>
      severityCalibration !== null &&
      severityRank[severityCalibration.observed] < severityRank[severityCalibration.expected],
  ).length;
  const overclassified = severityClassified.length - exact - underclassified;
  const expectedSeverity = {
    eligibleAdjudications: severityEligible.length,
    classifiedAdjudications: severityClassified.length,
    exact,
    underclassified,
    overclassified,
    unavailableAdjudicationIds: severityUnavailable,
  };
  if (JSON.stringify(score.severityCalibration) !== JSON.stringify(expectedSeverity)) {
    throw new TypeError("score severity calibration does not match adjudications");
  }
  const enforcementEligible = adjudications.filter(
    (adjudication) => caseById.get(adjudication.caseId)?.reviewMode === "STANDARDS",
  );
  const enforcementClassified = enforcementEligible.filter(
    ({ enforcementClassification }) => enforcementClassification !== null,
  );
  const enforcementUnavailable = enforcementEligible
    .filter(({ enforcementClassification }) => enforcementClassification === null)
    .map(({ adjudicationId }) => adjudicationId)
    .sort();
  const enforcementCounts = new Map<string, number>();
  for (const adjudication of enforcementClassified) {
    const classification = adjudication.enforcementClassification;
    if (classification !== null) {
      const key = `${classification.expected}:${classification.observed}`;
      enforcementCounts.set(key, (enforcementCounts.get(key) ?? 0) + 1);
    }
  }
  for (const cell of score.enforcementConfusion.cells) {
    if (cell.count !== (enforcementCounts.get(`${cell.expected}:${cell.observed}`) ?? 0)) {
      throw new TypeError("score enforcement confusion does not match adjudications");
    }
  }
  if (
    score.enforcementConfusion.eligibleAdjudications !== enforcementEligible.length ||
    score.enforcementConfusion.classifiedAdjudications !== enforcementClassified.length ||
    JSON.stringify(score.enforcementConfusion.unavailableAdjudicationIds) !==
      JSON.stringify(enforcementUnavailable)
  ) {
    throw new TypeError("score enforcement coverage does not match adjudications");
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
