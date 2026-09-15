import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateEvaluationArtifactGraphV1 } from "../../evaluation/artifact-graph.js";
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
    assert.throws(
      () => validateEvaluationArtifactGraphV1(wrongRoot),
      /does not belong to case oracle/i,
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
    assert.throws(() => validateEvaluationArtifactGraphV1(badVariant), /unknown variant/i);
  });
});
