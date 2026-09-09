import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { it } from "node:test";

import {
  ProviderCallError,
  type ReviewProviderRequestV1,
  type ReviewProviderResponseV1,
  type ReviewProviderV1,
} from "../src/index.js";
import type { OpenRouterProviderRoutingV1 } from "../src/index.js";
import { reviewOutcomeExitCodeV1, runCliV1 } from "../src/cli.js";

const execFileAsync = promisify(execFile);
const mockDigest = { algorithm: "SHA256" as const, value: "a".repeat(64) };

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
    await writeFile(join(repositoryPath, ".gitignore"), ".review-runs/\n");
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
    await writeFile(join(repositoryPath, ".gitignore"), ".review-runs/\n");
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
        schemaVersion: 2,
        configId: "config_cli_review",
        model: "mock/reviewer",
        providerRouting: {
          order: ["provider-a/fp4", "provider-b/bf16"],
          maxPrice: { prompt: 0.03, completion: 0.14, request: 0 },
        },
        budgets: {
          maxInitialEvidenceBytes: 32_000,
          maxConversationBytes: 128_000,
          maxOutputTokensPerCall: 1_000,
          maxTotalTokens: 100_000,
          maxTotalCostUsd: 1,
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
      auditRequest: (providerRequest) => ({
        providerPolicyVersion: "mock-provider-v1",
        wireBodyDigest: mockDigest,
        wireBodyBytes: Buffer.byteLength(JSON.stringify(providerRequest), "utf8"),
        credentialFreeWireRequestDigest: mockDigest,
      }),
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
            canonicalInputCoverage: [
              {
                canonicalInputId: "input_requirement",
                status: "ASSESSED",
                explanation: "The requirement was assessed.",
              },
              {
                canonicalInputId: "input_plan",
                status: "ASSESSED",
                explanation: "The plan was assessed.",
              },
            ],
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
          preliminaryConcernDispositions: [],
          authorClaims: [],
          authorVerificationClaims: [],
          changedPathCoverage: [
            {
              path: "reviewed.txt",
              status: "INSPECTED",
              explanation: "The complete changed file was inspected.",
            },
          ],
          canonicalInputCoverage: [
            {
              canonicalInputId: "input_requirement",
              status: "ASSESSED",
              explanation: "The requirement is satisfied.",
            },
            {
              canonicalInputId: "input_plan",
              status: "ASSESSED",
              explanation: "The plan is implemented.",
            },
          ],
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
        createProvider: (apiKey, routing) => {
          assert.equal(apiKey, "test-api-key");
          assert.deepEqual(routing, {
            order: ["provider-a/fp4", "provider-b/bf16"],
            maxPrice: { prompt: 0.03, completion: 0.14, request: 0 },
          });
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
    assert.match(
      await readFile(join(packetPath, "review", "run-record.jsonl"), "utf8"),
      /RUN_COMPLETED/,
    );
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

it("resumes a definite failed final stage without preparing or buying another preliminary", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "independent-reviewer-cli-resume-"));
  try {
    await git(repositoryPath, "init", "--initial-branch=main");
    await git(repositoryPath, "config", "user.name", "CLI Resume Test");
    await git(repositoryPath, "config", "user.email", "cli-resume@example.invalid");
    await git(repositoryPath, "config", "commit.gpgsign", "false");
    await writeFile(join(repositoryPath, "reviewed.txt"), "before\n");
    await writeFile(join(repositoryPath, ".gitignore"), ".review-runs/\n");
    await git(repositoryPath, "add", ".");
    await git(repositoryPath, "commit", "-m", "initial");
    await git(repositoryPath, "switch", "-c", "feature/cli-resume");
    await writeFile(join(repositoryPath, "reviewed.txt"), "after\n");

    const requestPath = join(repositoryPath, "request.json");
    const configPath = join(repositoryPath, "config.json");
    const packetPath = join(repositoryPath, ".review-runs", "cli-resume");
    const providerRouting: OpenRouterProviderRoutingV1 = {
      order: ["provider-a/fp4", "provider-b/bf16"],
      maxPrice: { prompt: 0.03, completion: 0.14, request: 0 },
    };
    await writeFile(
      requestPath,
      JSON.stringify({
        schemaVersion: 1,
        flowId: "flow_cli_resume",
        reviewInstance: { number: 1, maximum: 3 },
        repository: { path: repositoryPath, base: "main" },
        canonicalInputs: {
          requirements: [
            {
              id: "input_requirement",
              kind: "REQUIREMENTS",
              title: "Requirement",
              content: "Review the changed file.",
              provenance: { type: "INLINE", label: "CLI resume test" },
            },
          ],
          implementationPlan: {
            id: "input_plan",
            kind: "IMPLEMENTATION_PLAN",
            title: "Plan",
            content: "Change one line.",
            provenance: { type: "INLINE", label: "CLI resume test" },
          },
        },
        authorPacket: {
          schemaVersion: 1,
          intent: "AUTHOR_RESUME_CONTEXT: change the file.",
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
        reviewConfigRef: "config_cli_resume",
      }),
    );
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 2,
        configId: "config_cli_resume",
        model: "mock/reviewer",
        providerRouting,
        budgets: {
          maxInitialEvidenceBytes: 32_000,
          maxConversationBytes: 128_000,
          maxOutputTokensPerCall: 1_000,
          maxTotalTokens: 100_000,
          maxTotalCostUsd: 1,
          timeoutMs: 10_000,
        },
      }),
    );

    const makeResponse = (value: unknown): ReviewProviderResponseV1 => ({
      value,
      rawContent: JSON.stringify(value),
      responseId: "mock-response",
      model: "mock/reviewer",
      provider: "mock",
      usage: { promptTokens: 90, completionTokens: 10, totalTokens: 100, cost: 0 },
    });
    const preliminaryValue = (providerRequest: ReviewProviderRequestV1) => {
      const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
      return {
        schemaVersion: 1,
        stage: "PRELIMINARY",
        snapshotDigest: brief.snapshotManifest.snapshotDigest,
        briefDigest: brief.briefDigest,
        summary: "The file was inspected.",
        inspectedPaths: ["reviewed.txt"],
        canonicalInputCoverage: [
          {
            canonicalInputId: "input_requirement",
            status: "ASSESSED",
            explanation: "The requirement was assessed.",
          },
          {
            canonicalInputId: "input_plan",
            status: "ASSESSED",
            explanation: "The plan was assessed.",
          },
        ],
        findings: [],
        evidenceGaps: [],
        limitations: [],
        nextAction: "REQUEST_AUTHOR_PACKET",
      };
    };
    const firstProvider: ReviewProviderV1 = {
      auditRequest: () => ({
        providerPolicyVersion: "mock-provider-v1",
        wireBodyDigest: mockDigest,
        wireBodyBytes: 100,
        credentialFreeWireRequestDigest: mockDigest,
      }),
      complete: async (providerRequest) => {
        if (providerRequest.stage === "PRELIMINARY") {
          return makeResponse(preliminaryValue(providerRequest));
        }
        throw new ProviderCallError("PROVIDER_ERROR", "Rate limited.", {
          diagnostic: {
            httpStatus: 429,
            providerErrorCode: "429",
            providerMessage: "Rate limited",
            errorType: "rate_limit_exceeded",
            providerCode: null,
            providerName: "mock",
            model: "mock/reviewer",
            responseId: null,
            retryAfter: null,
          },
        });
      },
    };
    const firstExit = await runCliV1(
      ["review", "--request", requestPath, "--config", configPath, "--output", packetPath],
      { stdout: () => undefined, stderr: () => undefined },
      { readOpenRouterApiKey: () => "test-api-key", createProvider: () => firstProvider },
    );
    assert.equal(firstExit, 1);

    let resumedCalls = 0;
    const resumedProvider: ReviewProviderV1 = {
      auditRequest: firstProvider.auditRequest,
      complete: async (providerRequest) => {
        resumedCalls += 1;
        assert.equal(providerRequest.stage, "FINAL");
        const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
        return makeResponse({
          schemaVersion: 1,
          stage: "FINAL",
          snapshotDigest: brief.snapshotManifest.snapshotDigest,
          briefDigest: brief.briefDigest,
          summary: "The resumed final review completed.",
          findings: [],
          preliminaryFindingDispositions: [],
          preliminaryConcernDispositions: [],
          authorClaims: [],
          authorVerificationClaims: [],
          changedPathCoverage: [
            { path: "reviewed.txt", status: "INSPECTED", explanation: "The file was inspected." },
          ],
          canonicalInputCoverage: [
            {
              canonicalInputId: "input_requirement",
              status: "ASSESSED",
              explanation: "The requirement was assessed.",
            },
            {
              canonicalInputId: "input_plan",
              status: "ASSESSED",
              explanation: "The plan was assessed.",
            },
          ],
          limitations: [],
          verdict: "READY",
          nextActions: { blockers: [], fastFollows: [] },
        });
      },
    };
    const output: string[] = [];
    const errors: string[] = [];
    const resumedExit = await runCliV1(
      ["resume-final", "--packet", packetPath, "--config", configPath],
      { stdout: (message) => output.push(message), stderr: (message) => errors.push(message) },
      { readOpenRouterApiKey: () => "test-api-key", createProvider: () => resumedProvider },
    );

    assert.equal(resumedExit, 0, errors.join("\n"));
    assert.equal(resumedCalls, 1);
    assert.match(output.join("\n"), /Verdict: Ready/);
    assert.doesNotMatch(output.join("\n"), /AUTHOR_RESUME_CONTEXT/);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

it("never captures a prior packet, and warns when packets are not ignored", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "independent-reviewer-cli-packets-"));
  try {
    await git(repositoryPath, "init", "--initial-branch=main");
    await git(repositoryPath, "config", "user.name", "CLI Packet Test");
    await git(repositoryPath, "config", "user.email", "cli-packet@example.invalid");
    await git(repositoryPath, "config", "commit.gpgsign", "false");
    await writeFile(join(repositoryPath, "reviewed.txt"), "before\n");
    await git(repositoryPath, "add", ".");
    await git(repositoryPath, "commit", "-m", "initial");
    await git(repositoryPath, "switch", "-c", "feature/cli-packets");
    await writeFile(join(repositoryPath, "reviewed.txt"), "after\n");

    const requestPath = join(repositoryPath, "request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        schemaVersion: 1,
        flowId: "flow_cli_packets",
        reviewInstance: { number: 1, maximum: 3 },
        repository: { path: repositoryPath, base: "main" },
        canonicalInputs: {
          requirements: [
            {
              id: "input_requirement",
              kind: "REQUIREMENTS",
              title: "Requirement",
              content: "Review the change.",
              provenance: { type: "INLINE", label: "CLI packet test" },
            },
          ],
          implementationPlan: {
            id: "input_plan",
            kind: "IMPLEMENTATION_PLAN",
            title: "Plan",
            content: "Prepare the packet twice.",
            provenance: { type: "INLINE", label: "CLI packet test" },
          },
        },
        authorPacket: undefined,
        reviewConfigRef: "config_test",
      }),
    );

    const output: string[] = [];
    const errors: string[] = [];
    const io = {
      stdout: (message: string) => output.push(message),
      stderr: (message: string) => errors.push(message),
    };

    const firstPacket = join(repositoryPath, "review-out", "first");
    const secondPacket = join(repositoryPath, "review-out", "second");
    assert.equal(
      await runCliV1(["prepare", "--request", requestPath, "--output", firstPacket], io),
      0,
    );
    assert.equal(
      await runCliV1(["prepare", "--request", requestPath, "--output", secondPacket], io),
      0,
    );

    // review-out/ is inside the worktree and not gitignored: both runs must say so.
    assert.equal(errors.length, 2);
    assert.match(errors[0] ?? "", /not ignored by Git/);

    const manifest = JSON.parse(
      await readFile(join(secondPacket, "snapshot-manifest.json"), "utf8"),
    ) as { paths: { path: string }[]; exclusions: { path: string }[] };
    assert.equal(
      manifest.paths.some((entry) => entry.path.startsWith("review-out/")),
      false,
    );
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

it("applies caller-supplied exclusion patterns from the command line", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "independent-reviewer-cli-exclude-"));
  try {
    await git(repositoryPath, "init", "--initial-branch=main");
    await git(repositoryPath, "config", "user.name", "CLI Exclude Test");
    await git(repositoryPath, "config", "user.email", "cli-exclude@example.invalid");
    await git(repositoryPath, "config", "commit.gpgsign", "false");
    await writeFile(join(repositoryPath, "reviewed.txt"), "before\n");
    await writeFile(join(repositoryPath, ".gitignore"), ".review-runs/\n");
    await git(repositoryPath, "add", ".");
    await git(repositoryPath, "commit", "-m", "initial");
    await git(repositoryPath, "switch", "-c", "feature/cli-exclude");
    await writeFile(join(repositoryPath, "reviewed.txt"), "after\n");
    await writeFile(join(repositoryPath, "notes.md"), "excluded by pattern\n");

    const requestPath = join(repositoryPath, "request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        schemaVersion: 1,
        flowId: "flow_cli_exclude",
        reviewInstance: { number: 1, maximum: 3 },
        repository: { path: repositoryPath, base: "main" },
        canonicalInputs: {
          requirements: [
            {
              id: "input_requirement",
              kind: "REQUIREMENTS",
              title: "Requirement",
              content: "Review the change.",
              provenance: { type: "INLINE", label: "CLI exclude test" },
            },
          ],
          implementationPlan: {
            id: "input_plan",
            kind: "IMPLEMENTATION_PLAN",
            title: "Plan",
            content: "Exclude a pattern.",
            provenance: { type: "INLINE", label: "CLI exclude test" },
          },
        },
        reviewConfigRef: "config_test",
      }),
    );

    const output: string[] = [];
    const io = { stdout: (message: string) => output.push(message), stderr: () => undefined };
    const packetPath = join(repositoryPath, ".review-runs", "excluded");
    assert.equal(
      await runCliV1(
        ["prepare", "--request", requestPath, "--output", packetPath, "--exclude", "*.md"],
        io,
      ),
      0,
    );

    const manifest = JSON.parse(
      await readFile(join(packetPath, "snapshot-manifest.json"), "utf8"),
    ) as { paths: { path: string }[]; exclusions: { path: string; reason: string }[] };
    assert.equal(
      manifest.paths.some((entry) => entry.path === "notes.md"),
      false,
    );
    assert.equal(
      manifest.exclusions.some(
        (entry) => entry.path === "notes.md" && entry.reason === "USER_EXCLUDED",
      ),
      true,
    );
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

it("prints help and version on stdout without a packet or provider", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const io = {
    stdout: (message: string) => output.push(message),
    stderr: (message: string) => errors.push(message),
  };

  assert.equal(await runCliV1([], io), 0);
  assert.equal(await runCliV1(["--help"], io), 0);
  assert.equal(await runCliV1(["review", "--help"], io), 0);
  assert.equal(await runCliV1(["--version"], io), 0);

  assert.equal(errors.length, 0);
  const printed = output.join("\n");
  assert.match(printed, /Usage: independent-reviewer <prepare\|inspect\|review\|resume-final>/);
  assert.match(printed, /--config <value>.*required/);
  assert.match(printed, /OPENROUTER_API_KEY/);
});

it("reports argument mistakes precisely instead of claiming a value is missing", async () => {
  const errors: string[] = [];
  const io = { stdout: () => undefined, stderr: (message: string) => errors.push(message) };

  // A repeated pinned option must be rejected, not silently last-wins.
  assert.equal(
    await runCliV1(
      ["review", "--request", "a.json", "--config", "a.json", "--config", "b.json"],
      io,
    ),
    1,
  );
  assert.match(errors.at(-1) ?? "", /--config was given 2 times/);

  // A dash-leading value is legal; the error says how to pass it rather than "missing value".
  assert.equal(await runCliV1(["prepare", "--request", "--weird.json"], io), 1);
  assert.match(errors.at(-1) ?? "", /--request=/);

  assert.equal(await runCliV1(["prepare"], io), 1);
  assert.match(errors.at(-1) ?? "", /Missing required option --request/);

  assert.equal(await runCliV1(["nonsense"], io), 1);
  assert.match(errors.at(-1) ?? "", /Unknown command nonsense/);
});

it("emits a versioned inspection report that never carries author-packet content", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "independent-reviewer-cli-inspect-"));
  try {
    await git(repositoryPath, "init", "--initial-branch=main");
    await git(repositoryPath, "config", "user.name", "CLI Inspect Test");
    await git(repositoryPath, "config", "user.email", "cli-inspect@example.invalid");
    await git(repositoryPath, "config", "commit.gpgsign", "false");
    await writeFile(join(repositoryPath, "reviewed.txt"), "before\n");
    await writeFile(join(repositoryPath, ".gitignore"), ".review-runs/\n");
    await git(repositoryPath, "add", ".");
    await git(repositoryPath, "commit", "-m", "initial");
    await git(repositoryPath, "switch", "-c", "feature/cli-inspect");
    await writeFile(join(repositoryPath, "reviewed.txt"), "after\n");

    const requestPath = join(repositoryPath, "request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        schemaVersion: 1,
        flowId: "flow_cli_inspect",
        reviewInstance: { number: 1, maximum: 3 },
        repository: { path: repositoryPath, base: "main" },
        canonicalInputs: {
          requirements: [
            {
              id: "input_requirement",
              kind: "REQUIREMENTS",
              title: "Requirement",
              content: "Review the change.",
              provenance: { type: "INLINE", label: "CLI inspect test" },
            },
          ],
          implementationPlan: {
            id: "input_plan",
            kind: "IMPLEMENTATION_PLAN",
            title: "Plan",
            content: "Change one line.",
            provenance: { type: "INLINE", label: "CLI inspect test" },
          },
        },
        authorPacket: {
          schemaVersion: 1,
          intent: "AUTHOR_ONLY_SECRET: change the file.",
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
        reviewConfigRef: "config_cli_inspect",
      }),
    );

    const output: string[] = [];
    const io = { stdout: (message: string) => output.push(message), stderr: () => undefined };
    const packetPath = join(repositoryPath, ".review-runs", "inspect-test");
    assert.equal(
      await runCliV1(["prepare", "--request", requestPath, "--output", packetPath], io),
      0,
    );

    output.length = 0;
    assert.equal(await runCliV1(["inspect", "--packet", packetPath, "--json"], io), 0);
    const report = JSON.parse(output.join("\n")) as Record<string, unknown>;

    assert.deepEqual(Object.keys(report).sort(), [
      "authorPacketPresent",
      "blobCount",
      "canonicalInputs",
      "reviewConfigRef",
      "schemaVersion",
      "snapshotManifest",
    ]);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.authorPacketPresent, true);
    assert.equal(report.reviewConfigRef, "config_cli_inspect");
    // Presence is reported; content never is.
    assert.doesNotMatch(JSON.stringify(report), /AUTHOR_ONLY_SECRET/);

    output.length = 0;
    assert.equal(await runCliV1(["inspect", "--packet", packetPath], io), 0);
    const text = output.join("\n");
    assert.match(text, /Author packet: stored separately/);
    assert.doesNotMatch(text, /AUTHOR_ONLY_SECRET/);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});
