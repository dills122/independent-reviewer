import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { it } from "node:test";

import type {
  ReviewProviderRequestV1,
  ReviewProviderResponseV1,
  ReviewProviderV1,
} from "../src/index.js";
import { reviewOutcomeExitCodeV1, runCliV1 } from "../src/cli.js";

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
    assert.doesNotMatch(output.join("\n"), /UNTRACKED request\.json/);
    assert.match(output.join("\n"), /RUNNER_CONTROL request\.json/);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

it("composes capture and the two-stage provider flow through the review command", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "independent-reviewer-cli-review-"));
  try {
    await git(repositoryPath, "init", "--initial-branch=main");
    await git(repositoryPath, "config", "user.name", "CLI Review Test");
    await git(repositoryPath, "config", "user.email", "cli-review@example.invalid");
    await git(repositoryPath, "config", "commit.gpgsign", "false");
    await writeFile(join(repositoryPath, "reviewed.txt"), "before\n");
    await git(repositoryPath, "add", ".");
    await git(repositoryPath, "commit", "-m", "initial");
    await git(repositoryPath, "switch", "-c", "feature/cli-review");
    await writeFile(join(repositoryPath, "reviewed.txt"), "after\n");

    const requestPath = join(repositoryPath, "request.json");
    const configPath = join(repositoryPath, "config.json");
    const packetPath = join(repositoryPath, ".review-runs", "cli-review");
    await writeFile(
      requestPath,
      JSON.stringify({
        schemaVersion: 1,
        flowId: "flow_cli_review",
        reviewInstance: { number: 1, maximum: 3 },
        repository: { path: repositoryPath, base: "main" },
        canonicalInputs: {
          requirements: [
            {
              id: "input_requirement",
              kind: "REQUIREMENTS",
              title: "Requirement",
              content: "Review the changed file.",
              provenance: { type: "INLINE", label: "CLI review test" },
            },
          ],
          implementationPlan: {
            id: "input_plan",
            kind: "IMPLEMENTATION_PLAN",
            title: "Plan",
            content: "Change one line.",
            provenance: { type: "INLINE", label: "CLI review test" },
          },
          projectGuidance: [],
        },
        authorPacket: {
          schemaVersion: 1,
          intent: "AUTHOR_PRIVATE_CONTEXT: change the file.",
          successCriteria: ["The line changes."],
          planTraceability: [{ planItem: "Change one line.", implementation: "Changed it." }],
          technicalApproach: "Replace the text.",
          componentWalkthrough: [{ component: "reviewed.txt", changes: "Changed one line." }],
          decisions: [],
          invariants: [],
          claimedVerification: [],
          risks: [],
          knownGaps: [],
          challengePoints: [],
        },
        reviewConfigRef: "config_cli_review",
      }),
    );
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        configId: "config_cli_review",
        model: "mock/reviewer",
        budgets: {
          maxInitialEvidenceBytes: 32_000,
          maxConversationBytes: 128_000,
          maxOutputTokensPerCall: 1_000,
          maxTotalTokens: 10_000,
          timeoutMs: 10_000,
        },
      }),
    );

    const calls: ReviewProviderRequestV1[] = [];
    const response = (value: unknown): ReviewProviderResponseV1 => ({
      value,
      rawContent: JSON.stringify(value),
      responseId: "mock-response",
      model: "mock/reviewer",
      provider: "mock",
      usage: { promptTokens: 90, completionTokens: 10, totalTokens: 100, cost: 0 },
    });
    const provider: ReviewProviderV1 = {
      complete: async (providerRequest) => {
        calls.push(providerRequest);
        const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
        if (providerRequest.stage === "PRELIMINARY") {
          assert.doesNotMatch(JSON.stringify(providerRequest), /AUTHOR_PRIVATE_CONTEXT/);
          return response({
            schemaVersion: 1,
            stage: "PRELIMINARY",
            snapshotDigest: brief.snapshotManifest.snapshotDigest,
            briefDigest: brief.briefDigest,
            summary: "The visible change is straightforward.",
            inspectedPaths: ["reviewed.txt"],
            findings: [],
            evidenceGaps: [],
            limitations: [],
            nextAction: "REQUEST_AUTHOR_PACKET",
          });
        }
        return response({
          schemaVersion: 1,
          stage: "FINAL",
          snapshotDigest: brief.snapshotManifest.snapshotDigest,
          briefDigest: brief.briefDigest,
          summary: "The change is ready.",
          findings: [],
          preliminaryFindingDispositions: [],
          authorClaims: [],
          limitations: [],
          verdict: "READY",
          nextActions: { blockers: [], fastFollows: [] },
        });
      },
    };
    const output: string[] = [];
    const errors: string[] = [];
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => errors.push(message),
    };

    const exitCode = await runCliV1(
      ["review", "--request", requestPath, "--config", configPath, "--output", packetPath],
      io,
      {
        readOpenRouterApiKey: () => "test-api-key",
        createProvider: (apiKey) => {
          assert.equal(apiKey, "test-api-key");
          return provider;
        },
      },
    );
    assert.equal(exitCode, 0, errors.join("\n"));
    assert.equal(calls.length, 2);
    assert.equal(errors.length, 0);
    assert.match(output.join("\n"), /Verdict: Ready/);
    assert.match(output.join("\n"), /review\/report\.md/);
    assert.doesNotMatch(output.join("\n"), /test-api-key|AUTHOR_PRIVATE_CONTEXT/);
    assert.match(await readFile(join(packetPath, "review", "report.md"), "utf8"), /Ready/);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

it("maps completed review verdicts to stable CLI exits", () => {
  assert.equal(reviewOutcomeExitCodeV1("READY"), 0);
  assert.equal(reviewOutcomeExitCodeV1("READY_WITH_FOLLOW_UPS"), 0);
  assert.equal(reviewOutcomeExitCodeV1("NOT_READY"), 2);
  assert.equal(reviewOutcomeExitCodeV1("UNABLE_TO_VERIFY"), 3);
});

it("requires the OpenRouter key without accepting it as a command-line option", async () => {
  const output: string[] = [];
  const errors: string[] = [];

  assert.equal(
    await runCliV1(
      ["review", "--request", "request.json", "--config", "config.json"],
      {
        stdout: (message) => output.push(message),
        stderr: (message) => errors.push(message),
      },
      {
        readOpenRouterApiKey: () => undefined,
        createProvider: () => {
          throw new Error("provider must not be created");
        },
      },
    ),
    1,
  );
  assert.equal(output.length, 0);
  assert.match(errors.join("\n"), /OPENROUTER_API_KEY/);
});
