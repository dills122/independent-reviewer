import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  captureGitSnapshotV1,
  captureReviewerRulesGuidanceV1,
  type ReviewProviderV1,
  type ReviewRunConfigV3,
  runTwoStageReview,
  sha256Utf8,
  writeSnapshotPacketV1,
} from "../../src/index.js";

const execFileAsync = promisify(execFile);
const auditDigest = { algorithm: "SHA256" as const, value: "a".repeat(64) };

async function git(repositoryPath: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", repositoryPath, ...args], { encoding: "utf8" });
}

async function arrangeGuidancePacket(rules: string): Promise<{
  repositoryPath: string;
  packetPath: string;
}> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "independent-reviewer-guidance-run-"));
  await git(repositoryPath, "init", "--initial-branch=main");
  await git(repositoryPath, "config", "user.name", "Guidance Run Test");
  await git(repositoryPath, "config", "user.email", "guidance@example.invalid");
  await git(repositoryPath, "config", "commit.gpgsign", "false");
  await mkdir(join(repositoryPath, ".independent-reviewer"), { recursive: true });
  await writeFile(join(repositoryPath, ".independent-reviewer", "rules.md"), rules);
  await writeFile(join(repositoryPath, "reviewed.ts"), "export const value = 1;\n");
  await git(repositoryPath, "add", ".");
  await git(repositoryPath, "commit", "-m", "initial");
  await git(repositoryPath, "switch", "-c", "feature/guidance");
  await writeFile(join(repositoryPath, "reviewed.ts"), "export const value = 2;\n");

  const profile = {
    schemaVersion: 1,
    name: "TypeScript review",
    source: "Test fixture",
    rules: [
      {
        id: "rule_typescript",
        text: "Review TypeScript changes.",
        enforcement: "REQUIRED",
        paths: ["**/*.ts"],
        exceptions: null,
      },
    ],
  };
  const request = {
    schemaVersion: 2 as const,
    mode: "STANDARDS" as const,
    flowId: "flow_guidance_run",
    reviewInstance: { number: 1, maximum: 3 },
    repository: { path: repositoryPath, base: "main" },
    canonicalInputs: {
      standards: [
        {
          id: "input_standard",
          kind: "PROJECT_GUIDANCE" as const,
          title: profile.name,
          content: JSON.stringify(profile),
          provenance: { type: "INLINE" as const, label: "guidance run test" },
        },
      ],
    },
    authorPacket: {
      schemaVersion: 2 as const,
      overview: "AUTHOR_ONLY: changed the value intentionally.",
      claimedVerification: [],
    },
    reviewConfigRef: "config_guidance_run",
  };
  const captured = await captureGitSnapshotV1(request);
  const guidance = await captureReviewerRulesGuidanceV1(repositoryPath, captured.manifest);
  const packetPath = join(repositoryPath, ".review-runs", "packet");
  await writeSnapshotPacketV1(packetPath, captured, request, { guidance });
  return { repositoryPath, packetPath };
}

const config: ReviewRunConfigV3 = {
  schemaVersion: 3,
  configId: "config_guidance_run",
  model: "mock/reviewer",
  fallbackModels: [],
  providerRouting: {
    order: ["mock/fp4"],
    pinToOrder: false,
    zeroDataRetention: false,
    denyDataCollection: false,
    maxPrice: { prompt: 0.1, completion: 0.2, request: 0 },
  },
  budgets: {
    maxInitialEvidenceBytes: 32_000,
    maxConversationBytes: 256_000,
    maxOutputTokensPerCall: 1_000,
    maxTotalTokens: 100_000,
    maxTotalCostUsd: 1,
    timeoutMs: 10_000,
    maxAttemptsPerCall: 2,
    minimumCallIntervalMs: 0,
  },
};

test("guidance-capable run binds prompt identity and withholds author context", async () => {
  const rules = "# Reviewer priority\n\nNever hide a fallback.\n";
  const { repositoryPath, packetPath } = await arrangeGuidancePacket(rules);
  const requests: Parameters<ReviewProviderV1["complete"]>[0][] = [];
  const provider: ReviewProviderV1 = {
    auditRequest: (request) => ({
      providerPolicyVersion: "mock-v1",
      wireBodyDigest: auditDigest,
      wireBodyBytes: Buffer.byteLength(JSON.stringify(request), "utf8"),
      credentialFreeWireRequestDigest: auditDigest,
    }),
    complete: async (request) => {
      requests.push(request);
      const brief = JSON.parse(request.messages[1]?.content ?? "{}");
      const common = {
        snapshotDigest: brief.snapshotManifest.snapshotDigest,
        briefDigest: brief.briefDigest,
        summary: "Guidance-aware review completed.",
        ruleAssessments: [
          {
            ruleId: "rule_typescript",
            status: "ASSESSED",
            conflictingRuleIds: [],
            explanation: "Reviewed the selected rule and repository guidance.",
          },
        ],
      };
      const value =
        request.stage === "PRELIMINARY"
          ? {
              ...common,
              schemaVersion: 2,
              stage: "PRELIMINARY",
              inspectedPaths: ["reviewed.ts"],
              canonicalInputCoverage: [
                {
                  canonicalInputId: "input_standard",
                  status: "ASSESSED",
                  explanation: "Applied the selected standard.",
                },
              ],
              findings: [],
              evidenceGaps: [],
              limitations: [],
              nextAction: "REQUEST_AUTHOR_PACKET",
            }
          : {
              ...common,
              schemaVersion: 3,
              stage: "FINAL",
              mode: "STANDARDS",
              findings: [],
              withdrawnPreliminaryFindings: [],
              preliminaryConcernDispositions: [],
              authorClaims: [],
              authorVerificationClaims: [],
              limitations: [],
              verdict: "READY",
              nextActions: { blockers: [], fastFollows: [] },
            };
      return {
        value,
        rawContent: JSON.stringify(value),
        responseId: "mock-response",
        model: "mock/reviewer",
        provider: "mock/fp4",
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, cost: null },
      };
    },
  };

  try {
    const result = await runTwoStageReview(packetPath, config, provider);
    assert.equal(result.report.verdict, "READY");
    assert.equal(requests.length, 2);
    assert.match(requests[0]?.messages[0]?.content ?? "", /REVIEWER_SPECIFIC/);
    assert.match(requests[0]?.messages[1]?.content ?? "", /Never hide a fallback/);
    assert.doesNotMatch(JSON.stringify(requests[0]?.messages), /AUTHOR_ONLY/);
    assert.match(JSON.stringify(requests[1]?.messages), /AUTHOR_ONLY/);
    const events = (await readFile(result.runRecordPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const started = events.find((event) => event.type === "RUN_STARTED");
    assert.equal(started.promptVersion, "standards-review-v15");
    assert.equal(started.guidanceGraphDigest.value.length, 64);
    assert.equal(events.find((event) => event.type === "GUIDANCE_ADMISSION")?.status, "ACCEPTED");
    assert.equal(
      events.find((event) => event.type === "CALL_STARTED")?.promptVersion,
      "standards-review-v15",
    );
    const reportMetadata = JSON.parse(await readFile(result.reportMetadataPath, "utf8"));
    assert.deepEqual(reportMetadata.guidanceGraphDigest, started.guidanceGraphDigest);
    assert.equal(reportMetadata.promptVersion, "standards-review-v15");
    assert.equal(reportMetadata.preliminarySchema, "standards_preliminary_v2");
    assert.equal(reportMetadata.finalSchema, "standards_candidate_v3");
    assert.deepEqual(
      reportMetadata.reportDigest,
      sha256Utf8(await readFile(result.finalPath, "utf8")),
    );
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("64 KiB reviewer guidance stops before the first provider call", async () => {
  const { repositoryPath, packetPath } = await arrangeGuidancePacket("g".repeat(64 * 1024));
  let calls = 0;
  const provider: ReviewProviderV1 = {
    auditRequest: () => ({
      providerPolicyVersion: "mock-v1",
      wireBodyDigest: auditDigest,
      wireBodyBytes: 1,
      credentialFreeWireRequestDigest: auditDigest,
    }),
    complete: async () => {
      calls += 1;
      throw new Error("Provider must not be called.");
    },
  };
  try {
    await assert.rejects(
      () => runTwoStageReview(packetPath, config, provider),
      /admission stopped/i,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});
