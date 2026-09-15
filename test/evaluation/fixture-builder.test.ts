import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { prepareEvaluationCaseV1 } from "../../evaluation/fixture-builder.js";
import { EVALUATION_CASES_V1 } from "../../evaluation/matrix-selection.js";

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
});
