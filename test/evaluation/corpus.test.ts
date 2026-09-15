import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyEvaluationCaseOracleV1,
  EVALUATION_CORPUS_V1,
  validateEvaluationCorpusDefinitionV1,
} from "../../evaluation/corpus.js";
import { EVALUATION_CASES_V1 } from "../../evaluation/matrix-selection.js";

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
    assert.deepEqual(
      Object.fromEntries(controls.map((entry) => [entry.caseId, entry.controlRole])),
      {
        case_005: "MISLEADING_AUTHOR_CONCERN",
        case_009: "UNSUPPORTED_AUTHOR_DEFENSE",
        case_011: "CONFLICTING_APPLICABLE_STANDARDS",
        case_012: "MISSING_REQUIRED_CONTEXT",
        case_028: "IRRELEVANT_MISSING_CONTEXT",
        case_029: "POST_AUTHOR_CLAIM_CHANGE",
      },
    );
    const catalogById = new Map(EVALUATION_CASES_V1.map((entry) => [entry.id, entry]));
    assert.match(JSON.stringify(catalogById.get("case_005")?.reviewer), /worry.*off-by-one/i);
    assert.match(JSON.stringify(catalogById.get("case_009")?.reviewer), /disregard naming/i);
    assert.match(
      JSON.stringify(catalogById.get("case_011")?.reviewer),
      /exact single-letter name v/i,
    );
    assert.match(JSON.stringify(catalogById.get("case_012")?.reviewer), /required.*API_NAMES\.md/i);
    assert.match(JSON.stringify(catalogById.get("case_028")?.reviewer), /unavailable.*unrelated/i);
    assert.match(
      JSON.stringify(catalogById.get("case_029")?.reviewer),
      /intended requirement is now one hour/i,
    );
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
      if (entry.expectedRoots.length > 0) {
        assert.match(entry.evaluatorOnly.fixingPatch?.content ?? "", /^--- a\//m);
        assert.match(entry.evaluatorOnly.fixingPatch?.content ?? "", /^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
      }
      if (entry.pair?.role === "CLEAN") {
        assert.equal(entry.expectedRoots.length, 0);
      }
    }

    assert.ok(
      corpus.cases.filter(({ expectedUncertainties }) => expectedUncertainties.length > 0).length >=
        2,
    );
    assert.ok(corpus.cases.every(({ labelsExhaustive }) => labelsExhaustive));
  });

  it("classifies every catalog oracle without treating advice or uncertainty as a root", () => {
    const corpus = validateEvaluationCorpusDefinitionV1(EVALUATION_CORPUS_V1);
    const byId = new Map(corpus.cases.map((entry) => [entry.caseId, entry]));

    assert.deepEqual(byId.get("case_010")?.expectedRecommendations, [
      {
        recommendationId: "recommendation_010_advisory_export_name",
        sourceOracleId: "root_010_advisory_export_name",
        obligationId: "obligation_case_010",
        description: "A descriptive full-word export remains useful non-blocking advice.",
      },
    ]);
    assert.equal(byId.get("case_011")?.expectedRoots.length, 0);
    assert.equal(
      byId.get("case_011")?.expectedUncertainties[0]?.sourceOracleId,
      "root_011_conflicting_mandatory_rules",
    );
    assert.equal(byId.get("case_012")?.expectedRoots.length, 0);
    assert.equal(
      byId.get("case_012")?.expectedUncertainties[0]?.sourceOracleId,
      "root_012_required_reference_absent",
    );

    const catalogCase = EVALUATION_CASES_V1[0];
    assert.ok(catalogCase);
    assert.throws(
      () =>
        classifyEvaluationCaseOracleV1(
          {
            ...catalogCase,
            oracle: { ...catalogCase.oracle, expectedRootIds: ["root_unknown"] },
          },
          "obligation_unknown",
        ),
      /unknown catalog oracle ID root_unknown/i,
    );
  });

  it("records three repository-history reverse fixes with exact provenance", () => {
    const corpus = validateEvaluationCorpusDefinitionV1(EVALUATION_CORPUS_V1);
    const historical = corpus.cases.filter(
      ({ provenance }) => provenance.kind === "REPOSITORY_REVERSE_FIX",
    );
    const defectSources = historical.filter(({ pair }) => pair?.role === "DEFECT");

    assert.equal(defectSources.length, 3);
    assert.equal(new Set(defectSources.map(({ provenance }) => provenance.sourcePath)).size, 3);
    for (const entry of historical) {
      assert.equal(entry.provenance.sourceRevision, "597e2ba758a232f109f85dc01c47e21f9d30ed2a");
      assert.equal(entry.provenance.licenseStatus, "NO_LICENSE_FILE");
      assert.match(entry.provenance.sourceBlobGitObject, /^[0-9a-f]{40}$/);
      assert.ok(entry.provenance.issueReferences.length > 0);
      assert.ok(entry.provenance.fixReferences.length > 0);
      assert.ok(entry.provenance.environmentRequirements.length > 0);
    }
  });

  it("keeps BASE inventory and reviewer obligations fixed within every pair", () => {
    const corpus = validateEvaluationCorpusDefinitionV1(EVALUATION_CORPUS_V1);
    const catalogById = new Map<string, (typeof EVALUATION_CASES_V1)[number]>(
      EVALUATION_CASES_V1.map((entry) => [entry.id, entry]),
    );
    const pairIds = new Set(
      corpus.cases.flatMap(({ pair }) => (pair === null ? [] : [pair.pairId])),
    );

    for (const pairId of pairIds) {
      const definitions = corpus.cases.filter(({ pair }) => pair?.pairId === pairId);
      const cases = definitions.map(({ caseId }) => catalogById.get(caseId));
      assert.equal(cases.length, 2);
      const [first, second] = cases;
      assert.ok(first);
      assert.ok(second);
      assert.deepEqual(
        first.repository.files.map(({ path, base }) => ({ path, base })),
        second.repository.files.map(({ path, base }) => ({ path, base })),
      );
      assert.equal(first.reviewer.kind, second.reviewer.kind);
      assert.deepEqual(first.reviewer, second.reviewer);
      if (first.reviewer.kind === "requirements" && second.reviewer.kind === "requirements") {
        assert.equal(first.reviewer.requirements, second.reviewer.requirements);
      }
      if (first.reviewer.kind === "standards" && second.reviewer.kind === "standards") {
        assert.deepEqual(first.reviewer.profile, second.reviewer.profile);
      }
    }
  });
});
