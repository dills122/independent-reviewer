import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  digestEvaluationArtifactV1,
  EvaluationAdjudicationRecordV1Schema,
  EvaluationCaseManifestV1Schema,
  EvaluationExperimentManifestV1Schema,
  EvaluationFamilySplitManifestV1Schema,
} from "../../evaluation/artifact-contracts.js";
import { validateEvaluationArtifactGraphV1 } from "../../evaluation/artifact-graph.js";
import { scoreEvaluationArtifactsV1 } from "../../evaluation/scorer.js";
import {
  EVALUATION_SCORER_POLICY_DIGEST_V1,
  EVALUATION_SCORER_POLICY_DOCUMENT_V1,
  EVALUATION_SCORER_VERSION_V1,
} from "../../evaluation/scorer-policy.js";
import { sha256BytesDigestV1 } from "../../src/contracts/json-document.js";
import { makeEvaluationGraph } from "./artifact-fixtures.js";

function artifactReferences(graph: ReturnType<typeof makeEvaluationGraph>) {
  return {
    cases: graph.cases.map(({ caseId }) => ({ caseId, reference: `cases/${caseId}.json` })),
    split: "split.json",
    experiment: "experiment.json",
    attempts: graph.attempts.map(({ attemptId }) => ({
      attemptId,
      reference: `attempts/${attemptId}.json`,
    })),
    adjudications: graph.adjudications.map(({ adjudicationId }) => ({
      adjudicationId,
      reference: `adjudications/${adjudicationId}.json`,
    })),
  };
}

function rebindExperiment(graph: ReturnType<typeof makeEvaluationGraph>): void {
  for (const assignment of graph.split.assignments) {
    const caseManifest = graph.cases.find(({ caseId }) => caseId === assignment.caseId);
    assert.ok(caseManifest);
    assignment.caseManifestDigest = digestEvaluationArtifactV1(
      EvaluationCaseManifestV1Schema,
      caseManifest,
    );
  }
  graph.experiment.splitManifestDigest = digestEvaluationArtifactV1(
    EvaluationFamilySplitManifestV1Schema,
    graph.split,
  );
  const experimentDigest = digestEvaluationArtifactV1(
    EvaluationExperimentManifestV1Schema,
    graph.experiment,
  );
  for (const attempt of graph.attempts) attempt.experimentManifestDigest = experimentDigest;
  for (const adjudication of graph.adjudications)
    adjudication.experimentManifestDigest = experimentDigest;
}

function scoreGraph(graph: ReturnType<typeof makeEvaluationGraph>) {
  return scoreEvaluationArtifactsV1({
    experiment: graph.experiment,
    split: graph.split,
    cases: graph.cases,
    attempts: graph.attempts,
    adjudications: graph.adjudications,
    scoreId: "score_generated",
    generatedAt: "2026-09-15T12:10:00.000Z",
    references: artifactReferences(graph),
  });
}

function metric(
  metrics: ReturnType<typeof scoreGraph>["metrics"],
  name: (typeof metrics)[number]["metric"],
) {
  const value = metrics.find(({ metric: metricName }) => metricName === name);
  assert.ok(value);
  return value;
}

describe("evaluation scorer", () => {
  it("builds a deterministic, graph-valid score from fixed evaluation artifacts", () => {
    const graph = makeEvaluationGraph();
    const first = scoreGraph(graph);
    const second = scoreGraph(graph);

    assert.deepEqual(first, second);
    assert.doesNotThrow(() =>
      validateEvaluationArtifactGraphV1({
        experiment: graph.experiment,
        split: graph.split,
        cases: graph.cases,
        attempts: graph.attempts,
        adjudications: graph.adjudications,
        score: first,
      }),
    );
    assert.deepEqual(first.missingness, {
      startedAttempts: 4,
      deliveredReports: 4,
      missingReports: 0,
    });
  });

  it("credits each matched root once while retaining duplicate burden", () => {
    const score = scoreGraph(makeEvaluationGraph());

    assert.deepEqual(metric(score.metrics, "KNOWN_DEFECT_RECALL_COMPLETED"), {
      metric: "KNOWN_DEFECT_RECALL_COMPLETED",
      numerator: 2,
      denominator: 2,
      value: 1,
      interval: {
        method: "CONSERVATIVE_BOUNDS_V1",
        confidenceLevel: 0.95,
        lower: 0,
        upper: 1,
        independentUnit: "FAMILY",
      },
    });
    assert.equal(metric(score.metrics, "UNIQUE_ACTION_YIELD").value, 1 / 3);
    assert.equal(metric(score.metrics, "DUPLICATE_RATE").value, 1 / 3);
  });

  it("keeps incomplete-gold claims unresolved and excludes them from point precision", () => {
    const graph = makeEvaluationGraph();
    const cleanCase = graph.cases.find(({ caseId }) => caseId === "case_clean");
    assert.ok(cleanCase);
    cleanCase.oracleInventory.labelsExhaustive = false;
    const cleanAdjudication = graph.adjudications.find(
      ({ caseId, label }) => caseId === "case_clean" && label === "INVALID_DEFECT",
    );
    assert.ok(cleanAdjudication);
    Object.assign(cleanAdjudication, {
      label: "UNRESOLVED",
      unresolvedDisagreement: "Gold labels are non-exhaustive; causal review pending.",
    });
    rebindExperiment(graph);

    const score = scoreGraph(graph);

    assert.equal(score.adjudicationCoverage.unresolvedClaims, 1);
    assert.deepEqual(score.adjudicationCoverage.unresolvedAdjudicationIds, [
      cleanAdjudication.adjudicationId,
    ]);
    assert.equal(metric(score.metrics, "ADJUDICATED_DEFECT_PRECISION").value, 2 / 3);
    assert.equal(metric(score.metrics, "CONSERVATIVE_PRECISION_BOUND").value, 0.5);
  });

  it("keeps provider failure outside semantic completion while charging all-start recall", () => {
    const graph = makeEvaluationGraph();
    const failed = graph.attempts.find(
      ({ caseId, variantId }) => caseId === "case_defect" && variantId === "variant_baseline",
    );
    assert.ok(failed);
    const final = failed.stageOutcomes.find(({ stage }) => stage === "FINAL");
    assert.ok(final);
    Object.assign(final, { state: "FAILED", artifactDigest: null });
    failed.findingClaims = failed.findingClaims.filter(
      ({ emittedAtStage }) => emittedAtStage !== "FINAL",
    );
    Object.assign(failed, {
      terminalOutcome: {
        kind: "PROVIDER_FAILURE",
        stage: "FINAL",
        failureCode: "PROVIDER_RATE_LIMITED",
        transportUncertain: false,
      },
    });
    const retainedReferences = new Set(
      failed.findingClaims.map(({ findingReference }) => findingReference),
    );
    graph.adjudications = graph.adjudications.filter(
      ({ attemptId, findingReference }) =>
        attemptId !== failed.attemptId || retainedReferences.has(findingReference),
    );

    const score = scoreGraph(graph);

    assert.deepEqual(score.missingness, {
      startedAttempts: 4,
      deliveredReports: 3,
      missingReports: 1,
    });
    assert.equal(metric(score.metrics, "DELIVERY_RATE").value, 0.75);
    assert.equal(metric(score.metrics, "KNOWN_DEFECT_RECALL_COMPLETED").value, 1);
    assert.equal(metric(score.metrics, "KNOWN_DEFECT_RECALL_ALL_STARTS").value, 0.5);
    assert.equal(metric(score.metrics, "FALSE_ABSTENTION_RATE").numerator, 0);
    assert.deepEqual(
      {
        numerator: metric(score.metrics, "STAGE_RETENTION_RATE").numerator,
        denominator: metric(score.metrics, "STAGE_RETENTION_RATE").denominator,
      },
      { numerator: 2, denominator: 2 },
    );
    const failedEvidence = score.attemptEvidence.find(
      ({ attemptId }) => attemptId === failed.attemptId,
    );
    assert.ok(failedEvidence);
    assert.deepEqual(
      failedEvidence.metrics.find(({ metric: name }) => name === "STAGE_RETENTION_RATE"),
      {
        metric: "STAGE_RETENTION_RATE",
        numerator: 0,
        denominator: 0,
      },
    );
  });

  it("counts semantic abstention as delivered but false when required evidence is complete", () => {
    const graph = makeEvaluationGraph();
    const abstained = graph.attempts.find(
      ({ caseId, variantId }) => caseId === "case_clean" && variantId === "variant_baseline",
    );
    assert.ok(abstained);
    assert.equal(abstained.terminalOutcome.kind, "DELIVERED");
    if (abstained.terminalOutcome.kind !== "DELIVERED") return;
    Object.assign(abstained, {
      terminalOutcome: {
        kind: "SEMANTIC_ABSTENTION",
        reportReference: abstained.terminalOutcome.reportReference,
        reportDigest: abstained.terminalOutcome.reportDigest,
        reason: "Model could not reach a semantic conclusion.",
      },
    });

    const score = scoreGraph(graph);

    assert.equal(score.missingness.deliveredReports, 4);
    assert.equal(metric(score.metrics, "DELIVERY_RATE").value, 1);
    assert.equal(metric(score.metrics, "FALSE_ABSTENTION_RATE").value, 0.25);
  });

  it("reports zero denominators as unavailable and preserves recommendation adjudications", () => {
    const graph = makeEvaluationGraph();
    const cleanAttempt = graph.attempts.find(
      ({ caseId, variantId }) => caseId === "case_clean" && variantId === "variant_baseline",
    );
    assert.ok(cleanAttempt);
    const claim = cleanAttempt.findingClaims[0];
    assert.ok(claim);
    claim.claimKind = "RECOMMENDATION";
    const adjudication = graph.adjudications.find(
      ({ attemptId }) => attemptId === cleanAttempt.attemptId,
    );
    assert.ok(adjudication);
    const cleanCase = graph.cases.find(({ caseId }) => caseId === "case_clean");
    assert.ok(cleanCase);
    const source = cleanCase.reviewerInputInventory.find(({ role }) => role === "SOURCE_CHANGE");
    assert.ok(source);
    adjudication.label = "USEFUL_RECOMMENDATION";
    adjudication.causalEvidence = [
      { source: "CASE_INPUT", reference: source.reference, digest: source.digest },
    ];
    adjudication.promotionAuthority = { type: "HUMAN", identity: "reviewer@example.invalid" };
    Object.assign(adjudication, { severityCalibration: null });
    adjudication.rationale = "Useful non-defect improvement supported by retained source.";

    const score = scoreGraph(graph);
    const cleanBreakdown = score.caseBreakdowns.find(({ caseId }) => caseId === "case_clean");
    assert.ok(cleanBreakdown);
    const recall = metric(cleanBreakdown.metrics, "KNOWN_DEFECT_RECALL_COMPLETED");

    assert.equal(recall.denominator, 0);
    assert.equal(recall.value, null);
    assert.equal(recall.interval, null);
    assert.equal(metric(score.metrics, "ADJUDICATED_DEFECT_PRECISION").value, 2 / 3);
    assert.ok(
      score.rawArtifactReferences.some(
        ({ type, id }) => type === "ADJUDICATION" && id === adjudication.adjudicationId,
      ),
    );
    assert.ok(
      score.attemptEvidence
        .find(({ attemptId }) => attemptId === cleanAttempt.attemptId)
        ?.adjudicationIds.includes(adjudication.adjudicationId),
    );
  });

  it("scores expected uncertainty without treating abstention as provider failure", () => {
    const graph = makeEvaluationGraph();
    const cleanCase = graph.cases.find(({ caseId }) => caseId === "case_clean");
    assert.ok(cleanCase);
    Object.assign(cleanCase.oracleInventory, {
      expectedUncertainties: [
        {
          uncertaintyId: "uncertainty_missing_contract",
          obligationId: "obligation_currency",
          description: "Required upstream currency contract is unavailable.",
        },
      ],
    });
    const source = cleanCase.reviewerInputInventory.find(({ role }) => role === "SOURCE_CHANGE");
    assert.ok(source);
    for (const attempt of graph.attempts.filter(({ caseId }) => caseId === cleanCase.caseId)) {
      const claim = attempt.findingClaims[0];
      assert.ok(claim);
      claim.claimKind = "UNCERTAINTY";
      const adjudication = graph.adjudications.find(
        ({ attemptId }) => attemptId === attempt.attemptId,
      );
      assert.ok(adjudication);
      Object.assign(adjudication, {
        label: "SUPPORTED_UNCERTAINTY",
        matchedUncertaintyId: "uncertainty_missing_contract",
        causalEvidence: [
          { source: "CASE_INPUT", reference: source.reference, digest: source.digest },
        ],
        promotionAuthority: { type: "HUMAN", identity: "reviewer@example.invalid" },
        severityCalibration: null,
        rationale: "Missing contract prevents a supported conclusion.",
      });
    }
    rebindExperiment(graph);

    const score = scoreGraph(graph);
    const uncertainty = metric(score.metrics, "CORRECT_UNCERTAINTY_RATE");

    assert.deepEqual(
      {
        numerator: uncertainty.numerator,
        denominator: uncertainty.denominator,
        value: uncertainty.value,
      },
      { numerator: 2, denominator: 2, value: 1 },
    );
    assert.equal(metric(score.metrics, "FALSE_ABSTENTION_RATE").denominator, 2);
  });

  it("derives severity and standards enforcement confusion from adjudications", () => {
    const graph = makeEvaluationGraph();
    const cleanCase = graph.cases.find(({ caseId }) => caseId === "case_clean");
    assert.ok(cleanCase);
    Object.assign(cleanCase, { reviewMode: "STANDARDS" });
    const cleanAdjudications = graph.adjudications.filter(
      ({ caseId }) => caseId === cleanCase.caseId,
    );
    const classified = cleanAdjudications[0];
    const unavailable = cleanAdjudications[1];
    assert.ok(classified);
    assert.ok(unavailable);
    Object.assign(classified, {
      enforcementClassification: { expected: "REQUIRED", observed: "RECOMMENDED" },
    });
    Object.assign(unavailable, { enforcementClassification: null });
    rebindExperiment(graph);

    const score = scoreGraph(graph);

    assert.deepEqual(score.severityCalibration, {
      eligibleAdjudications: 10,
      classifiedAdjudications: 10,
      exact: 6,
      underclassified: 0,
      overclassified: 4,
      unavailableAdjudicationIds: [],
    });
    assert.equal(score.enforcementConfusion.eligibleAdjudications, 2);
    assert.equal(score.enforcementConfusion.classifiedAdjudications, 1);
    assert.deepEqual(score.enforcementConfusion.unavailableAdjudicationIds, [
      unavailable.adjudicationId,
    ]);
    assert.equal(
      score.enforcementConfusion.cells.find(
        ({ expected, observed }) => expected === "REQUIRED" && observed === "RECOMMENDED",
      )?.count,
      1,
    );
  });

  it("emits only predeclared paired deltas and rejects incomplete artifact references", () => {
    const graph = makeEvaluationGraph();
    const score = scoreGraph(graph);

    assert.deepEqual(score.pairedDeltas, [
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
    ]);

    const references = artifactReferences(graph);
    references.adjudications.pop();
    assert.throws(
      () =>
        scoreEvaluationArtifactsV1({
          experiment: graph.experiment,
          split: graph.split,
          cases: graph.cases,
          attempts: graph.attempts,
          adjudications: graph.adjudications,
          scoreId: "score_generated",
          generatedAt: "2026-09-15T12:10:00.000Z",
          references,
        }),
      /adjudication references must cover exact artifact set/i,
    );
  });

  it("scores true-root retention and false-root removal between preliminary and final", () => {
    const graph = makeEvaluationGraph();
    const baseline = scoreGraph(graph);
    assert.equal(metric(baseline.metrics, "STAGE_RETENTION_RATE").value, 1);

    const attempt = graph.attempts.find(
      ({ caseId, variantId }) => caseId === "case_defect" && variantId === "variant_baseline",
    );
    assert.ok(attempt);
    const preliminaryFalse = graph.adjudications.find(
      ({ attemptId, label }) => attemptId === attempt.attemptId && label === "INVALID_DEFECT",
    );
    assert.ok(preliminaryFalse);
    const preliminaryClaim = attempt.findingClaims.find(
      ({ findingReference }) => findingReference === preliminaryFalse.findingReference,
    );
    assert.ok(preliminaryClaim);
    const finalReference = `${preliminaryClaim.findingReference}_final`;
    attempt.findingClaims.push({
      ...preliminaryClaim,
      findingReference: finalReference,
      emittedAtStage: "FINAL",
    });
    graph.adjudications.push({
      ...preliminaryFalse,
      adjudicationId: "adjudication_persisted_false",
      findingReference: finalReference,
      adjudicatedAt: "2026-09-15T12:06:00.000Z",
    });

    const persisted = scoreGraph(graph);
    const retention = metric(persisted.metrics, "STAGE_RETENTION_RATE");

    assert.deepEqual(
      {
        numerator: retention.numerator,
        denominator: retention.denominator,
        value: retention.value,
      },
      { numerator: 3, denominator: 4, value: 0.75 },
    );
  });

  it("reports pooled global counts beside exact case and family breakdowns", () => {
    const score = scoreGraph(makeEvaluationGraph());
    const defect = score.caseBreakdowns.find(({ caseId }) => caseId === "case_defect");
    const clean = score.caseBreakdowns.find(({ caseId }) => caseId === "case_clean");
    const family = score.familyBreakdowns.find(({ familyId }) => familyId === "family_checkout");
    assert.ok(defect);
    assert.ok(clean);
    assert.ok(family);

    assert.deepEqual(
      {
        numerator: metric(defect.metrics, "KNOWN_DEFECT_RECALL_COMPLETED").numerator,
        denominator: metric(defect.metrics, "KNOWN_DEFECT_RECALL_COMPLETED").denominator,
      },
      { numerator: 2, denominator: 2 },
    );
    assert.equal(metric(clean.metrics, "KNOWN_DEFECT_RECALL_COMPLETED").value, null);
    assert.deepEqual(
      {
        numerator: metric(family.metrics, "CLEAN_FALSE_POSITIVE_RATE").numerator,
        denominator: metric(family.metrics, "CLEAN_FALSE_POSITIVE_RATE").denominator,
      },
      { numerator: 2, denominator: 2 },
    );
    assert.deepEqual(
      score.metrics.map(({ metric: name, numerator, denominator }) => ({
        metric: name,
        numerator,
        denominator,
      })),
      family.metrics.map(({ metric: name, numerator, denominator }) => ({
        metric: name,
        numerator,
        denominator,
      })),
    );
  });

  it("is invariant under artifact permutations and fractional aggregation order", () => {
    const graph = makeEvaluationGraph();
    const costs = new Map(
      [...graph.attempts]
        .sort((left, right) => left.attemptId.localeCompare(right.attemptId))
        .map(({ attemptId }, index) => [attemptId, [10_000_000_000_000_000, 1, 1, 0.25][index]]),
    );
    for (const attempt of graph.attempts) {
      const cost = costs.get(attempt.attemptId);
      assert.ok(cost !== undefined);
      attempt.usage.knownCostUsd = cost;
    }
    const canonical = scoreGraph(graph);
    const permuted = structuredClone(graph);
    permuted.cases.reverse();
    permuted.split.assignments.reverse();
    permuted.experiment.caseIds.reverse();
    permuted.experiment.variants.reverse();
    permuted.experiment.comparisons.reverse();
    permuted.attempts.reverse();
    permuted.adjudications.reverse();

    const rescored = scoreGraph(permuted);
    const permutedScore = structuredClone(canonical);
    permutedScore.metrics.reverse();
    permutedScore.caseBreakdowns.reverse();
    for (const breakdown of permutedScore.caseBreakdowns) breakdown.metrics.reverse();
    permutedScore.familyBreakdowns.reverse();
    for (const breakdown of permutedScore.familyBreakdowns) breakdown.metrics.reverse();
    permutedScore.attemptEvidence.reverse();
    for (const evidence of permutedScore.attemptEvidence) {
      evidence.adjudicationIds.reverse();
      evidence.metrics.reverse();
    }
    permutedScore.enforcementConfusion.cells.reverse();
    permutedScore.pairedDeltas.reverse();
    permutedScore.rawArtifactReferences.reverse();

    assert.deepEqual(rescored, canonical);
    assert.doesNotThrow(() =>
      validateEvaluationArtifactGraphV1({
        experiment: permuted.experiment,
        split: permuted.split,
        cases: permuted.cases,
        attempts: permuted.attempts,
        adjudications: permuted.adjudications,
        score: permutedScore,
      }),
    );
  });

  it("uses stable non-oracle semantic roots for novel defects and their duplicates", () => {
    const graph = makeEvaluationGraph();
    const attempt = graph.attempts.find(
      ({ caseId, variantId }) => caseId === "case_defect" && variantId === "variant_baseline",
    );
    assert.ok(attempt);
    const finalAdjudications = graph.adjudications.filter(({ attemptId, findingReference }) => {
      const claim = attempt.findingClaims.find(
        ({ findingReference: reference }) => reference === findingReference,
      );
      return attemptId === attempt.attemptId && claim?.emittedAtStage === "FINAL";
    });
    const credited = finalAdjudications.find(({ label }) => label === "MATCHED_DEFECT");
    const duplicate = finalAdjudications.find(({ label }) => label === "DUPLICATE");
    assert.ok(credited);
    assert.ok(duplicate);
    Object.assign(credited, {
      label: "NOVEL_VALID_DEFECT",
      matchedRootId: "root_novel_rounding",
    });
    duplicate.matchedRootId = "root_novel_rounding";
    const preliminary = graph.adjudications.find(({ attemptId, findingReference, label }) => {
      const claim = attempt.findingClaims.find(
        ({ findingReference: reference }) => reference === findingReference,
      );
      return (
        attemptId === attempt.attemptId &&
        claim?.emittedAtStage === "PRELIMINARY" &&
        label === "MATCHED_DEFECT"
      );
    });
    assert.ok(preliminary);
    Object.assign(preliminary, {
      label: "NOVEL_VALID_DEFECT",
      matchedRootId: "root_novel_rounding",
    });

    assert.doesNotThrow(() => EvaluationAdjudicationRecordV1Schema.parse(credited));
    const score = scoreGraph(graph);

    assert.equal(metric(score.metrics, "KNOWN_DEFECT_RECALL_COMPLETED").value, 0.5);
    assert.equal(metric(score.metrics, "ADJUDICATED_DEFECT_PRECISION").value, 0.5);
    assert.equal(metric(score.metrics, "UNIQUE_ACTION_YIELD").value, 1 / 3);
    assert.equal(metric(score.metrics, "DUPLICATE_RATE").value, 1 / 3);
    assert.equal(metric(score.metrics, "STAGE_RETENTION_RATE").value, 1);
  });

  it("rejects novel credit for an oracle root and repeated credit for one novel root", () => {
    const oracleRoot = makeEvaluationGraph();
    const oracleCredit = oracleRoot.adjudications.find(
      ({ label, findingReference }) =>
        label === "MATCHED_DEFECT" && findingReference.includes("finding_case_defect_1"),
    );
    assert.ok(oracleCredit);
    oracleCredit.label = "NOVEL_VALID_DEFECT";
    assert.throws(() => scoreGraph(oracleRoot), /novel.*non-oracle semantic root/i);

    const repeatedNovel = makeEvaluationGraph();
    const repeatedAttempt = repeatedNovel.attempts.find(
      ({ caseId, variantId }) => caseId === "case_defect" && variantId === "variant_baseline",
    );
    assert.ok(repeatedAttempt);
    const repeatedFinal = repeatedNovel.adjudications.filter(({ attemptId, findingReference }) => {
      const claim = repeatedAttempt.findingClaims.find(
        ({ findingReference: reference }) => reference === findingReference,
      );
      return attemptId === repeatedAttempt.attemptId && claim?.emittedAtStage === "FINAL";
    });
    for (const adjudication of repeatedFinal) {
      Object.assign(adjudication, {
        label: "NOVEL_VALID_DEFECT",
        matchedRootId: "root_novel_rounding",
      });
    }
    assert.throws(() => scoreGraph(repeatedNovel), /more than one semantic-root credit.*FINAL/i);
  });

  it("requires duplicates to reference a credited known or novel root in the same stage", () => {
    const graph = makeEvaluationGraph();
    const duplicate = graph.adjudications.find(
      ({ label, findingReference }) =>
        label === "DUPLICATE" && findingReference.includes("case_defect_1"),
    );
    assert.ok(duplicate);
    duplicate.matchedRootId = "root_novel_orphan";

    assert.throws(() => scoreGraph(graph), /duplicate.*credited semantic root.*FINAL/i);
  });

  it("binds scoring to retained V1 implementation and canonical policy bytes", () => {
    assert.equal(EVALUATION_SCORER_VERSION_V1, "evaluation-scorer-v1");
    assert.deepEqual(
      EVALUATION_SCORER_POLICY_DIGEST_V1,
      sha256BytesDigestV1(Buffer.from(EVALUATION_SCORER_POLICY_DOCUMENT_V1, "utf8")),
    );

    const wrongVersion = makeEvaluationGraph();
    wrongVersion.experiment.scorerVersion = "evaluation-scorer-spoofed";
    rebindExperiment(wrongVersion);
    assert.throws(() => scoreGraph(wrongVersion), /unsupported scorer version/i);

    const wrongPolicy = makeEvaluationGraph();
    wrongPolicy.experiment.scorerPolicyDigest = {
      algorithm: "SHA256",
      value: "0".repeat(64),
    };
    rebindExperiment(wrongPolicy);
    assert.throws(() => scoreGraph(wrongPolicy), /unsupported scorer policy digest/i);
  });
});
