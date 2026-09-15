import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { promisify } from "node:util";

import {
  readLocalSimpleReviewSettingsV2,
  saveLocalSimpleReviewSettingsV2,
} from "../../src/cli/simple-settings.js";
import { localReviewDirectory } from "../../src/cli/standards-input.js";

const execFileAsync = promisify(execFile);

it("translates strict historical simple settings in memory and writes only v2", async () => {
  const repository = await mkdtemp(join(tmpdir(), "independent-reviewer-settings-migration-"));
  try {
    await execFileAsync("git", ["-C", repository, "init", "--initial-branch=main"]);
    const directory = await localReviewDirectory(repository);
    const path = join(directory, "simple-settings.json");
    await mkdir(directory, { recursive: true });
    const historical = {
      schemaVersion: 1,
      model: "openai/gpt-oss-120b",
      maxCostUsd: 0.05,
      requireAuthorExplanation: false,
      discoverRepositorySteering: false,
    };
    await writeFile(path, `${JSON.stringify(historical)}\n`);

    assert.deepEqual(await readLocalSimpleReviewSettingsV2(repository), {
      schemaVersion: 2,
      model: "openai/gpt-oss-120b",
      maxCostUsd: 0.05,
      requireAuthorExplanation: false,
      useReviewerRules: false,
    });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), historical);

    await unlink(path);
    await saveLocalSimpleReviewSettingsV2(repository, {
      schemaVersion: 2,
      model: "openai/gpt-oss-120b",
      maxCostUsd: 0.05,
      requireAuthorExplanation: true,
      useReviewerRules: true,
    });
    assert.equal(JSON.parse(await readFile(path, "utf8")).schemaVersion, 2);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
