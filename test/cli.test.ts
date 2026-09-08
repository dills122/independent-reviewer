import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { it } from "node:test";

import { runCliV1 } from "../src/cli.js";

const execFileAsync = promisify(execFile);

async function git(repositoryPath: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", repositoryPath, ...args], { encoding: "utf8" });
}

it("prepares and inspects a snapshot packet without a provider call", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "independent-reviewer-cli-"));
  try {
    await git(repositoryPath, "init", "--initial-branch=main");
    await git(repositoryPath, "config", "user.name", "CLI Test");
    await git(repositoryPath, "config", "user.email", "cli@example.invalid");
    await git(repositoryPath, "config", "commit.gpgsign", "false");
    await writeFile(join(repositoryPath, "reviewed.txt"), "before\n");
    await git(repositoryPath, "add", ".");
    await git(repositoryPath, "commit", "-m", "initial");
    await git(repositoryPath, "switch", "-c", "feature/cli");
    await writeFile(join(repositoryPath, "reviewed.txt"), "after\n");

    const requestPath = join(repositoryPath, "request.json");
    const packetPath = join(repositoryPath, ".review-runs", "cli-test");
    await writeFile(
      requestPath,
      JSON.stringify({
        schemaVersion: 1,
        flowId: "flow_cli_test",
        reviewInstance: { number: 1, maximum: 3 },
        repository: { path: repositoryPath, base: "main" },
        canonicalInputs: {
          requirements: [
            {
              id: "input_requirement",
              kind: "REQUIREMENTS",
              title: "Requirement",
              content: "Review the change.",
              provenance: { type: "INLINE", label: "CLI test" },
            },
          ],
          implementationPlan: {
            id: "input_plan",
            kind: "IMPLEMENTATION_PLAN",
            title: "Plan",
            content: "Prepare the packet.",
            provenance: { type: "INLINE", label: "CLI test" },
          },
        },
        reviewConfigRef: "config_test",
      }),
    );
    const output: string[] = [];
    const errors: string[] = [];
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => errors.push(message),
    };

    assert.equal(
      await runCliV1(["prepare", "--request", requestPath, "--output", packetPath], io),
      0,
    );
    assert.equal(await runCliV1(["inspect", "--packet", packetPath], io), 0);
    assert.equal(errors.length, 0);
    assert.match(output.join("\n"), /Prepared snapshot packet/);
    assert.match(output.join("\n"), /MODIFIED reviewed\.txt/);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});
