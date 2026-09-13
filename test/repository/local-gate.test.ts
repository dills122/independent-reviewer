import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();

async function packageScripts(): Promise<Record<string, string>> {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  return manifest.scripts;
}

/**
 * Every command a required CI job runs.
 *
 * Read out of the workflow rather than restated here, because a list maintained by hand is the
 * thing that drifted: `npm run check` was documented as the full gate while running four of the
 * seven required jobs, so a contributor could pass locally and fail on e2e, the dependency audit,
 * or the committed-context check (#138).
 *
 * Script names contain digits (`test:e2e:dry-run`), so the pattern must admit them -- omitting
 * them silently skips the very command this guard exists to pin.
 */
async function requiredCiCommands(): Promise<string[]> {
  const workflow = await readFile(join(root, ".github", "workflows", "ci.yml"), "utf8");
  const commands = new Set<string>();
  for (const line of workflow.split("\n")) {
    const run = /^\s*run:\s+(npm run [a-z0-9:-]+|python3 -B \S+ --ci)\s*$/.exec(line);
    if (run?.[1]) commands.add(run[1]);
  }
  return [...commands].sort();
}

/** Expands `npm run x` one level, so `check` can satisfy CI by composing the same scripts. */
async function commandsCoveredByCheck(): Promise<Set<string>> {
  const scripts = await packageScripts();
  const covered = new Set<string>();
  const visit = (body: string): void => {
    for (const part of body.split("&&").map((piece) => piece.trim())) {
      covered.add(part);
      const name = /^npm run ([a-z0-9:-]+)$/.exec(part)?.[1];
      const nested = name === undefined ? undefined : scripts[name];
      if (nested !== undefined && name !== "check") visit(nested);
    }
  };
  visit(scripts.check ?? "");
  return covered;
}

describe("the documented local gate", () => {
  it("runs every command a required CI job runs", async () => {
    const covered = await commandsCoveredByCheck();
    const missing = (await requiredCiCommands()).filter((command) => !covered.has(command));

    assert.deepEqual(missing, []);
  });

  it("enforces the assist actions biome.json configures", async () => {
    // `biome lint` runs lint rules only. The configured organizeImports assist needs
    // `biome check`, so with the old script the repository could and did drift: 27 files
    // violated it while `npm run check` passed (#96).
    const scripts = await packageScripts();
    const config = JSON.parse(await readFile(join(root, "biome.json"), "utf8")) as {
      assist?: { enabled?: boolean };
    };

    if (config.assist?.enabled !== true) return;
    assert.match(
      scripts.lint ?? "",
      /biome check/,
      "biome lint does not run assist actions; the gate must use biome check",
    );
  });

  it("keeps the contributor instructions pointing at that gate", async () => {
    for (const path of ["CONTRIBUTING.md", "AGENTS.md"]) {
      assert.match(await readFile(join(root, path), "utf8"), /npm run check/, path);
    }
  });
});
