import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

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

const exec = promisify(execFile);

describe("evaluation corpus reconstruction", () => {
  it("reconstructs one case with stable source and manifest identities", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "evaluation-corpus-"));
    try {
      const testCase = EVALUATION_CASES_V1.find(({ id }) => id === "case_018");
      const definition = EVALUATION_CORPUS_V1.cases.find(({ caseId }) => caseId === "case_018");
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
      assert.equal(first.manifest.source.repository, "synthetic://case_018");
      assert.match(first.manifest.source.baseCommit, /^[0-9a-f]{40}$/);
      assert.ok(
        first.manifest.reviewerInputInventory.every(
          ({ reference }) => !reference.startsWith("oracles/"),
        ),
      );
      assert.doesNotMatch(first.oracleDirectory, new RegExp(`${testCase.id}/repo`));
      assert.match(await readFile(first.manifestPath, "utf8"), /"schemaVersion": 1/);
      await assert.doesNotReject(() =>
        exec("git", [
          "-C",
          first.prepared.repositoryPath,
          "apply",
          "--check",
          join(first.oracleDirectory, "correction.patch"),
        ]),
      );
      await assert.rejects(
        () =>
          reconstructEvaluationCorpusCaseV1(
            testCase,
            { ...definition, familyId: "family_wrong" },
            join(temporaryRoot, "mismatched"),
          ),
        /definition does not match/i,
      );
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
      for (const reconstructedCase of reconstructed.cases) {
        const control = await readFile(reconstructedCase.prepared.controlPath, "utf8");
        assert.doesNotMatch(control, /oracles\/v1/);
        for (const root of reconstructedCase.manifest.oracleInventory.expectedRoots) {
          assert.ok(!control.includes(root.rootId));
        }
        for (const uncertainty of reconstructedCase.manifest.oracleInventory
          .expectedUncertainties) {
          assert.ok(!control.includes(uncertainty.uncertaintyId));
          assert.ok(!control.includes(uncertainty.sourceOracleId));
        }
        for (const recommendation of reconstructedCase.manifest.oracleInventory
          .expectedRecommendations) {
          assert.ok(!control.includes(recommendation.recommendationId));
          assert.ok(!control.includes(recommendation.sourceOracleId));
        }
        if (reconstructedCase.manifest.oracleInventory.expectedRoots.length > 0) {
          await assert.doesNotReject(() =>
            exec("git", [
              "-C",
              reconstructedCase.prepared.repositoryPath,
              "apply",
              "--check",
              join(reconstructedCase.oracleDirectory, "correction.patch"),
            ]),
          );
        }
      }
      const advisory = reconstructed.cases.find(({ manifest }) => manifest.caseId === "case_010");
      assert.equal(
        advisory?.manifest.oracleInventory.expectedRecommendations[0]?.sourceOracleId,
        "root_010_advisory_export_name",
      );
      const historical = reconstructed.cases.filter(({ manifest }) =>
        manifest.source.provenance.includes('"kind": "REPOSITORY_REVERSE_FIX"'),
      );
      assert.equal(historical.length, 6);
      assert.ok(
        historical.every(({ manifest }) =>
          manifest.source.provenance.includes('"licenseStatus": "NO_LICENSE_FILE"'),
        ),
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
