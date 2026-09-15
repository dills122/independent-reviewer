import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
});
