import { compareUtf16 } from "../src/contracts/primitives.js";
import {
  digestEvaluationArtifactV1,
  type EvaluationAdjudicationRecordV1,
  EvaluationAdjudicationRecordV1Schema,
  type EvaluationAttemptRecordV1,
  EvaluationAttemptRecordV1Schema,
  type EvaluationCaseManifestV1,
  EvaluationCaseManifestV1Schema,
  EvaluationExperimentManifestV1Schema,
  EvaluationFamilySplitManifestV1Schema,
  EvaluationMetricNameV1Schema,
  type EvaluationScoreReportV1,
  EvaluationScoreReportV1Schema,
} from "./artifact-contracts.js";
import {
  deriveEvaluationAttemptMetricCountsV1,
  sumEvaluationNumbersV1,
  validateEvaluationArtifactGraphV1,
} from "./artifact-graph.js";

type MetricName = (typeof EvaluationMetricNameV1Schema.options)[number];
type MetricCount = { metric: MetricName; numerator: number; denominator: number };

export interface EvaluationArtifactReferencesV1 {
  cases: readonly { caseId: string; reference: string }[];
  split: string;
  experiment: string;
  attempts: readonly { attemptId: string; reference: string }[];
  adjudications: readonly { adjudicationId: string; reference: string }[];
}

export interface EvaluationScorerInputV1 {
  experiment: unknown;
  split: unknown;
  cases: readonly unknown[];
  attempts: readonly unknown[];
  adjudications: readonly unknown[];
  scoreId: string;
  generatedAt: string;
  references: EvaluationArtifactReferencesV1;
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

function scoredMetrics(counts: readonly MetricCount[], independentUnit: "CASE" | "FAMILY") {
  return [...counts]
    .sort((left, right) => compareUtf16(left.metric, right.metric))
    .map(({ metric, numerator, denominator }) => ({
      metric,
      numerator,
      denominator,
      value: denominator === 0 ? null : numerator / denominator,
      interval:
        denominator === 0
          ? null
          : {
              method: "CONSERVATIVE_BOUNDS_V1",
              confidenceLevel: 0.95,
              lower: 0,
              upper: 1,
              independentUnit,
            },
    }));
}

function summarize(values: readonly number[]) {
  if (values.length === 0) {
    return { count: 0, minimum: null, median: null, p95: null, maximum: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    minimum: sorted[0] as number,
    median:
      sorted.length % 2 === 0
        ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
        : (sorted[middle] as number),
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] as number,
    maximum: sorted.at(-1) as number,
  };
}

function exactReference(
  entries: readonly { id: string; reference: string }[],
  expectedIds: readonly string[],
  label: string,
): Map<string, string> {
  const references = new Map<string, string>();
  for (const entry of entries) {
    if (references.has(entry.id)) throw new TypeError(`duplicate ${label} reference ${entry.id}`);
    references.set(entry.id, entry.reference);
  }
  if (references.size !== expectedIds.length) {
    throw new TypeError(`${label} references must cover exact artifact set`);
  }
  for (const id of expectedIds) {
    if (!references.has(id)) throw new TypeError(`missing ${label} reference ${id}`);
  }
  return references;
}

function severityCalibration(
  attempts: readonly EvaluationAttemptRecordV1[],
  adjudications: readonly EvaluationAdjudicationRecordV1[],
) {
  const claimKinds = new Map(
    attempts.flatMap((attempt) =>
      attempt.findingClaims.map(
        (claim) => [`${attempt.attemptId}:${claim.findingReference}`, claim.claimKind] as const,
      ),
    ),
  );
  const eligible = adjudications.filter(
    (adjudication) =>
      claimKinds.get(`${adjudication.attemptId}:${adjudication.findingReference}`) === "DEFECT",
  );
  const classified = eligible.filter(({ severityCalibration }) => severityCalibration !== null);
  const rank = { NOT_APPLICABLE: 0, NON_BLOCKING: 1, BLOCKING: 2 } as const;
  const exact = classified.filter(
    ({ severityCalibration: value }) => value?.expected === value?.observed,
  ).length;
  const underclassified = classified.filter(
    ({ severityCalibration: value }) =>
      value !== null && rank[value.observed] < rank[value.expected],
  ).length;
  return {
    eligibleAdjudications: eligible.length,
    classifiedAdjudications: classified.length,
    exact,
    underclassified,
    overclassified: classified.length - exact - underclassified,
    unavailableAdjudicationIds: eligible
      .filter(({ severityCalibration: value }) => value === null)
      .map(({ adjudicationId }) => adjudicationId),
  };
}

const ENFORCEMENT_CLASSES = ["REQUIRED", "RECOMMENDED", "NOT_APPLICABLE", "UNAVAILABLE"] as const;

function enforcementConfusion(
  cases: readonly EvaluationCaseManifestV1[],
  adjudications: readonly EvaluationAdjudicationRecordV1[],
) {
  const standardsCases = new Set(
    cases.filter(({ reviewMode }) => reviewMode === "STANDARDS").map(({ caseId }) => caseId),
  );
  const eligible = adjudications.filter(({ caseId }) => standardsCases.has(caseId));
  const classified = eligible.filter(
    ({ enforcementClassification }) => enforcementClassification !== null,
  );
  const counts = new Map<string, number>();
  for (const { enforcementClassification: value } of classified) {
    if (value === null) continue;
    const key = `${value.expected}:${value.observed}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {
    eligibleAdjudications: eligible.length,
    classifiedAdjudications: classified.length,
    cells: ENFORCEMENT_CLASSES.flatMap((expected) =>
      ENFORCEMENT_CLASSES.map((observed) => ({
        expected,
        observed,
        count: counts.get(`${expected}:${observed}`) ?? 0,
      })),
    ),
    unavailableAdjudicationIds: eligible
      .filter(({ enforcementClassification }) => enforcementClassification === null)
      .map(({ adjudicationId }) => adjudicationId),
  };
}

function metricValue(counts: readonly MetricCount[], metric: MetricName): number | null {
  const count = counts.find((entry) => entry.metric === metric);
  if (count === undefined || count.denominator === 0) return null;
  return count.numerator / count.denominator;
}

export function scoreEvaluationArtifactsV1(
  input: EvaluationScorerInputV1,
): EvaluationScoreReportV1 {
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
  const caseById = new Map(cases.map((caseManifest) => [caseManifest.caseId, caseManifest]));
  const contributions = new Map(
    attempts.map((attempt) => {
      const caseManifest = caseById.get(attempt.caseId);
      if (caseManifest === undefined)
        throw new TypeError(`attempt contains unknown case ${attempt.caseId}`);
      return [
        attempt.attemptId,
        deriveEvaluationAttemptMetricCountsV1(
          attempt,
          caseManifest,
          adjudications.filter(({ attemptId }) => attemptId === attempt.attemptId),
        ),
      ] as const;
    }),
  );
  const countsForAttempts = (selected: readonly EvaluationAttemptRecordV1[]) =>
    aggregateMetricCounts(selected.map(({ attemptId }) => contributions.get(attemptId) ?? []));
  const caseReferences = exactReference(
    input.references.cases.map(({ caseId, reference }) => ({ id: caseId, reference })),
    cases.map(({ caseId }) => caseId),
    "case",
  );
  const attemptReferences = exactReference(
    input.references.attempts.map(({ attemptId, reference }) => ({ id: attemptId, reference })),
    attempts.map(({ attemptId }) => attemptId),
    "attempt",
  );
  const adjudicationReferences = exactReference(
    input.references.adjudications.map(({ adjudicationId, reference }) => ({
      id: adjudicationId,
      reference,
    })),
    adjudications.map(({ adjudicationId }) => adjudicationId),
    "adjudication",
  );
  const assignmentByCase = new Map(split.assignments.map((entry) => [entry.caseId, entry]));
  const unresolved = adjudications.filter(({ label }) => label === "UNRESOLVED");
  const deliveredReports = attempts.filter(
    ({ terminalOutcome }) =>
      terminalOutcome.kind === "DELIVERED" || terminalOutcome.kind === "SEMANTIC_ABSTENTION",
  ).length;
  const pairedDeltas = experiment.comparisons.flatMap((comparison) =>
    comparison.pairIds.flatMap((pairId) => {
      const pairCaseIds = new Set(
        cases.flatMap(({ caseId, pair }) => (pair?.pairId === pairId ? [caseId] : [])),
      );
      const counts = (variantId: string) =>
        countsForAttempts(
          attempts.filter(
            ({ caseId, variantId: attemptVariantId }) =>
              pairCaseIds.has(caseId) && attemptVariantId === variantId,
          ),
        );
      return comparison.metrics.map((metric) => {
        const baselineValue = metricValue(counts(comparison.baselineVariantId), metric);
        const candidateValue = metricValue(counts(comparison.candidateVariantId), metric);
        return {
          comparisonId: comparison.comparisonId,
          pairId,
          baselineVariantId: comparison.baselineVariantId,
          candidateVariantId: comparison.candidateVariantId,
          metric,
          baselineValue,
          candidateValue,
          delta:
            baselineValue === null || candidateValue === null
              ? null
              : candidateValue - baselineValue,
        };
      });
    }),
  );
  const report = EvaluationScoreReportV1Schema.parse({
    schemaVersion: 1,
    scoreId: input.scoreId,
    experimentId: experiment.experimentId,
    experimentManifestDigest: digestEvaluationArtifactV1(
      EvaluationExperimentManifestV1Schema,
      experiment,
    ),
    scorerVersion: experiment.scorerVersion,
    scorerPolicyDigest: experiment.scorerPolicyDigest,
    generatedAt: input.generatedAt,
    metrics: scoredMetrics(countsForAttempts(attempts), "FAMILY"),
    adjudicationCoverage: {
      totalClaims: adjudications.length,
      resolvedClaims: adjudications.length - unresolved.length,
      unresolvedClaims: unresolved.length,
      unresolvedAdjudicationIds: unresolved.map(({ adjudicationId }) => adjudicationId),
    },
    missingness: {
      startedAttempts: attempts.length,
      deliveredReports,
      missingReports: attempts.length - deliveredReports,
    },
    caseBreakdowns: cases.map((caseManifest) => ({
      caseId: caseManifest.caseId,
      familyId: caseManifest.familyId,
      split: assignmentByCase.get(caseManifest.caseId)?.split,
      metrics: scoredMetrics(
        countsForAttempts(attempts.filter(({ caseId }) => caseId === caseManifest.caseId)),
        "CASE",
      ),
    })),
    familyBreakdowns: [...new Set(cases.map(({ familyId }) => familyId))].map((familyId) => ({
      familyId,
      split: split.assignments.find((entry) => entry.familyId === familyId)?.split,
      metrics: scoredMetrics(
        countsForAttempts(attempts.filter((attempt) => attempt.familyId === familyId)),
        "CASE",
      ),
    })),
    attemptEvidence: attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      attemptDigest: digestEvaluationArtifactV1(EvaluationAttemptRecordV1Schema, attempt),
      adjudicationIds: adjudications
        .filter(({ attemptId }) => attemptId === attempt.attemptId)
        .map(({ adjudicationId }) => adjudicationId),
      metrics: contributions.get(attempt.attemptId),
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
    severityCalibration: severityCalibration(attempts, adjudications),
    enforcementConfusion: enforcementConfusion(cases, adjudications),
    pairedDeltas,
    latency: {
      perReviewMs: summarize(attempts.map(({ elapsedMs }) => elapsedMs)),
      perStageMs: {
        preliminary: summarize(
          attempts.flatMap(({ stageOutcomes }) =>
            stageOutcomes
              .filter(({ stage }) => stage === "PRELIMINARY")
              .map(({ elapsedMs }) => elapsedMs),
          ),
        ),
        findingVerification: summarize(
          attempts.flatMap(({ stageOutcomes }) =>
            stageOutcomes
              .filter(({ stage }) => stage === "FINDING_VERIFICATION")
              .map(({ elapsedMs }) => elapsedMs),
          ),
        ),
        final: summarize(
          attempts.flatMap(({ stageOutcomes }) =>
            stageOutcomes
              .filter(({ stage }) => stage === "FINAL")
              .map(({ elapsedMs }) => elapsedMs),
          ),
        ),
      },
    },
    resources: {
      providerAttempts: sumEvaluationNumbersV1(
        attempts.map((attempt) => attempt.usage.providerAttempts),
      ),
      evidenceBytes: sumEvaluationNumbersV1(attempts.map((attempt) => attempt.usage.evidenceBytes)),
      outputBytes: sumEvaluationNumbersV1(attempts.map((attempt) => attempt.usage.outputBytes)),
      execution: [],
    },
    cost: {
      reportedCostUsd: sumEvaluationNumbersV1(
        attempts.map((attempt) => attempt.usage.knownCostUsd ?? 0),
      ),
      knownCostAttempts: sumEvaluationNumbersV1(
        attempts.map((attempt) => attempt.usage.knownCostAttempts),
      ),
      unknownCostAttempts: sumEvaluationNumbersV1(
        attempts.map((attempt) => attempt.usage.unknownCostAttempts),
      ),
      conservativeChargeUsd: sumEvaluationNumbersV1(
        attempts.map((attempt) => attempt.usage.conservativeChargeUsd),
      ),
      admittedCeilingUsd: sumEvaluationNumbersV1(
        attempts.map((attempt) => attempt.usage.admittedCeilingUsd),
      ),
    },
    rawArtifactReferences: [
      ...cases.map((caseManifest) => ({
        type: "CASE" as const,
        id: caseManifest.caseId,
        reference: caseReferences.get(caseManifest.caseId),
        digest: digestEvaluationArtifactV1(EvaluationCaseManifestV1Schema, caseManifest),
      })),
      {
        type: "SPLIT" as const,
        id: split.splitVersion,
        reference: input.references.split,
        digest: digestEvaluationArtifactV1(EvaluationFamilySplitManifestV1Schema, split),
      },
      {
        type: "EXPERIMENT" as const,
        id: experiment.experimentId,
        reference: input.references.experiment,
        digest: digestEvaluationArtifactV1(EvaluationExperimentManifestV1Schema, experiment),
      },
      ...attempts.map((attempt) => ({
        type: "ATTEMPT" as const,
        id: attempt.attemptId,
        reference: attemptReferences.get(attempt.attemptId),
        digest: digestEvaluationArtifactV1(EvaluationAttemptRecordV1Schema, attempt),
      })),
      ...adjudications.map((adjudication) => ({
        type: "ADJUDICATION" as const,
        id: adjudication.adjudicationId,
        reference: adjudicationReferences.get(adjudication.adjudicationId),
        digest: digestEvaluationArtifactV1(EvaluationAdjudicationRecordV1Schema, adjudication),
      })),
    ],
  });
  validateEvaluationArtifactGraphV1({
    experiment,
    split,
    cases,
    attempts,
    adjudications,
    score: report,
  });
  return report;
}
