import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EVALUATION_CORPUS_V1,
  validateEvaluationCorpusDefinitionV1,
} from "../../evaluation/corpus.js";

describe("evaluation corpus definition", () => {
  it("freezes 12 defect/clean pairs and six controls without splitting families", () => {
    const corpus = validateEvaluationCorpusDefinitionV1(EVALUATION_CORPUS_V1);
    const paired = corpus.cases.filter(({ pair }) => pair !== null);
    const controls = corpus.cases.filter(({ pair }) => pair === null);
    const pairs = new Map<string, typeof paired>();

    for (const entry of paired) {
      const members = pairs.get(entry.pair?.pairId ?? "") ?? [];
      pairs.set(entry.pair?.pairId ?? "", [...members, entry]);
    }

    assert.equal(corpus.corpusVersion, "corpus_v1");
    assert.equal(corpus.splitVersion, "split_v1");
    assert.equal(corpus.cases.length, 30);
    assert.equal(pairs.size, 12);
    assert.equal(controls.length, 6);
    assert.equal(
      [...pairs.values()].filter(([member]) => member?.split === "DEVELOPMENT").length,
      8,
    );
    assert.equal([...pairs.values()].filter(([member]) => member?.split === "HOLDOUT").length, 4);
    for (const members of pairs.values()) {
      assert.equal(members.length, 2);
      assert.deepEqual(
        new Set(members.map(({ pair }) => pair?.role)),
        new Set(["DEFECT", "CLEAN"]),
      );
      assert.equal(new Set(members.map(({ familyId }) => familyId)).size, 1);
      assert.equal(new Set(members.map(({ split }) => split)).size, 1);
    }

    const splitsByFamily = new Map<string, Set<string>>();
    for (const entry of corpus.cases) {
      const splits = splitsByFamily.get(entry.familyId) ?? new Set<string>();
      splits.add(entry.split);
      splitsByFamily.set(entry.familyId, splits);
    }
    assert.ok([...splitsByFamily.values()].every((splits) => splits.size === 1));
  });

  it("retains provenance, license, runtime, roots, uncertainties, and private oracle artifacts", () => {
    const corpus = validateEvaluationCorpusDefinitionV1(EVALUATION_CORPUS_V1);

    for (const entry of corpus.cases) {
      assert.match(entry.caseId, /^case_\d{3}$/);
      assert.match(entry.familyId, /^family_/);
      assert.ok(entry.provenance.source.length > 0);
      assert.ok(entry.provenance.license.length > 0);
      assert.ok(entry.runtime.identity.length > 0);
      assert.ok(entry.obligations.length > 0);
      assert.ok(entry.evaluatorOnly.hiddenTest.content.length > 0);
      assert.doesNotMatch(entry.evaluatorOnly.hiddenTest.reference, /bug|defect|clean/i);
      if (entry.pair?.role === "DEFECT") {
        assert.ok(entry.expectedRoots.length > 0);
      }
      if (entry.expectedRoots.length > 0)
        assert.ok(entry.evaluatorOnly.fixingPatch?.content.length);
      if (entry.pair?.role === "CLEAN") {
        assert.equal(entry.expectedRoots.length, 0);
      }
    }

    assert.ok(
      corpus.cases.filter(({ expectedUncertainties }) => expectedUncertainties.length > 0).length >=
        2,
    );
    assert.ok(corpus.cases.some(({ labelsExhaustive }) => !labelsExhaustive));
  });
});
