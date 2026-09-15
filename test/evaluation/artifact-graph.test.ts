import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  digestEvaluationArtifactV1,
  EvaluationAdjudicationRecordV1Schema,
  EvaluationAttemptRecordV1Schema,
  EvaluationCaseManifestV1Schema,
} from "../../evaluation/artifact-contracts.js";
import {
  deriveEvaluationAttemptMetricCountsV1,
  isEvaluationAdjudicationLabelAllowedV1,
  validateEvaluationArtifactGraphV1,
} from "../../evaluation/artifact-graph.js";
import { makeEvaluationGraph, sha } from "./artifact-fixtures.js";

function first<T>(values: readonly T[]): T {
  const value = values[0];
  assert.ok(value);
  return value;
}

describe("evaluation artifact graph", () => {
  it("accepts exact planned coverage and bound artifact identities", () => {
    assert.doesNotThrow(() => validateEvaluationArtifactGraphV1(makeEvaluationGraph()));
  });

  it("binds attempts, adjudications, and scores to exact experiment bytes", () => {
    for (const target of ["attempts", "adjudications", "score"] as const) {
      const graph = makeEvaluationGraph();
      if (target === "score") graph.score.experimentManifestDigest = sha("0");
      else if (target === "attempts") first(graph.attempts).experimentManifestDigest = sha("0");
      else first(graph.adjudications).experimentManifestDigest = sha("0");
      assert.throws(
        () => validateEvaluationArtifactGraphV1(graph),
        /experiment manifest identity/i,
      );
    }
  });

  it("rejects missing, duplicate, unknown-variant, and out-of-plan attempts", () => {
    const missing = makeEvaluationGraph();
    missing.attempts.pop();
    assert.throws(() => validateEvaluationArtifactGraphV1(missing), /missing planned attempt/i);

    const duplicate = makeEvaluationGraph();
    duplicate.attempts.push({ ...first(duplicate.attempts), attemptId: "attempt_duplicate" });
    assert.throws(() => validateEvaluationArtifactGraphV1(duplicate), /duplicate planned attempt/i);

    const variant = makeEvaluationGraph();
    first(variant.attempts).variantId = "variant_unknown";
    assert.throws(() => validateEvaluationArtifactGraphV1(variant), /unknown variant/i);

    const repetition = makeEvaluationGraph();
    first(repetition.attempts).repetition = 2;
    assert.throws(() => validateEvaluationArtifactGraphV1(repetition), /repetition exceeds/i);
  });

  it("cross-checks attempt split, source, engine, and case identities", () => {
    for (const mutation of [
      (graph: ReturnType<typeof makeEvaluationGraph>) => {
        first(graph.attempts).split = "HOLDOUT";
      },
      (graph: ReturnType<typeof makeEvaluationGraph>) => {
        first(graph.attempts).sourceIdentityDigest = sha("0");
      },
      (graph: ReturnType<typeof makeEvaluationGraph>) => {
        first(graph.attempts).engineIdentityDigest = sha("0");
      },
      (graph: ReturnType<typeof makeEvaluationGraph>) => {
        Object.assign(first(graph.attempts), { caseId: "case_unknown" });
      },
    ]) {
      const graph = makeEvaluationGraph();
      mutation(graph);
      assert.throws(
        () => validateEvaluationArtifactGraphV1(graph),
        /split identity|source identity|engine identity|unknown case/i,
      );
    }
  });

  it("requires one exact adjudication for every emitted claim and case-owned roots", () => {
    const missing = makeEvaluationGraph();
    missing.adjudications.pop();
    assert.throws(() => validateEvaluationArtifactGraphV1(missing), /missing adjudication/i);

    const wrongClaim = makeEvaluationGraph();
    first(wrongClaim.adjudications).claimDigest = sha("0");
    assert.throws(() => validateEvaluationArtifactGraphV1(wrongClaim), /claim identity/i);

    const wrongRoot = makeEvaluationGraph();
    first(wrongRoot.adjudications).matchedRootId = "root_other";
    assert.throws(() => validateEvaluationArtifactGraphV1(wrongRoot), /case-oracle semantic root/i);

    const missingFalseRoot = makeEvaluationGraph();
    const invalid = first(
      missingFalseRoot.adjudications.filter(({ label }) => label === "INVALID_DEFECT"),
    );
    Object.assign(invalid, { matchedRootId: null });
    assert.throws(
      () => validateEvaluationArtifactGraphV1(missingFalseRoot),
      /INVALID_DEFECT requires matched root ID/i,
    );

    const oracleFalseRoot = makeEvaluationGraph();
    const oracleInvalid = first(
      oracleFalseRoot.adjudications.filter(
        ({ caseId, label }) => caseId === "case_defect" && label === "INVALID_DEFECT",
      ),
    );
    oracleInvalid.matchedRootId = "root_double_conversion";
    assert.throws(
      () => validateEvaluationArtifactGraphV1(oracleFalseRoot),
      /invalid defect.*non-oracle semantic root/i,
    );
  });

  it("enforces claim-kind labels and explicit recommendation validity", () => {
    assert.equal(isEvaluationAdjudicationLabelAllowedV1("DEFECT", "MATCHED_DEFECT"), true);
    assert.equal(
      isEvaluationAdjudicationLabelAllowedV1("UNCERTAINTY", "SUPPORTED_UNCERTAINTY"),
      true,
    );
    assert.equal(
      isEvaluationAdjudicationLabelAllowedV1("RECOMMENDATION", "USEFUL_RECOMMENDATION"),
      true,
    );
    assert.equal(
      isEvaluationAdjudicationLabelAllowedV1("RECOMMENDATION", "INVALID_RECOMMENDATION"),
      true,
    );
    assert.equal(isEvaluationAdjudicationLabelAllowedV1("UNCERTAINTY", "MATCHED_DEFECT"), false);
    assert.equal(isEvaluationAdjudicationLabelAllowedV1("RECOMMENDATION", "INVALID_DEFECT"), false);

    const wrongKind = makeEvaluationGraph();
    const adjudication = first(wrongKind.adjudications);
    Object.assign(adjudication, { label: "USEFUL_RECOMMENDATION", matchedRootId: null });
    assert.throws(
      () => validateEvaluationArtifactGraphV1(wrongKind),
      /claim kind DEFECT cannot use adjudication label USEFUL_RECOMMENDATION/i,
    );

    const recommendation = {
      ...adjudication,
      label: "USEFUL_RECOMMENDATION",
      matchedRootId: null,
      matchedUncertaintyId: null,
    };
    assert.equal(
      EvaluationAdjudicationRecordV1Schema.parse(recommendation).label,
      "USEFUL_RECOMMENDATION",
    );
    assert.equal(
      EvaluationAdjudicationRecordV1Schema.parse({
        ...recommendation,
        label: "INVALID_RECOMMENDATION",
        causalEvidence: [],
        promotionAuthority: null,
      }).label,
      "INVALID_RECOMMENDATION",
    );
  });

  it("scores true-root retention and false-root removal across stages", () => {
    const graph = makeEvaluationGraph();
    const attempt = first(graph.attempts.filter(({ caseId }) => caseId === "case_defect"));
    const caseManifest = first(graph.cases.filter(({ caseId }) => caseId === attempt.caseId));
    const attemptAdjudications = graph.adjudications.filter(
      ({ attemptId }) => attemptId === attempt.attemptId,
    );
    const retained = deriveEvaluationAttemptMetricCountsV1(
      EvaluationAttemptRecordV1Schema.parse(attempt),
      EvaluationCaseManifestV1Schema.parse(caseManifest),
      attemptAdjudications.map((value) => EvaluationAdjudicationRecordV1Schema.parse(value)),
    ).find(({ metric }) => metric === "STAGE_RETENTION_RATE");
    assert.deepEqual(retained, {
      metric: "STAGE_RETENTION_RATE",
      numerator: 2,
      denominator: 2,
    });

    const preliminaryFalse = first(
      attemptAdjudications.filter(({ label }) => label === "INVALID_DEFECT"),
    );
    const falseClaim = first(
      attempt.findingClaims.filter(
        ({ findingReference }) => findingReference === preliminaryFalse.findingReference,
      ),
    );
    const persistedAttempt = structuredClone(attempt);
    persistedAttempt.findingClaims.push({
      ...falseClaim,
      findingReference: `${falseClaim.findingReference}_final`,
      claimDigest: sha("9"),
      emittedAtStage: "FINAL",
    });
    const persistedFalse = {
      ...preliminaryFalse,
      adjudicationId: "adjudication_persisted_false",
      findingReference: `${falseClaim.findingReference}_final`,
      claimDigest: sha("9"),
      adjudicatedAt: "2026-09-15T12:06:00.000Z",
    };
    const notRemoved = deriveEvaluationAttemptMetricCountsV1(
      EvaluationAttemptRecordV1Schema.parse(persistedAttempt),
      EvaluationCaseManifestV1Schema.parse(caseManifest),
      [...attemptAdjudications, persistedFalse].map((value) =>
        EvaluationAdjudicationRecordV1Schema.parse(value),
      ),
    ).find(({ metric }) => metric === "STAGE_RETENTION_RATE");
    assert.deepEqual(notRemoved, {
      metric: "STAGE_RETENTION_RATE",
      numerator: 1,
      denominator: 2,
    });

    const doubleCredit = makeEvaluationGraph();
    const duplicate = first(
      doubleCredit.adjudications.filter(({ label }) => label === "DUPLICATE"),
    );
    duplicate.label = "MATCHED_DEFECT";
    assert.throws(
      () => validateEvaluationArtifactGraphV1(doubleCredit),
      /more than one semantic-root credit in FINAL/i,
    );
  });

  it("scores exhaustive zero-root controls as clean without pair metadata", () => {
    const graph = makeEvaluationGraph();
    const cleanCase = first(graph.cases.filter(({ caseId }) => caseId === "case_clean"));
    const cleanAttempt = first(
      graph.attempts.filter(
        ({ caseId, variantId }) => caseId === cleanCase.caseId && variantId === "variant_baseline",
      ),
    );
    Object.assign(cleanCase, { pair: null });

    const counts = deriveEvaluationAttemptMetricCountsV1(
      EvaluationAttemptRecordV1Schema.parse(cleanAttempt),
      EvaluationCaseManifestV1Schema.parse(cleanCase),
      graph.adjudications
        .filter(({ attemptId }) => attemptId === cleanAttempt.attemptId)
        .map((value) => EvaluationAdjudicationRecordV1Schema.parse(value)),
    );

    assert.deepEqual(
      counts.find(({ metric }) => metric === "CLEAN_FALSE_POSITIVE_RATE"),
      { metric: "CLEAN_FALSE_POSITIVE_RATE", numerator: 1, denominator: 1 },
    );
  });

  it("requires score breakdown and typed raw-reference coverage for exact graph", () => {
    const missingCase = makeEvaluationGraph();
    missingCase.score.caseBreakdowns.pop();
    assert.throws(
      () => validateEvaluationArtifactGraphV1(missingCase),
      /case breakdowns must cover/i,
    );

    const badReference = makeEvaluationGraph();
    first(badReference.score.rawArtifactReferences).digest = sha("0");
    assert.throws(() => validateEvaluationArtifactGraphV1(badReference), /raw reference.*digest/i);

    const badVariant = makeEvaluationGraph();
    first(badVariant.score.pairedDeltas).candidateVariantId = "variant_unknown";
    assert.throws(
      () => validateEvaluationArtifactGraphV1(badVariant),
      /different candidate variant/i,
    );
  });

  it("binds every raw artifact location to an independent unambiguous registry", () => {
    const wrongLocation = makeEvaluationGraph();
    first(wrongLocation.score.rawArtifactReferences).reference = "moved/case.json";
    assert.throws(
      () => validateEvaluationArtifactGraphV1(wrongLocation),
      /raw reference.*location/i,
    );

    const ambiguous = makeEvaluationGraph();
    const reusedReference = first(ambiguous.references.cases).reference;
    const attemptLocation = first(ambiguous.references.attempts);
    attemptLocation.reference = reusedReference;
    const rawAttempt = first(
      ambiguous.score.rawArtifactReferences.filter(({ type }) => type === "ATTEMPT"),
    );
    rawAttempt.reference = reusedReference;
    assert.throws(
      () => validateEvaluationArtifactGraphV1(ambiguous),
      /ambiguous raw artifact location/i,
    );
  });

  it("enforces exact complete deltas declared before execution", () => {
    const missing = makeEvaluationGraph();
    missing.score.pairedDeltas = [];
    assert.throws(() => validateEvaluationArtifactGraphV1(missing), /omits declared paired delta/i);

    const extra = makeEvaluationGraph();
    extra.score.pairedDeltas.push({
      ...first(extra.score.pairedDeltas),
      comparisonId: "comparison_extra",
    });
    assert.throws(
      () => validateEvaluationArtifactGraphV1(extra),
      /paired deltas must exactly match/i,
    );
  });

  it("recomputes score metrics and attempt-level resource evidence", () => {
    const global = makeEvaluationGraph();
    const recall = global.score.metrics.find(
      ({ metric }) => metric === "KNOWN_DEFECT_RECALL_COMPLETED",
    );
    assert.ok(recall);
    Object.assign(recall, { numerator: 1, denominator: 2, value: 0.5 });
    assert.throws(() => validateEvaluationArtifactGraphV1(global), /global metric.*artifacts/i);

    const contribution = makeEvaluationGraph();
    first(first(contribution.score.attemptEvidence).metrics).numerator = 0;
    assert.throws(
      () => validateEvaluationArtifactGraphV1(contribution),
      /attempt .* metric.*artifacts/i,
    );

    const resource = makeEvaluationGraph();
    first(resource.score.attemptEvidence).resources.evidenceBytes += 1;
    assert.throws(() => validateEvaluationArtifactGraphV1(resource), /resource evidence/i);

    const aggregateResource = makeEvaluationGraph();
    aggregateResource.score.resources.providerAttempts += 1;
    aggregateResource.score.cost.knownCostAttempts += 1;
    assert.throws(
      () => validateEvaluationArtifactGraphV1(aggregateResource),
      /provider-attempt total does not match/i,
    );
  });

  it("recomputes severity calibration and enforcement confusion", () => {
    const severity = makeEvaluationGraph();
    severity.score.severityCalibration.exact = 5;
    severity.score.severityCalibration.overclassified = 5;
    assert.throws(
      () => validateEvaluationArtifactGraphV1(severity),
      /severity calibration does not match/i,
    );

    const enforcement = makeEvaluationGraph();
    enforcement.score.enforcementConfusion.eligibleAdjudications = 1;
    enforcement.score.enforcementConfusion.classifiedAdjudications = 1;
    first(enforcement.score.enforcementConfusion.cells).count = 1;
    assert.throws(
      () => validateEvaluationArtifactGraphV1(enforcement),
      /enforcement (?:coverage|confusion) does not match/i,
    );
  });

  it("binds causal evidence to retained bytes and orders attempt, adjudication, and score", () => {
    const wrongEvidence = makeEvaluationGraph();
    first(first(wrongEvidence.adjudications).causalEvidence).digest = sha("0");
    assert.throws(
      () => validateEvaluationArtifactGraphV1(wrongEvidence),
      /not retained case input/i,
    );

    const reportEvidence = makeEvaluationGraph();
    const adjudication = first(reportEvidence.adjudications);
    const attempt = first(reportEvidence.attempts);
    assert.equal(adjudication.attemptId, attempt.attemptId);
    assert.ok("reportDigest" in attempt.terminalOutcome);
    adjudication.causalEvidence.push({
      source: "REPORT",
      reference: attempt.terminalOutcome.reportReference,
      digest: attempt.terminalOutcome.reportDigest,
    });
    const rawAdjudication = reportEvidence.score.rawArtifactReferences.find(
      ({ type, id }) => type === "ADJUDICATION" && id === adjudication.adjudicationId,
    );
    assert.ok(rawAdjudication);
    rawAdjudication.digest = digestEvaluationArtifactV1(
      EvaluationAdjudicationRecordV1Schema,
      adjudication,
    );
    assert.doesNotThrow(() => validateEvaluationArtifactGraphV1(reportEvidence));

    const earlyAdjudication = makeEvaluationGraph();
    first(earlyAdjudication.attempts).completedAt = "2026-09-15T12:06:00.000Z";
    first(earlyAdjudication.attempts).elapsedMs = 360_000;
    assert.throws(
      () => validateEvaluationArtifactGraphV1(earlyAdjudication),
      /adjudication cannot precede attempt completion/i,
    );

    const earlyScore = makeEvaluationGraph();
    earlyScore.score.generatedAt = "2026-09-15T12:04:00.000Z";
    assert.throws(
      () => validateEvaluationArtifactGraphV1(earlyScore),
      /score generation cannot precede adjudication/i,
    );
  });

  it("rejects graphs claiming an unimplemented scorer version or policy", () => {
    const wrongVersion = makeEvaluationGraph();
    wrongVersion.experiment.scorerVersion = "evaluation-scorer-spoofed";
    assert.throws(
      () => validateEvaluationArtifactGraphV1(wrongVersion),
      /unsupported scorer version/i,
    );

    const wrongPolicy = makeEvaluationGraph();
    wrongPolicy.experiment.scorerPolicyDigest = sha("0");
    assert.throws(
      () => validateEvaluationArtifactGraphV1(wrongPolicy),
      /unsupported scorer policy digest/i,
    );
  });
});
