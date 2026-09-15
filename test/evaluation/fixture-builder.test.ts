import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import {
  prepareEvaluationCaseV1,
  prepareEvaluationCorpusCaseV1,
} from "../../evaluation/fixture-builder.js";
import { EVALUATION_CASES_V1 } from "../../evaluation/matrix-selection.js";
import type { EvaluationCaseV1 } from "../../evaluation/matrix-types.js";
import { jsonDocument, sha256BytesDigestV1 } from "../../src/contracts/json-document.js";
import { ReviewRequestV1Schema } from "../../src/contracts/review-request.js";

const exec = promisify(execFile);

describe("evaluation fixture reconstruction", () => {
  it("rebuilds an opaque multilingual case from a clean checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-evaluation-"));
    try {
      const testCase = EVALUATION_CASES_V1.find(({ id }) => id === "case_017");
      assert.ok(testCase);
      const prepared = await prepareEvaluationCaseV1(testCase, join(root, testCase.id));

      const { stdout } = await exec("git", [
        "-C",
        prepared.repositoryPath,
        "diff",
        "--name-only",
        "main",
      ]);
      assert.deepEqual(stdout.trim().split("\n"), ["units.go"]);
      assert.doesNotMatch(prepared.repositoryPath, /bug|defect|clean/i);

      const controlText = await readFile(prepared.controlPath, "utf8");
      for (const rootId of testCase.oracle.expectedRootIds) {
        assert.doesNotMatch(controlText, new RegExp(rootId));
      }
      assert.equal(prepared.cliArguments[0], "--request");
      assert.ok(!prepared.cliArguments.includes("--config"));
      assert.ok(!prepared.cliArguments.includes("--output"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to reuse an existing case directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-evaluation-"));
    try {
      const testCase = EVALUATION_CASES_V1[0];
      assert.ok(testCase);
      const target = join(root, testCase.id);
      await prepareEvaluationCaseV1(testCase, target);
      await assert.rejects(() => prepareEvaluationCaseV1(testCase, target), /already exists/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores developer-global Git hooks while reconstructing a fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-evaluation-"));
    const hookDirectory = join(root, "hooks");
    const globalConfigPath = join(root, "hostile-gitconfig");
    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    try {
      await mkdir(hookDirectory);
      await writeFile(join(hookDirectory, "pre-commit"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
      await writeFile(globalConfigPath, `[core]\n\thooksPath = ${hookDirectory}\n`, "utf8");
      process.env.GIT_CONFIG_GLOBAL = globalConfigPath;

      const testCase = EVALUATION_CASES_V1[0];
      assert.ok(testCase);
      await assert.doesNotReject(() =>
        prepareEvaluationCaseV1(testCase, join(root, "isolated-case")),
      );
    } finally {
      if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("produces the same commit while ignoring every ambient Git authority channel", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-evaluation-"));
    const testCase = EVALUATION_CASES_V1.find(({ id }) => id === "case_017");
    assert.ok(testCase);
    const hostileGitDirectory = join(root, "hostile.git");
    const hostileWorkTree = join(root, "hostile-worktree");
    const hostileHooks = join(root, "hostile-hooks");
    const keys = [
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
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      const baseline = await prepareEvaluationCaseV1(testCase, join(root, "baseline"));
      const baselineCommit = (
        await exec("git", ["-C", baseline.repositoryPath, "rev-parse", "main"])
      ).stdout.trim();

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

      const isolated = await prepareEvaluationCaseV1(testCase, join(root, "isolated"));
      const isolatedCommit = (
        await exec("git", ["-C", isolated.repositoryPath, "rev-parse", "main"], {
          env: Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
          ),
        })
      ).stdout.trim();
      assert.equal(isolatedCommit, baselineCommit);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds the complete generated requirements author packet into reviewer identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-evaluation-"));
    try {
      const canonical = EVALUATION_CASES_V1.find(({ id }) => id === "case_018");
      assert.ok(canonical);
      assert.equal(canonical.reviewer.kind, "requirements");
      const changed = {
        ...canonical,
        reviewer: { ...canonical.reviewer, authorApproach: "Changed catalog prose." },
      } satisfies EvaluationCaseV1;
      const baseline = await prepareEvaluationCorpusCaseV1(canonical, join(root, "baseline"));
      const changedFixture = await prepareEvaluationCorpusCaseV1(changed, join(root, "changed"));
      const baselineAuthor = baseline.reviewerInputArtifacts.find(
        ({ role }) => role === "AUTHOR_PACKET",
      );
      const changedAuthor = changedFixture.reviewerInputArtifacts.find(
        ({ role }) => role === "AUTHOR_PACKET",
      );
      assert.ok(baselineAuthor);
      assert.ok(changedAuthor);
      const request = ReviewRequestV1Schema.parse(
        JSON.parse(await readFile(baseline.controlPath, "utf8")),
      );
      assert.ok(request.authorPacket);
      assert.equal(baselineAuthor.content, jsonDocument(request.authorPacket));
      assert.match(baselineAuthor.content, /Updated implementation for the declared plan/);
      assert.notEqual(
        sha256BytesDigestV1(Buffer.from(baselineAuthor.content, "utf8")).value,
        sha256BytesDigestV1(Buffer.from(changedAuthor.content, "utf8")).value,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
