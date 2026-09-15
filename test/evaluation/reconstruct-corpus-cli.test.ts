import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);

describe("reconstruct corpus command", () => {
  it("writes the complete evaluator corpus to an explicit new directory", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "evaluation-corpus-cli-"));
    const outputRoot = join(temporaryRoot, "corpus");
    try {
      const { stdout } = await exec(process.execPath, [
        resolve("dist/evaluation/reconstruct-corpus.js"),
        "--output",
        outputRoot,
      ]);

      assert.match(stdout, /Reconstructed 30 cases: 24 paired cases and 6 controls\./);
      const split = JSON.parse(
        await readFile(join(outputRoot, "evaluator", "family-split-manifest.json"), "utf8"),
      );
      assert.equal(split.assignments.length, 30);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("requires exactly one explicit output directory", async () => {
    await assert.rejects(
      () => exec(process.execPath, [resolve("dist/evaluation/reconstruct-corpus.js")]),
      /--output <directory>/i,
    );
  });
});
