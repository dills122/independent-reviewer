import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import {
  captureGitSnapshotV1,
  runTwoStageReviewV1,
  type ReviewProviderV1,
  type ReviewProviderRequestV1,
  type ReviewProviderResponseV1,
  type ReviewRunConfigV1,
  writeSnapshotPacketV1,
} from "../../src/index.js";

const execFileAsync = promisify(execFile);

async function git(repositoryPath: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", repositoryPath, ...args], { encoding: "utf8" });
}

async function arrangePacket(
  includeExcludedPath = false,
): Promise<{ repositoryPath: string; packetPath: string }> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "independent-reviewer-flow-"));
  await git(repositoryPath, "init", "--initial-branch=main");
  await git(repositoryPath, "config", "user.name", "Flow Test");
  await git(repositoryPath, "config", "user.email", "flow@example.invalid");
  await git(repositoryPath, "config", "commit.gpgsign", "false");
  await writeFile(join(repositoryPath, "reviewed.txt"), "before\n");
  await git(repositoryPath, "add", ".");
  await git(repositoryPath, "commit", "-m", "initial");
  await git(repositoryPath, "switch", "-c", "feature/flow");
  await writeFile(join(repositoryPath, "reviewed.txt"), "after\n");
  if (includeExcludedPath) {
    await writeFile(join(repositoryPath, ".env"), "DO_NOT_SEND=secret\n");
  }

  const request = {
    schemaVersion: 1 as const,
    flowId: "flow_two_stage",
    reviewInstance: { number: 1, maximum: 3 },
    repository: {
      path: repositoryPath,
      base: "main",
      workingTree: { mode: "CUMULATIVE" as const, includeUntracked: true },
    },
    canonicalInputs: {
      requirements: [
        {
          id: "input_requirement",
          kind: "REQUIREMENTS" as const,
          title: "Requirement",
          content: "Review the changed behavior.",
          provenance: { type: "INLINE" as const, label: "flow test" },
        },
      ],
      implementationPlan: {
        id: "input_plan",
        kind: "IMPLEMENTATION_PLAN" as const,
        title: "Plan",
        content: "Change the reviewed file.",
        provenance: { type: "INLINE" as const, label: "flow test" },
      },
      projectGuidance: [],
    },
    authorPacket: {
      schemaVersion: 1 as const,
      intent: "AUTHOR_SECRET: make the requested change.",
      successCriteria: ["The file contains the new value."],
      planTraceability: [{ planItem: "Change the file.", implementation: "Updated it." }],
      technicalApproach: "Replace the complete text.",
      componentWalkthrough: [{ component: "reviewed.txt", changes: "Changed one line." }],
      decisions: [],
      invariants: [],
      claimedVerification: [
        { command: "npm test", outcome: "PASSED" as const, summary: "Reported by author." },
      ],
      risks: [],
      knownGaps: [],
      challengePoints: [],
    },
    reviewConfigRef: "config_test",
  };
  const packetPath = join(repositoryPath, ".review-runs", "packet");
  await writeSnapshotPacketV1(packetPath, await captureGitSnapshotV1(request), request);
  return { repositoryPath, packetPath };
}

const config: ReviewRunConfigV1 = {
  schemaVersion: 1,
  configId: "config_test",
  model: "mock/reviewer",
  budgets: {
    maxInitialEvidenceBytes: 32_000,
    maxConversationBytes: 128_000,
    maxOutputTokensPerCall: 1_000,
    maxTotalTokens: 10_000,
    timeoutMs: 10_000,
  },
};

function response(value: unknown, totalTokens = 100): ReviewProviderResponseV1 {
  return {
    value,
    rawContent: JSON.stringify(value),
    responseId: "mock-response",
    model: "mock/reviewer",
    provider: "mock",
    usage: {
      promptTokens: totalTokens - 10,
      completionTokens: 10,
      totalTokens,
      cost: null,
    },
  };
}

describe("two-stage review orchestrator", () => {
  it("persists the blind assessment before revealing the author packet", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    const calls: ReviewProviderRequestV1[] = [];
    const provider: ReviewProviderV1 = {
      complete: async (providerRequest) => {
        calls.push(providerRequest);
        if (providerRequest.stage === "PRELIMINARY") {
          assert.doesNotMatch(JSON.stringify(providerRequest), /AUTHOR_SECRET/);
          return response({
            schemaVersion: 1,
            stage: "PRELIMINARY",
            snapshotDigest: JSON.parse(providerRequest.messages[1]?.content ?? "{}")
              .snapshotManifest.snapshotDigest,
            briefDigest: JSON.parse(providerRequest.messages[1]?.content ?? "{}").briefDigest,
            summary: "The one-file change is understandable.",
            inspectedPaths: ["reviewed.txt"],
            findings: [],
            evidenceGaps: [],
            limitations: [],
            nextAction: "REQUEST_AUTHOR_PACKET",
          });
        }
        assert.match(JSON.stringify(providerRequest), /AUTHOR_SECRET/);
        await readFile(join(packetPath, "review", "preliminary.json"), "utf8");
        const blindBrief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
        return response({
          schemaVersion: 1,
          stage: "FINAL",
          snapshotDigest: blindBrief.snapshotManifest.snapshotDigest,
          briefDigest: blindBrief.briefDigest,
          summary: "No blocking issue remains after reconciliation.",
          findings: [],
          preliminaryFindingDispositions: [],
          authorClaims: [
            {
              claim: "The author reported npm test passed.",
              status: "UNVERIFIED",
              explanation: "This slice did not run local commands.",
            },
          ],
          limitations: [],
          verdict: "READY",
          nextActions: { blockers: [], fastFollows: [] },
        });
      },
    };

    try {
      const result = await runTwoStageReviewV1(packetPath, config, provider);

      assert.equal(calls.length, 2);
      assert.equal(result.report.verdict, "READY");
      assert.match(await readFile(result.markdownPath, "utf8"), /Verdict: Ready/);
      assert.doesNotMatch(await readFile(result.briefPath, "utf8"), /AUTHOR_SECRET/);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("does not reveal author content after malformed preliminary output", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    let calls = 0;
    const provider: ReviewProviderV1 = {
      complete: async () => {
        calls += 1;
        return response({ verdict: "READY" });
      },
    };

    try {
      await assert.rejects(() => runTwoStageReviewV1(packetPath, config, provider), /preliminary/i);
      assert.equal(calls, 1);
      const candidate = await readFile(
        join(packetPath, "review", "preliminary-provider-response.json"),
        "utf8",
      );
      assert.match(candidate, /READY/);
      assert.doesNotMatch(candidate, /AUTHOR_SECRET/);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("stops before author delivery when the remaining token budget cannot reserve the final call", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    let calls = 0;
    const provider: ReviewProviderV1 = {
      complete: async (providerRequest) => {
        calls += 1;
        const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
        return response(
          {
            schemaVersion: 1,
            stage: "PRELIMINARY",
            snapshotDigest: brief.snapshotManifest.snapshotDigest,
            briefDigest: brief.briefDigest,
            summary: "Initial review completed.",
            inspectedPaths: ["reviewed.txt"],
            findings: [],
            evidenceGaps: [],
            limitations: [],
            nextAction: "REQUEST_AUTHOR_PACKET",
          },
          150,
        );
      },
    };

    try {
      await assert.rejects(
        () =>
          runTwoStageReviewV1(
            packetPath,
            {
              ...config,
              budgets: { ...config.budgets, maxOutputTokensPerCall: 100, maxTotalTokens: 200 },
            },
            provider,
          ),
        /token budget/i,
      );
      assert.equal(calls, 1);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("does not accept Ready when changed evidence was excluded", async () => {
    const { repositoryPath, packetPath } = await arrangePacket(true);
    const provider: ReviewProviderV1 = {
      complete: async (providerRequest) => {
        const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
        if (providerRequest.stage === "PRELIMINARY") {
          return response({
            schemaVersion: 1,
            stage: "PRELIMINARY",
            snapshotDigest: brief.snapshotManifest.snapshotDigest,
            briefDigest: brief.briefDigest,
            summary: "The visible text change was inspected.",
            inspectedPaths: ["reviewed.txt"],
            findings: [],
            evidenceGaps: ["The excluded path could not be inspected."],
            limitations: ["A changed path was excluded."],
            nextAction: "REQUEST_AUTHOR_PACKET",
          });
        }
        return response({
          schemaVersion: 1,
          stage: "FINAL",
          snapshotDigest: brief.snapshotManifest.snapshotDigest,
          briefDigest: brief.briefDigest,
          summary: "The reviewer incorrectly tried to approve incomplete scope.",
          findings: [],
          preliminaryFindingDispositions: [],
          authorClaims: [],
          limitations: [],
          verdict: "READY",
          nextActions: { blockers: [], fastFollows: [] },
        });
      },
    };

    try {
      await assert.rejects(
        () => runTwoStageReviewV1(packetPath, config, provider),
        /coverage constraint/i,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
