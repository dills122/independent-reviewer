import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import type { EvaluationCaseV1 } from "../../evaluation/matrix-types.js";

const exec = promisify(execFile);

const HOSTILE_GIT_KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_CONFIG_KEY_1",
  "GIT_CONFIG_VALUE_1",
] as const;

async function withHostileGitEnvironment<T>(root: string, callback: () => Promise<T>): Promise<T> {
  const hostileGitDirectory = join(root, "hostile.git");
  const hostileWorkTree = join(root, "hostile-worktree");
  const hostileHooks = join(root, "hostile-hooks");
  const previous = new Map(HOSTILE_GIT_KEYS.map((key) => [key, process.env[key]]));
  await mkdir(hostileGitDirectory);
  await mkdir(hostileWorkTree);
  await mkdir(hostileHooks);
  await writeFile(join(hostileHooks, "pre-commit"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: "Ambient Author",
    GIT_AUTHOR_EMAIL: "ambient-author@example.invalid",
    GIT_COMMITTER_NAME: "Ambient Committer",
    GIT_COMMITTER_EMAIL: "ambient-committer@example.invalid",
    GIT_DIR: hostileGitDirectory,
    GIT_WORK_TREE: hostileWorkTree,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hostileHooks,
    GIT_CONFIG_KEY_1: "commit.gpgsign",
    GIT_CONFIG_VALUE_1: "true",
  });
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function assertCaseMutationRejectedBeforeFileSystemWork(
  testCase: EvaluationCaseV1,
  caseRoot: string,
): Promise<void> {
  const definition = EVALUATION_CORPUS_V1.cases.find(({ caseId }) => caseId === testCase.id);
  assert.ok(definition);
  await assert.rejects(
    () => reconstructEvaluationCorpusCaseV1(testCase, definition, caseRoot),
    /catalog case/i,
  );
  await assert.rejects(() => stat(caseRoot), { code: "ENOENT" });
}

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

  it("isolates every Git operation in single-case reconstruction from ambient authority", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "evaluation-corpus-"));
    try {
      const testCase = EVALUATION_CASES_V1.find(({ id }) => id === "case_018");
      const definition = EVALUATION_CORPUS_V1.cases.find(({ caseId }) => caseId === "case_018");
      assert.ok(testCase);
      assert.ok(definition);

      await withHostileGitEnvironment(temporaryRoot, async () => {
        const reconstructed = await reconstructEvaluationCorpusCaseV1(
          testCase,
          definition,
          join(temporaryRoot, "single"),
        );
        assert.match(reconstructed.manifest.source.baseCommit, /^[0-9a-f]{40}$/);
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("isolates every Git operation in full-corpus reconstruction from ambient authority", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "evaluation-corpus-"));
    try {
      await withHostileGitEnvironment(temporaryRoot, async () => {
        const reconstructed = await reconstructEvaluationCorpusV1(join(temporaryRoot, "full"));
        assert.equal(reconstructed.cases.length, 30);
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects mutated clean HEAD content before creating a case directory", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "evaluation-corpus-"));
    try {
      const canonical = EVALUATION_CASES_V1.find(({ id }) => id === "case_001");
      assert.ok(canonical);
      const mutated = {
        ...canonical,
        repository: {
          files: canonical.repository.files.map((file, index) =>
            index === 0 ? { ...file, head: `${file.head ?? ""}\n// mutated clean HEAD\n` } : file,
          ),
        },
      } satisfies EvaluationCaseV1;
      await assertCaseMutationRejectedBeforeFileSystemWork(mutated, join(temporaryRoot, "clean"));
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects mutated reviewer content before creating a case directory", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "evaluation-corpus-"));
    try {
      const canonical = EVALUATION_CASES_V1.find(({ id }) => id === "case_018");
      assert.ok(canonical);
      assert.equal(canonical.reviewer.kind, "requirements");
      const mutated = {
        ...canonical,
        reviewer: { ...canonical.reviewer, authorApproach: "Uncatalogued author narrative." },
      } satisfies EvaluationCaseV1;
      await assertCaseMutationRejectedBeforeFileSystemWork(
        mutated,
        join(temporaryRoot, "reviewer"),
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects mutated oracle content before creating a case directory", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "evaluation-corpus-"));
    try {
      const canonical = EVALUATION_CASES_V1.find(({ id }) => id === "case_018");
      assert.ok(canonical);
      const mutated = {
        ...canonical,
        oracle: { ...canonical.oracle, expectedRootIds: ["root_uncatalogued"] },
      } satisfies EvaluationCaseV1;
      await assertCaseMutationRejectedBeforeFileSystemWork(mutated, join(temporaryRoot, "oracle"));
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
