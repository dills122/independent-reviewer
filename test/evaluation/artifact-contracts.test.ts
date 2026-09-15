import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  digestEvaluationArtifactV1,
  EvaluationAdjudicationRecordV1Schema,
  EvaluationAttemptRecordV1Schema,
  EvaluationCaseManifestV1Schema,
  EvaluationExperimentManifestV1Schema,
  EvaluationScoreReportV1Schema,
  serializeEvaluationArtifactV1,
  validateEvaluationFamilySplitV1,
} from "../../evaluation/artifact-contracts.js";
import { makeEvaluationGraph, sha } from "./artifact-fixtures.js";

function first<T>(values: readonly T[]): T {
  const value = values[0];
  assert.ok(value);
  return value;
}

describe("evaluation artifact contracts", () => {
  it("keeps evaluator oracles structurally separate from permitted reviewer inputs", () => {
    const { cases } = makeEvaluationGraph();
    const caseManifest = first(cases);
    assert.throws(
      () =>
        EvaluationCaseManifestV1Schema.parse({
          ...caseManifest,
          reviewerInputInventory: [
            { role: "TEST_EVIDENCE", reference: "renamed-hidden.test.mjs", digest: sha("2") },
          ],
        }),
      /oracle artifact.*reviewer input/i,
    );
  });

  it("requires a complete two-member DEFECT/CLEAN pair in one split", () => {
    const { cases, split } = makeEvaluationGraph();
    assert.doesNotThrow(() => validateEvaluationFamilySplitV1(split, cases));
    assert.throws(
      () =>
        validateEvaluationFamilySplitV1(
          { ...split, assignments: split.assignments.slice(0, 1) },
          cases.slice(0, 1),
        ),
      /exactly two cases/i,
    );
    const third = { ...structuredClone(first(cases.slice(1))), caseId: "case_extra" };
    const overfullCases = [...cases, third];
    const overfullSplit = {
      ...split,
      assignments: [
        ...split.assignments,
        {
          ...first(split.assignments.slice(1)),
          caseId: "case_extra",
          caseManifestDigest: digestEvaluationArtifactV1(EvaluationCaseManifestV1Schema, third),
        },
      ],
    };
    assert.throws(
      () => validateEvaluationFamilySplitV1(overfullSplit, overfullCases),
      /exactly two cases/i,
    );
    const sameRoles = structuredClone(cases);
    first(sameRoles.slice(1)).pair.role = "DEFECT";
    const sameRoleSplit = {
      ...split,
      assignments: split.assignments.map((entry, index) => ({
        ...entry,
        caseManifestDigest: digestEvaluationArtifactV1(
          EvaluationCaseManifestV1Schema,
          sameRoles[index],
        ),
      })),
    };
    assert.throws(
      () => validateEvaluationFamilySplitV1(sameRoleSplit, sameRoles),
      /one DEFECT and one CLEAN/i,
    );
    const crossed = {
      ...split,
      assignments: split.assignments.map((entry, index) => ({
        ...entry,
        split: index === 0 ? "DEVELOPMENT" : "HOLDOUT",
      })),
    };
    assert.throws(
      () => validateEvaluationFamilySplitV1(crossed, cases),
      /family_checkout.*both|pair_checkout.*both/i,
    );
  });

  it("freezes complete metric and baseline/candidate comparison membership", () => {
    const { experiment } = makeEvaluationGraph();
    assert.doesNotThrow(() => EvaluationExperimentManifestV1Schema.parse(experiment));
    assert.throws(
      () =>
        EvaluationExperimentManifestV1Schema.parse({
          ...experiment,
          metricSet: experiment.metricSet.slice(0, 1),
        }),
      /every protocol metric/i,
    );
    assert.throws(
      () =>
        EvaluationExperimentManifestV1Schema.parse({
          ...experiment,
          comparisons: [
            {
              ...first(experiment.comparisons),
              candidateVariantId: "variant_baseline",
            },
          ],
        }),
      /comparison variants must differ/i,
    );
  });

  it("enforces stage order, artifact states, terminal report identity, and accounting", () => {
    const { attempts } = makeEvaluationGraph();
    const attempt = first(attempts);
    assert.doesNotThrow(() => EvaluationAttemptRecordV1Schema.parse(attempt));
    assert.throws(
      () =>
        EvaluationAttemptRecordV1Schema.parse({
          ...attempt,
          stageOutcomes: [attempt.stageOutcomes[2]],
        }),
      /ordered execution prefix/i,
    );
    assert.throws(
      () =>
        EvaluationAttemptRecordV1Schema.parse({
          ...attempt,
          stageOutcomes: [{ ...attempt.stageOutcomes[0], state: "FAILED" }],
        }),
      /failed stage cannot have artifact digest|every stage/i,
    );
    assert.throws(
      () =>
        EvaluationAttemptRecordV1Schema.parse({
          ...attempt,
          terminalOutcome: { ...attempt.terminalOutcome, reportDigest: sha("0") },
        }),
      /final stage artifact digest/i,
    );
    assert.throws(
      () => EvaluationAttemptRecordV1Schema.parse({ ...attempt, elapsedMs: 999 }),
      /timestamp difference/i,
    );
    assert.throws(
      () =>
        EvaluationAttemptRecordV1Schema.parse({
          ...attempt,
          usage: { ...attempt.usage, totalTokens: 16 },
        }),
      /total tokens/i,
    );
    assert.throws(
      () =>
        EvaluationAttemptRecordV1Schema.parse({
          ...attempt,
          usage: { ...attempt.usage, providerAttempts: 2 },
        }),
      /lower than executed provider stages/i,
    );
  });

  it("distinguishes terminal provider failure from semantic abstention", () => {
    const { attempts } = makeEvaluationGraph();
    const base = first(attempts);
    const providerFailure = {
      ...base,
      runtimeRunReference: null,
      stageOutcomes: [
        base.stageOutcomes[0],
        {
          stage: "FINDING_VERIFICATION",
          state: "FAILED",
          artifactDigest: null,
          elapsedMs: 700,
          providerCall: true,
        },
      ],
      findingClaims: [],
      terminalOutcome: {
        kind: "PROVIDER_FAILURE",
        stage: "FINDING_VERIFICATION",
        failureCode: "HTTP_502",
        transportUncertain: false,
      },
    };
    assert.equal(
      EvaluationAttemptRecordV1Schema.parse(providerFailure).terminalOutcome.kind,
      "PROVIDER_FAILURE",
    );
    const abstention = {
      ...base,
      terminalOutcome: {
        kind: "SEMANTIC_ABSTENTION",
        reportReference: base.terminalOutcome.reportReference,
        reportDigest: first(base.stageOutcomes.slice(2)).artifactDigest,
        reason: "Required evidence unavailable.",
      },
    };
    assert.equal(
      EvaluationAttemptRecordV1Schema.parse(abstention).terminalOutcome.kind,
      "SEMANTIC_ABSTENTION",
    );
    assert.throws(
      () =>
        EvaluationAttemptRecordV1Schema.parse({
          ...providerFailure,
          stageOutcomes: [base.stageOutcomes[0]],
        }),
      /provider failure.*failed stage/i,
    );
  });

  it("counts provider calls independently from successful local logical stages", () => {
    const { attempts } = makeEvaluationGraph();
    const attempt = structuredClone(
      attempts.find(({ caseId }) => caseId === "case_clean") ?? first(attempts),
    );
    attempt.findingClaims = [];
    first(attempt.stageOutcomes.slice(1, 2)).providerCall = false;
    attempt.usage.providerAttempts = 2;
    assert.doesNotThrow(() => EvaluationAttemptRecordV1Schema.parse(attempt));
  });

  it("requires causal evidence and human promotion authority for supported labels", () => {
    const { adjudications } = makeEvaluationGraph();
    const supported = first(adjudications);
    assert.doesNotThrow(() => EvaluationAdjudicationRecordV1Schema.parse(supported));
    assert.throws(
      () => EvaluationAdjudicationRecordV1Schema.parse({ ...supported, causalEvidence: [] }),
      /causal evidence/i,
    );
    assert.throws(
      () => EvaluationAdjudicationRecordV1Schema.parse({ ...supported, promotionAuthority: null }),
      /human promotion authority/i,
    );
  });

  it("requires every metric, intervals, typed raw refs, and inspectable breakdowns", () => {
    const { score } = makeEvaluationGraph();
    assert.doesNotThrow(() => EvaluationScoreReportV1Schema.parse(score));
    assert.throws(
      () => EvaluationScoreReportV1Schema.parse({ ...score, metrics: score.metrics.slice(0, 1) }),
      /every protocol metric/i,
    );
    assert.throws(
      () => EvaluationScoreReportV1Schema.parse({ ...score, rawArtifactReferences: [] }),
      /too_small|at least one/i,
    );
    assert.throws(
      () => EvaluationScoreReportV1Schema.parse({ ...score, caseBreakdowns: [] }),
      /too_small|at least one/i,
    );
    assert.throws(
      () =>
        EvaluationScoreReportV1Schema.parse({
          ...score,
          caseBreakdowns: score.caseBreakdowns.map((breakdown) => ({
            ...breakdown,
            metrics: breakdown.metrics.slice(0, 1),
          })),
        }),
      /breakdown requires every protocol metric/i,
    );
    const zero = {
      ...score,
      metrics: score.metrics.map((metric, index) =>
        index === 0
          ? { ...metric, numerator: 0, denominator: 0, value: null, interval: null }
          : metric,
      ),
    };
    assert.equal(
      EvaluationScoreReportV1Schema.parse(zero).metrics.find(
        ({ metric }) => metric === "KNOWN_DEFECT_RECALL_COMPLETED",
      )?.value,
      null,
    );
    const invalidZero = {
      ...zero,
      metrics: zero.metrics.map((metric, index) =>
        index === 0
          ? {
              ...metric,
              interval: {
                method: "Wilson",
                confidenceLevel: 0.95,
                lower: 0,
                upper: 1,
                independentUnit: "CASE",
              },
            }
          : metric,
      ),
    };
    assert.throws(
      () => EvaluationScoreReportV1Schema.parse(invalidZero),
      /zero denominator interval/i,
    );
  });

  it("serializes parsed artifacts deterministically and digests exact document bytes", () => {
    const { cases } = makeEvaluationGraph();
    const first = serializeEvaluationArtifactV1(EvaluationCaseManifestV1Schema, cases[0]);
    const second = serializeEvaluationArtifactV1(
      EvaluationCaseManifestV1Schema,
      JSON.parse(first) as unknown,
    );
    assert.equal(first, second);
    assert.equal(first.endsWith("\n"), true);
    assert.deepEqual(
      digestEvaluationArtifactV1(EvaluationCaseManifestV1Schema, cases[0]),
      digestEvaluationArtifactV1(EvaluationCaseManifestV1Schema, JSON.parse(first) as unknown),
    );
  });
});
