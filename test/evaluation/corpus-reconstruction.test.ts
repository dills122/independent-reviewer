import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  digestEvaluationArtifactV1,
  EvaluationCaseManifestV1Schema,
  EvaluationFamilySplitManifestV1Schema,
} from "../../evaluation/artifact-contracts.js";
import { EVALUATION_CORPUS_V1 } from "../../evaluation/corpus.js";
import {
  reconstructEvaluationCorpusCaseV1,
  reconstructEvaluationCorpusV1,
} from "../../evaluation/corpus-reconstruction.js";
import { EVALUATION_CASES_V1 } from "../../evaluation/matrix-selection.js";

describe("evaluation corpus reconstruction", () => {
  it("reconstructs one case with stable source and manifest identities", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "evaluation-corpus-"));
    try {
      const testCase = EVALUATION_CASES_V1.find(({ id }) => id === "case_017");
      const definition = EVALUATION_CORPUS_V1.cases.find(({ caseId }) => caseId === "case_017");
      assert.ok(testCase);
      assert.ok(definition);

      const first = await reconstructEvaluationCorpusCaseV1(
        testCase,
        definition,
        join(temporaryRoot, "first"),
      );
      const second = await reconstructEvaluationCorpusCaseV1(
        testCase,
        definition,
        join(temporaryRoot, "second"),
      );

      assert.deepEqual(first.manifest, second.manifest);
      assert.equal(
        digestEvaluationArtifactV1(EvaluationCaseManifestV1Schema, first.manifest).value,
        digestEvaluationArtifactV1(EvaluationCaseManifestV1Schema, second.manifest).value,
      );
      assert.equal(first.manifest.source.repository, "synthetic://case_017");
      assert.match(first.manifest.source.baseCommit, /^[0-9a-f]{40}$/);
      assert.ok(
        first.manifest.reviewerInputInventory.every(
          ({ reference }) => !reference.startsWith("oracles/"),
        ),
      );
      assert.doesNotMatch(first.oracleDirectory, new RegExp(`${testCase.id}/repo`));
      assert.match(await readFile(first.manifestPath, "utf8"), /"schemaVersion": 1/);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("reconstructs all cases and writes one complete family split manifest", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "evaluation-corpus-"));
    const outputRoot = join(temporaryRoot, "corpus");
    try {
      const reconstructed = await reconstructEvaluationCorpusV1(outputRoot);

      assert.equal(reconstructed.cases.length, 30);
      assert.equal(reconstructed.split.assignments.length, 30);
      assert.doesNotThrow(() => EvaluationFamilySplitManifestV1Schema.parse(reconstructed.split));
      assert.match(await readFile(reconstructed.splitPath, "utf8"), /"splitVersion": "split_v1"/);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
