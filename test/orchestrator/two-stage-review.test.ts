import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import {
  captureGitSnapshotV1,
  ProviderCallError,
  resumeFinalReviewV1,
  runTwoStageReviewV1,
  type ReviewProviderV1,
  type ReviewProviderRequestV1,
  type ReviewProviderResponseV1,
  type ReviewRunConfigV2,
  writeSnapshotPacketV1,
} from "../../src/index.js";

const execFileAsync = promisify(execFile);
const mockDigest = { algorithm: "SHA256" as const, value: "a".repeat(64) };

function valueAtPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const segment of path) {
    assert.ok(current !== null && typeof current === "object");
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function mockAuditRequest(providerRequest: ReviewProviderRequestV1) {
  return {
    providerPolicyVersion: "mock-provider-v1",
    wireBodyDigest: mockDigest,
    wireBodyBytes: Buffer.byteLength(JSON.stringify(providerRequest), "utf8"),
    credentialFreeWireRequestDigest: mockDigest,
  };
}

async function git(repositoryPath: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", repositoryPath, ...args], { encoding: "utf8" });
}

async function arrangePacket(
  includeExcludedPath = false,
  authorIntent = "AUTHOR_SECRET: make the requested change.",
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
      intent: authorIntent,
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

const config: ReviewRunConfigV2 = {
  schemaVersion: 2,
  configId: "config_test",
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

function responseWithoutUsage(value: unknown): ReviewProviderResponseV1 {
  return {
    ...response(value),
    usage: {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      cost: null,
    },
  };
}

function canonicalInputCoverage() {
  return [
    {
      canonicalInputId: "input_requirement",
      status: "ASSESSED" as const,
      explanation: "The requirement was assessed.",
    },
    {
      canonicalInputId: "input_plan",
      status: "ASSESSED" as const,
      explanation: "The implementation plan was assessed.",
    },
  ];
}

function finalCoverage() {
  return {
    preliminaryConcernDispositions: [],
    authorVerificationClaims: [
      {
        claimIndex: 0,
        command: "npm test",
        claimedOutcome: "PASSED" as const,
        claimedSummary: "Reported by author.",
        status: "UNVERIFIED" as const,
        explanation: "The reviewer did not run the author-reported command.",
      },
    ],
    changedPathCoverage: [
      {
        path: "reviewed.txt",
        status: "INSPECTED" as const,
        explanation: "The complete changed file was inspected.",
      },
    ],
    canonicalInputCoverage: canonicalInputCoverage(),
  };
}

describe("two-stage review orchestrator", () => {
  it("persists the blind assessment before revealing the author packet", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    const calls: ReviewProviderRequestV1[] = [];
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
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
            canonicalInputCoverage: canonicalInputCoverage(),
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
          ...finalCoverage(),
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
      const events = (await readFile(result.runRecordPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        events.map((event) => event.type),
        [
          "RUN_STARTED",
          "CALL_STARTED",
          "CALL_SUCCEEDED",
          "PRELIMINARY_PERSISTED",
          "AUTHOR_DELIVERED",
          "CALL_STARTED",
          "CALL_SUCCEEDED",
          "RUN_COMPLETED",
        ],
      );
      assert.deepEqual(
        events.filter((event) => event.type === "CALL_STARTED").map((event) => event.attemptNumber),
        [1, 2],
      );
      for (const event of events.filter((candidate) => candidate.type === "CALL_STARTED")) {
        assert.equal(event.providerPolicyVersion, "mock-provider-v1");
        assert.deepEqual(event.wireBodyDigest, mockDigest);
        assert.equal(typeof event.wireBodyBytes, "number");
        assert.deepEqual(event.credentialFreeWireRequestDigest, mockDigest);
      }
      for (const call of calls) {
        const evidenceVariants = valueAtPath(call.responseSchema.schema, [
          "properties",
          "findings",
          "items",
          "properties",
          "evidence",
          "items",
          "anyOf",
        ]);
        assert.ok(Array.isArray(evidenceVariants));
        for (const variant of evidenceVariants) {
          assert.deepEqual(valueAtPath(variant, ["properties", "path", "enum"]), ["reviewed.txt"]);
        }
      }
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("does not reveal author content after malformed preliminary output", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    let calls = 0;
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
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

  it("persists a durable attempt and terminal record when transport is uncertain", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async () => {
        throw new ProviderCallError(
          "TRANSPORT_UNCERTAIN",
          "The request may have been submitted and was not retried.",
        );
      },
    };

    try {
      await assert.rejects(
        () => runTwoStageReviewV1(packetPath, config, provider),
        (error: unknown) =>
          error instanceof ProviderCallError && error.code === "TRANSPORT_UNCERTAIN",
      );
      const events = (await readFile(join(packetPath, "review", "run-record.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      assert.deepEqual(
        events.map((event) => event.type),
        ["RUN_STARTED", "CALL_STARTED", "CALL_FAILED", "RUN_FAILED"],
      );
      assert.equal(events[1]?.stage, "PRELIMINARY");
      assert.equal(events[2]?.error.code, "TRANSPORT_UNCERTAIN");
      assert.equal(events[3]?.terminalState, "TRANSPORT_UNCERTAIN");
      assert.doesNotMatch(JSON.stringify(events), /AUTHOR_SECRET/);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("resumes only the failed final stage once after a definite provider 429", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    const firstProvider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async (providerRequest) => {
        const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
        if (providerRequest.stage === "PRELIMINARY") {
          return response({
            schemaVersion: 1,
            stage: "PRELIMINARY",
            snapshotDigest: brief.snapshotManifest.snapshotDigest,
            briefDigest: brief.briefDigest,
            summary: "The change was inspected before the final provider failure.",
            inspectedPaths: ["reviewed.txt"],
            canonicalInputCoverage: canonicalInputCoverage(),
            findings: [],
            evidenceGaps: [],
            limitations: [],
            nextAction: "REQUEST_AUTHOR_PACKET",
          });
        }
        throw new ProviderCallError("PROVIDER_ERROR", "OpenRouter rate limit exceeded.", {
          diagnostic: {
            httpStatus: 429,
            providerErrorCode: "429",
            providerMessage: "Rate limit exceeded",
            errorType: "rate_limit_exceeded",
            providerCode: "rate_limited",
            providerName: "Mock Provider",
            model: "mock/reviewer",
            responseId: null,
            retryAfter: null,
          },
        });
      },
    };

    try {
      await assert.rejects(() => runTwoStageReviewV1(packetPath, config, firstProvider), /rate/i);
      const persistedPreliminary = await readFile(
        join(packetPath, "review", "preliminary.json"),
        "utf8",
      );
      const resumedCalls: ReviewProviderRequestV1[] = [];
      const resumedProvider: ReviewProviderV1 = {
        auditRequest: mockAuditRequest,
        complete: async (providerRequest) => {
          resumedCalls.push(providerRequest);
          const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
          return response({
            schemaVersion: 1,
            stage: "FINAL",
            snapshotDigest: brief.snapshotManifest.snapshotDigest,
            briefDigest: brief.briefDigest,
            summary: "The persisted preliminary assessment was reconciled.",
            findings: [],
            preliminaryFindingDispositions: [],
            ...finalCoverage(),
            authorClaims: [],
            limitations: [],
            verdict: "READY",
            nextActions: { blockers: [], fastFollows: [] },
          });
        },
      };

      await assert.rejects(
        () =>
          resumeFinalReviewV1(
            packetPath,
            {
              ...config,
              providerRouting: {
                ...config.providerRouting,
                maxPrice: { ...config.providerRouting.maxPrice, completion: 0.15 },
              },
            },
            resumedProvider,
          ),
        /configuration must exactly match/i,
      );
      assert.equal(resumedCalls.length, 0);

      const result = await resumeFinalReviewV1(packetPath, config, resumedProvider);

      assert.equal(result.report.verdict, "READY");
      assert.equal(resumedCalls.length, 1);
      assert.equal(resumedCalls[0]?.stage, "FINAL");
      assert.match(JSON.stringify(resumedCalls[0]), /AUTHOR_SECRET/);
      assert.equal(
        await readFile(join(packetPath, "review", "preliminary.json"), "utf8"),
        persistedPreliminary,
      );
      const resumeClaim = JSON.parse(
        await readFile(join(packetPath, "review", "final-resume-claim.json"), "utf8"),
      );
      assert.deepEqual(
        {
          schemaVersion: resumeClaim.schemaVersion,
          stage: resumeClaim.stage,
          failedAttemptNumber: resumeClaim.failedAttemptNumber,
          claimedAttemptNumber: resumeClaim.claimedAttemptNumber,
        },
        {
          schemaVersion: 1,
          stage: "FINAL",
          failedAttemptNumber: 2,
          claimedAttemptNumber: 3,
        },
      );
      assert.equal(resumeClaim.configDigest.algorithm, "SHA256");
      assert.match(resumeClaim.configDigest.value, /^[a-f0-9]{64}$/);
      const events = (await readFile(result.runRecordPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        events.map((event) => event.type),
        [
          "RUN_STARTED",
          "CALL_STARTED",
          "CALL_SUCCEEDED",
          "PRELIMINARY_PERSISTED",
          "AUTHOR_DELIVERED",
          "CALL_STARTED",
          "CALL_FAILED",
          "RUN_FAILED",
          "RUN_RESUMED",
          "CALL_STARTED",
          "CALL_SUCCEEDED",
          "RUN_COMPLETED",
        ],
      );
      assert.deepEqual(
        events.filter((event) => event.type === "CALL_STARTED").map((event) => event.attemptNumber),
        [1, 2, 3],
      );

      let repeatCalls = 0;
      await assert.rejects(
        () =>
          resumeFinalReviewV1(packetPath, config, {
            auditRequest: mockAuditRequest,
            complete: async () => {
              repeatCalls += 1;
              throw new Error("must not be called");
            },
          }),
        /already (?:been )?resumed|completed/i,
      );
      assert.equal(repeatCalls, 0);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("does not resume a transport-uncertain final submission", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async (providerRequest) => {
        const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
        if (providerRequest.stage === "PRELIMINARY") {
          return response({
            schemaVersion: 1,
            stage: "PRELIMINARY",
            snapshotDigest: brief.snapshotManifest.snapshotDigest,
            briefDigest: brief.briefDigest,
            summary: "The change was inspected before transport became uncertain.",
            inspectedPaths: ["reviewed.txt"],
            canonicalInputCoverage: canonicalInputCoverage(),
            findings: [],
            evidenceGaps: [],
            limitations: [],
            nextAction: "REQUEST_AUTHOR_PACKET",
          });
        }
        throw new ProviderCallError(
          "TRANSPORT_UNCERTAIN",
          "The final request may have been submitted.",
        );
      },
    };

    try {
      await assert.rejects(() => runTwoStageReviewV1(packetPath, config, provider));
      let resumeCalls = 0;
      await assert.rejects(
        () =>
          resumeFinalReviewV1(packetPath, config, {
            auditRequest: mockAuditRequest,
            complete: async () => {
              resumeCalls += 1;
              throw new Error("must not be called");
            },
          }),
        /transport.*uncertain/i,
      );
      assert.equal(resumeCalls, 0);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("persists allowlisted provider diagnostics in failure events", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async () => {
        throw new ProviderCallError("PROVIDER_ERROR", "OpenRouter rate limit exceeded.", {
          diagnostic: {
            httpStatus: 429,
            providerErrorCode: "429",
            providerMessage: "Rate limit exceeded",
            errorType: "rate_limit_exceeded",
            providerCode: "rate_limited",
            providerName: "Mock Provider",
            model: "mock/reviewer",
            responseId: "generation-error-1",
            retryAfter: "45",
          },
        });
      },
    };

    try {
      await assert.rejects(() => runTwoStageReviewV1(packetPath, config, provider));
      const events = (await readFile(join(packetPath, "review", "run-record.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      assert.deepEqual(events[2]?.error.diagnostic, {
        httpStatus: 429,
        providerErrorCode: "429",
        providerMessage: "Rate limit exceeded",
        errorType: "rate_limit_exceeded",
        providerCode: "rate_limited",
        providerName: "Mock Provider",
        model: "mock/reviewer",
        responseId: "generation-error-1",
        retryAfter: "45",
      });
      assert.deepEqual(events[3]?.error.diagnostic, events[2]?.error.diagnostic);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("retains conservative reservations when either provider response omits usage", async () => {
    for (const stageWithoutUsage of ["PRELIMINARY", "FINAL"] as const) {
      const { repositoryPath, packetPath } = await arrangePacket();
      const provider: ReviewProviderV1 = {
        auditRequest: mockAuditRequest,
        complete: async (providerRequest) => {
          const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
          const value =
            providerRequest.stage === "PRELIMINARY"
              ? {
                  schemaVersion: 1,
                  stage: "PRELIMINARY",
                  snapshotDigest: brief.snapshotManifest.snapshotDigest,
                  briefDigest: brief.briefDigest,
                  summary: "The change was inspected.",
                  inspectedPaths: ["reviewed.txt"],
                  canonicalInputCoverage: canonicalInputCoverage(),
                  findings: [],
                  evidenceGaps: [],
                  limitations: [],
                  nextAction: "REQUEST_AUTHOR_PACKET",
                }
              : {
                  schemaVersion: 1,
                  stage: "FINAL",
                  snapshotDigest: brief.snapshotManifest.snapshotDigest,
                  briefDigest: brief.briefDigest,
                  summary: "The change is ready.",
                  findings: [],
                  preliminaryFindingDispositions: [],
                  ...finalCoverage(),
                  authorClaims: [],
                  limitations: [],
                  verdict: "READY",
                  nextActions: { blockers: [], fastFollows: [] },
                };
          return providerRequest.stage === stageWithoutUsage
            ? responseWithoutUsage(value)
            : response(value);
        },
      };

      try {
        const result = await runTwoStageReviewV1(packetPath, config, provider);
        assert.equal(result.report.verdict, "READY");
      } finally {
        await rm(repositoryPath, { recursive: true, force: true });
      }
    }
  });

  it("keeps the admitted preliminary retransmission reservation stable after call one", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    let calls = 0;
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async (providerRequest) => {
        calls += 1;
        const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
        if (providerRequest.stage === "PRELIMINARY") {
          const preliminaryResponse = response({
            schemaVersion: 1,
            stage: "PRELIMINARY",
            snapshotDigest: brief.snapshotManifest.snapshotDigest,
            briefDigest: brief.briefDigest,
            summary: "é".repeat(13_750),
            inspectedPaths: ["reviewed.txt"],
            canonicalInputCoverage: canonicalInputCoverage(),
            findings: [],
            evidenceGaps: [],
            limitations: [],
            nextAction: "REQUEST_AUTHOR_PACKET",
          });
          preliminaryResponse.usage = {
            promptTokens: 1_000,
            completionTokens: 14_000,
            totalTokens: 15_000,
            cost: null,
          };
          return preliminaryResponse;
        }
        return response({
          schemaVersion: 1,
          stage: "FINAL",
          snapshotDigest: brief.snapshotManifest.snapshotDigest,
          briefDigest: brief.briefDigest,
          summary: "The admitted review completed.",
          findings: [],
          preliminaryFindingDispositions: [],
          ...finalCoverage(),
          authorClaims: [],
          limitations: [],
          verdict: "READY",
          nextActions: { blockers: [], fastFollows: [] },
        });
      },
    };

    try {
      const result = await runTwoStageReviewV1(
        packetPath,
        {
          ...config,
          budgets: {
            ...config.budgets,
            maxOutputTokensPerCall: 15_000,
            maxTotalTokens: 67_000,
          },
        },
        provider,
      );

      assert.equal(calls, 2);
      assert.equal(result.report.verdict, "READY");
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("makes no provider call when the total token budget cannot reserve both stages", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    let calls = 0;
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
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
            canonicalInputCoverage: canonicalInputCoverage(),
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
      assert.equal(calls, 0);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("makes no provider call when the known final conversation skeleton exceeds its byte budget", async () => {
    const { repositoryPath, packetPath } = await arrangePacket(
      false,
      `AUTHOR_SECRET: ${"x".repeat(20_000)}`,
    );
    let calls = 0;
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async (providerRequest) => {
        calls += 1;
        const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
        return response({
          schemaVersion: 1,
          stage: "PRELIMINARY",
          snapshotDigest: brief.snapshotManifest.snapshotDigest,
          briefDigest: brief.briefDigest,
          summary: "Initial review completed.",
          inspectedPaths: ["reviewed.txt"],
          canonicalInputCoverage: canonicalInputCoverage(),
          findings: [],
          evidenceGaps: [],
          limitations: [],
          nextAction: "REQUEST_AUTHOR_PACKET",
        });
      },
    };

    try {
      await assert.rejects(
        () =>
          runTwoStageReviewV1(
            packetPath,
            {
              ...config,
              budgets: { ...config.budgets, maxConversationBytes: 10_000 },
            },
            provider,
          ),
        /byte budget/i,
      );
      assert.equal(calls, 0);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("does not accept Ready when changed evidence was excluded", async () => {
    const { repositoryPath, packetPath } = await arrangePacket(true);
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
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
            canonicalInputCoverage: canonicalInputCoverage(),
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
          ...finalCoverage(),
          preliminaryConcernDispositions: [
            {
              kind: "EVIDENCE_GAP",
              preliminaryConcern: "The excluded path could not be inspected.",
              disposition: "RESOLVED",
              rationale: "The reviewer incorrectly claimed the gap was resolved.",
            },
            {
              kind: "LIMITATION",
              preliminaryConcern: "A changed path was excluded.",
              disposition: "RESOLVED",
              rationale: "The reviewer incorrectly claimed the limitation was resolved.",
            },
          ],
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

  it("rejects Ready unless final coverage accounts for every changed path", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async (providerRequest) => {
        const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
        if (providerRequest.stage === "PRELIMINARY") {
          return response({
            schemaVersion: 1,
            stage: "PRELIMINARY",
            snapshotDigest: brief.snapshotManifest.snapshotDigest,
            briefDigest: brief.briefDigest,
            summary: "The change was inspected.",
            inspectedPaths: ["reviewed.txt"],
            canonicalInputCoverage: canonicalInputCoverage(),
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
          summary: "The reviewer omitted the real path from its coverage ledger.",
          findings: [],
          preliminaryFindingDispositions: [],
          ...finalCoverage(),
          changedPathCoverage: [
            {
              path: "invented.txt",
              status: "INSPECTED",
              explanation: "This path was not part of the snapshot.",
            },
          ],
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
        /changed-path coverage/i,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("rejects finding coordinates outside the frozen source", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async (providerRequest) => {
        const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
        if (providerRequest.stage === "PRELIMINARY") {
          return response({
            schemaVersion: 1,
            stage: "PRELIMINARY",
            snapshotDigest: brief.snapshotManifest.snapshotDigest,
            briefDigest: brief.briefDigest,
            summary: "The change was inspected.",
            inspectedPaths: ["reviewed.txt"],
            canonicalInputCoverage: canonicalInputCoverage(),
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
          summary: "The final finding cites a nonexistent line.",
          findings: [
            {
              id: "finding_bad_line",
              severity: "P1",
              title: "Bad coordinate",
              scenario: "The finding points beyond the frozen file.",
              impact: "The evidence cannot be verified.",
              evidence: [
                {
                  path: "reviewed.txt",
                  anchor: "LINE_RANGE",
                  side: "HEAD",
                  startLine: 99,
                  endLine: 99,
                  detail: "The file contains only one line.",
                },
              ],
              correction: "Use a valid frozen coordinate.",
              origin: "FINAL_ONLY",
              emergenceRationale: "The final response introduced this coordinate defect.",
            },
          ],
          preliminaryFindingDispositions: [],
          ...finalCoverage(),
          authorClaims: [],
          limitations: [],
          verdict: "NOT_READY",
          nextActions: { blockers: ["Correct the evidence coordinate."], fastFollows: [] },
        });
      },
    };

    try {
      await assert.rejects(
        () => runTwoStageReviewV1(packetPath, config, provider),
        /outside the frozen source/i,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
