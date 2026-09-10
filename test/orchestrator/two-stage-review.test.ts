import { asFinalCandidateV2 } from "../helpers/final-candidate.js";
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

function findingEvidenceVariants(responseSchema: unknown): unknown[] {
  const findingItems = valueAtPath(responseSchema, ["properties", "findings", "items"]);
  assert.ok(findingItems !== null && typeof findingItems === "object");
  const alternatives = (findingItems as Record<string, unknown>).oneOf;
  const findingSchemas = Array.isArray(alternatives) ? alternatives : [findingItems];
  return findingSchemas.flatMap((findingSchema) => {
    const variants = valueAtPath(findingSchema, ["properties", "evidence", "items", "anyOf"]);
    assert.ok(Array.isArray(variants));
    return variants;
  });
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
  projectGuidanceContent?: string,
  authorVerificationSummary = "Reported by author.",
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
      projectGuidance:
        projectGuidanceContent === undefined
          ? []
          : [
              {
                id: "input_style",
                kind: "PROJECT_GUIDANCE" as const,
                title: "TypeScript style",
                content: projectGuidanceContent,
                provenance: { type: "INLINE" as const, label: "flow test style" },
              },
            ],
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
        { command: "npm test", outcome: "PASSED" as const, summary: authorVerificationSummary },
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
    maxTotalCostUsd: 1,
    timeoutMs: 10_000,
  },
};

function response(value: unknown, totalTokens = 100): ReviewProviderResponseV1 {
  value = asFinalCandidateV2(value);
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

function collectArrayLimits(schema: unknown, propertyName: string): number[] {
  const limits: number[] = [];
  const visit = (value: unknown, name?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, name);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const node = value as Record<string, unknown>;
    if (name === propertyName && node.type === "array" && typeof node.maxItems === "number") {
      limits.push(node.maxItems);
    }
    const properties = node.properties;
    if (properties && typeof properties === "object") {
      for (const [key, child] of Object.entries(properties)) {
        visit(child, key);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "properties") {
        visit(child, name);
      }
    }
  };
  visit(schema);
  return limits;
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
          const blindEvidence = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
          assert.deepEqual(blindEvidence.requiredCoverage, {
            changedPaths: ["reviewed.txt"],
            canonicalInputIds: ["input_requirement", "input_plan"],
          });
          assert.match(
            blindEvidence.initialEvidence[0].content,
            /--- BASE\/reviewed\.txt\n1 \| before/,
          );
          assert.match(
            blindEvidence.initialEvidence[0].content,
            /\+\+\+ HEAD\/reviewed\.txt\n1 \| after/,
          );
          return response({
            schemaVersion: 1,
            stage: "PRELIMINARY",
            snapshotDigest: blindEvidence.snapshotManifest.snapshotDigest,
            briefDigest: blindEvidence.briefDigest,
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
      // The brief declares no reviewer capabilities at all (ADR-005).
      const builtBrief = JSON.parse(await readFile(result.briefPath, "utf8")) as Record<
        string,
        unknown
      >;
      assert.equal("capabilities" in builtBrief, false);
      const events = (await readFile(result.runRecordPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      // The applied limits are recorded with the call that used them, so a bounded review is
      // auditable from the run record alone.
      for (const started of events.filter((event) => event.type === "CALL_STARTED")) {
        assert.equal(started.responseArrayLimits.findings, 40);
        assert.equal(started.responseArrayLimits.evidence, 8);
      }
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
        const frozenEvidence = JSON.parse(call.messages[1]?.content ?? "{}");
        assert.equal(
          valueAtPath(call.responseSchema.schema, [
            "properties",
            "snapshotDigest",
            "properties",
            "value",
            "const",
          ]),
          frozenEvidence.snapshotManifest.snapshotDigest.value,
        );
        assert.equal(
          valueAtPath(call.responseSchema.schema, [
            "properties",
            "briefDigest",
            "properties",
            "value",
            "const",
          ]),
          frozenEvidence.briefDigest.value,
        );
        const evidenceVariants = findingEvidenceVariants(call.responseSchema.schema);
        for (const variant of evidenceVariants) {
          assert.deepEqual(valueAtPath(variant, ["properties", "path", "enum"]), ["reviewed.txt"]);
        }
        const canonicalCoverage = valueAtPath(call.responseSchema.schema, [
          "properties",
          "canonicalInputCoverage",
        ]) as Record<string, unknown>;
        assert.equal(canonicalCoverage.minItems, 2);
        assert.equal(canonicalCoverage.maxItems, 2);
        assert.deepEqual(
          valueAtPath(canonicalCoverage, ["items", "properties", "canonicalInputId", "enum"]),
          ["input_plan", "input_requirement"],
        );
        assert.equal(
          valueAtPath(call.responseSchema.schema, ["properties", "summary", "maxLength"]),
          400,
        );
        // Named per-array limits, not a blanket cap: a reviewer must be able to report more than
        // a dozen findings, and each finding more than a dozen pieces of evidence.
        assert.equal(
          valueAtPath(call.responseSchema.schema, ["properties", "findings", "maxItems"]),
          40,
        );
        assert.equal(
          valueAtPath(call.responseSchema.schema, ["properties", "limitations", "maxItems"]),
          12,
        );
        // The final report's findings are a oneOf union, so evidence arrays are collected by name
        // rather than by a single fixed path.
        const evidenceLimits = collectArrayLimits(call.responseSchema.schema, "evidence");
        assert.ok(evidenceLimits.length > 0);
        assert.deepEqual(new Set(evidenceLimits), new Set([8]));
        if (call.stage === "FINAL") {
          const changedPathCoverage = valueAtPath(call.responseSchema.schema, [
            "properties",
            "changedPathCoverage",
          ]) as Record<string, unknown>;
          assert.equal(changedPathCoverage.minItems, 1);
          assert.equal(changedPathCoverage.maxItems, 1);
          assert.deepEqual(
            valueAtPath(changedPathCoverage, ["items", "properties", "path", "enum"]),
            ["reviewed.txt"],
          );
        }
      }
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("repairs one complete invalid final candidate without repeating the preliminary", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    const calls: ReviewProviderRequestV1[] = [];
    const finding = {
      id: "finding_repair",
      severity: "P1" as const,
      title: "Changed behavior",
      scenario: "The changed path returns a different value.",
      impact: "The requirement is not met.",
      evidence: [
        {
          path: "reviewed.txt",
          anchor: "LINE_RANGE" as const,
          side: "HEAD" as const,
          startLine: 1,
          endLine: 1,
          detail: "The new value is visible on the first line.",
        },
      ],
      correction: "Restore the required behavior.",
    };
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async (providerRequest) => {
        calls.push(providerRequest);
        const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
        if (providerRequest.stage === "PRELIMINARY") {
          return response({
            schemaVersion: 1,
            stage: "PRELIMINARY",
            snapshotDigest: brief.snapshotManifest.snapshotDigest,
            briefDigest: brief.briefDigest,
            summary: "The behavior change is not ready.",
            inspectedPaths: ["reviewed.txt"],
            canonicalInputCoverage: canonicalInputCoverage(),
            findings: [finding],
            evidenceGaps: [],
            limitations: [],
            nextAction: "REQUEST_AUTHOR_PACKET",
          });
        }
        const isRepair = JSON.stringify(providerRequest.messages).includes("FINAL_OUTPUT_REPAIR");
        if (isRepair) {
          assert.deepEqual(
            valueAtPath(providerRequest.responseSchema.schema, [
              "properties",
              "withdrawnPreliminaryFindings",
              "items",
              "properties",
              "preliminaryFindingId",
              "enum",
            ]),
            ["finding_repair"],
          );
          assert.equal(
            valueAtPath(providerRequest.responseSchema.schema, [
              "properties",
              "preliminaryConcernDispositions",
              "maxItems",
            ]),
            0,
          );
        }
        const finalFinding = {
          ...finding,
          origin: "PRELIMINARY",
          emergenceRationale: isRepair ? null : "This must be null for preliminary findings.",
        };
        return response({
          schemaVersion: 1,
          stage: "FINAL",
          snapshotDigest: brief.snapshotManifest.snapshotDigest,
          briefDigest: brief.briefDigest,
          summary: "The behavior change remains unresolved.",
          findings: [finalFinding],
          preliminaryFindingDispositions: [
            {
              preliminaryFindingId: isRepair ? "finding_repair" : "finding_missing",
              disposition: "RETAINED",
              finalFindingId: "finding_repair",
              rationale: "The author packet does not resolve the changed behavior.",
            },
          ],
          ...finalCoverage(),
          authorClaims: [],
          limitations: [],
          verdict: "NOT_READY",
          nextActions: { blockers: ["Restore the required behavior."], fastFollows: [] },
        });
      },
    };

    try {
      const result = await runTwoStageReviewV1(packetPath, config, provider);

      assert.equal(result.report.verdict, "NOT_READY");
      assert.equal(calls.length, 3);
      assert.deepEqual(
        calls.map((call) => call.stage),
        ["PRELIMINARY", "FINAL", "FINAL"],
      );
      assert.match(JSON.stringify(calls[2]?.messages), /FINAL_OUTPUT_REPAIR/);
      assert.match(JSON.stringify(calls[2]?.messages), /finding_missing/);
      await readFile(join(packetPath, "review", "final-provider-response.json"), "utf8");
      await readFile(join(packetPath, "review", "final-repair-provider-response.json"), "utf8");
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
          "FINAL_CANDIDATE_REJECTED",
          "FINAL_REPAIR_REQUESTED",
          "CALL_STARTED",
          "CALL_SUCCEEDED",
          "RUN_COMPLETED",
        ],
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("fits exact author verification claims in the final provider schema", async () => {
    const { repositoryPath, packetPath } = await arrangePacket(
      false,
      "AUTHOR_SECRET",
      undefined,
      "A".repeat(401),
    );
    let calls = 0;
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async (providerRequest) => {
        calls += 1;
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
        const verificationLedger = valueAtPath(providerRequest.responseSchema.schema, [
          "properties",
          "authorVerificationClaims",
        ]) as Record<string, unknown>;
        assert.equal(verificationLedger.minItems, 1);
        assert.equal(verificationLedger.maxItems, 1);
        assert.deepEqual(
          valueAtPath(verificationLedger, ["items", "properties", "claimIndex", "enum"]),
          [0],
        );
        assert.equal(
          valueAtPath(verificationLedger, ["items", "properties", "claimedSummary"]),
          undefined,
        );
        throw new ProviderCallError("INVALID_RESPONSE", "stop after schema inspection");
      },
    };

    try {
      await assert.rejects(
        () => runTwoStageReviewV1(packetPath, config, provider),
        /stop after schema inspection/,
      );
      assert.equal(calls, 2);
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

  it("persists a private raw provider response before recording a rejected attempt", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    const rawResponseBody = {
      id: "generation-invalid",
      choices: [{ finish_reason: "stop", message: { content: null } }],
    };
    const responseMetadata = {
      responseId: "generation-invalid",
      model: "mock/reviewer",
      provider: "Mock Provider",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cost: 0.003 },
    };
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async () => {
        throw new ProviderCallError("INVALID_RESPONSE", "No usable completion content.", {
          responseBody: rawResponseBody,
          responseMetadata,
        });
      },
    };

    try {
      await assert.rejects(() => runTwoStageReviewV1(packetPath, config, provider));
      const events = (await readFile(join(packetPath, "review", "run-record.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        events.find((event) => event.type === "CALL_FAILED").responseMetadata,
        responseMetadata,
      );
      assert.equal(events.filter((event) => event.type === "CALL_STARTED").length, 1);
      assert.equal(
        events.some((event) => event.type === "CALL_SUCCEEDED"),
        false,
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(
            join(packetPath, "review", "provider-response-attempt-1.raw.json"),
            "utf8",
          ),
        ),
        rawResponseBody,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("sends compact rule-addressable project guidance to the reviewer", async () => {
    const guidance = [
      "# TypeScript",
      "This prose is context that should not be retransmitted verbatim.",
      "## Types",
      "- Use primitive `string` rather than boxed `String`.",
      "- Never use `var`; use `const` or `let`.",
    ].join("\n");
    const { repositoryPath, packetPath } = await arrangePacket(false, "AUTHOR_SECRET", guidance);
    let blindEvidence = "";
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async (providerRequest) => {
        blindEvidence = providerRequest.messages[1]?.content ?? "";
        throw new ProviderCallError("INVALID_RESPONSE", "Stop after capturing the prompt.");
      },
    };

    try {
      await assert.rejects(() => runTwoStageReviewV1(packetPath, config, provider));
      assert.match(blindEvidence, /projectGuidanceDigest/);
      assert.match(blindEvidence, /input_style:C1/);
      assert.match(blindEvidence, /This prose is context/);
      assert.match(blindEvidence, /input_style:R1/);
      assert.match(blindEvidence, /Use primitive `string` rather than boxed `String`\./);
      assert.match(blindEvidence, /input_style:R2/);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("makes no provider call when compact project guidance would be truncated", async () => {
    const { repositoryPath, packetPath } = await arrangePacket(
      false,
      "AUTHOR_SECRET",
      `- ${"x".repeat(12_001)}`,
    );
    let calls = 0;
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async () => {
        calls += 1;
        throw new Error("must not be called");
      },
    };

    try {
      await assert.rejects(
        () => runTwoStageReviewV1(packetPath, config, provider),
        /project guidance exceeds the compact transmission budget/i,
      );
      assert.equal(calls, 0);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("resumes only the failed final stage when optional model metadata is missing", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    const firstProvider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async (providerRequest) => {
        const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
        if (providerRequest.stage === "PRELIMINARY") {
          return {
            ...response({
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
            }),
            model: null,
          };
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
            retryAfter: "45",
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
            maxTotalTokens: 118_000,
            maxTotalCostUsd: 1,
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

  it("makes no provider call when the run cost ceiling cannot reserve both stages", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    let calls = 0;
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async () => {
        calls += 1;
        return response({});
      },
    };

    try {
      await assert.rejects(
        () =>
          runTwoStageReviewV1(
            packetPath,
            { ...config, budgets: { ...config.budgets, maxTotalCostUsd: 0.000_001 } },
            provider,
          ),
        /cost budget/i,
      );
      assert.equal(calls, 0);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("prices an unreported call cost at the routing ceiling instead of zero", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    let calls = 0;
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async (providerRequest) => {
        calls += 1;
        const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
        // 40M prompt tokens at the 0.03/M ceiling is $1.20, over the $1 run ceiling, and the
        // provider reports no cost at all.
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
          40_000_010,
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
              budgets: { ...config.budgets, maxTotalTokens: 100_000_000 },
            },
            provider,
          ),
        /cost budget/i,
      );
      assert.equal(calls, 1);

      const events = (await readFile(join(packetPath, "review", "run-record.jsonl"), "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const exhausted = events.find((event) => event.type === "BUDGET_EXHAUSTED");
      assert.equal(exhausted?.budget, "COST");
      assert.equal(exhausted?.phase, "REPORTED");
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
              concernIndex: 0,
              disposition: "RESOLVED",
              rationale: "The reviewer incorrectly claimed the gap was resolved.",
            },
            {
              kind: "LIMITATION",
              concernIndex: 0,
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

function transientFailure(status = 503) {
  return new ProviderCallError("PROVIDER_ERROR", "Temporarily unavailable", {
    diagnostic: {
      httpStatus: status,
      providerErrorCode: String(status),
      providerMessage: null,
      errorType: null,
      providerCode: null,
      providerName: "mock",
      model: null,
      responseId: null,
      retryAfter: "0",
    },
  });
}

function successfulEmptyResponse(request: ReviewProviderRequestV1) {
  const brief = JSON.parse(request.messages[1]?.content ?? "{}");
  const common = {
    schemaVersion: 1,
    stage: request.stage,
    snapshotDigest: brief.snapshotManifest.snapshotDigest,
    briefDigest: brief.briefDigest,
    summary: "Reviewed source.",
    findings: [],
    limitations: [],
  };
  return response(
    request.stage === "PRELIMINARY"
      ? {
          ...common,
          inspectedPaths: ["reviewed.txt"],
          canonicalInputCoverage: canonicalInputCoverage(),
          evidenceGaps: [],
          nextAction: "REQUEST_AUTHOR_PACKET",
        }
      : {
          ...common,
          ...finalCoverage(),
          preliminaryFindingDispositions: [],
          authorClaims: [],
          verdict: "READY",
          nextActions: { blockers: [], fastFollows: [] },
        },
  );
}

for (const status of [503, 529])
  it(`retries only the failed final ${status} call with identical inputs and unique attempt numbers`, async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    const calls: ReviewProviderRequestV1[] = [];
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async (request) => {
        calls.push(request);
        if (calls.length === 2) throw transientFailure(status);
        return successfulEmptyResponse(request);
      },
    };
    try {
      const result = await runTwoStageReviewV1(packetPath, config, provider);
      assert.equal(result.report.verdict, "READY");
      assert.deepEqual(
        calls.map((request) => request.stage),
        ["PRELIMINARY", "FINAL", "FINAL"],
      );
      assert.deepEqual(calls[1], calls[2]);
      const events = (await readFile(result.runRecordPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        events.filter((e) => e.type === "CALL_STARTED").map((e) => e.attemptNumber),
        [1, 2, 3],
      );
      const retry = events.find((e) => e.type === "PROVIDER_RETRY_REQUESTED");
      assert.ok(retry.chargedFailedTokens > 0);
      assert.ok(retry.chargedFailedCostUsd > 0);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

it("persists an unproductive final stream and retries only the final on another endpoint", async () => {
  const { repositoryPath, packetPath } = await arrangePacket();
  const calls: Array<{ endpoint: string | null; stage: string }> = [];
  const secondary: ReviewProviderV1 = {
    auditRequest: (providerRequest) => ({
      ...mockAuditRequest(providerRequest),
      requestedProviderEndpoint: "provider-b/bf16",
    }),
    complete: async (providerRequest) => {
      calls.push({ endpoint: "provider-b/bf16", stage: providerRequest.stage });
      return successfulEmptyResponse(providerRequest);
    },
  };
  const partial = {
    schemaVersion: 1,
    transport: "OPENROUTER_SSE",
    requestedProviderEndpoint: "provider-a/fp4",
    transcript: 'data: {"choices":[{"delta":{"content":"{   "}}]}\n\n',
    partialContentCharacters: 513,
    progress: {
      consecutiveFormattingWhitespace: 512,
      maximumFormattingWhitespace: 512,
      totalCharacters: 513,
    },
  };
  const primary: ReviewProviderV1 = {
    auditRequest: (providerRequest) => ({
      ...mockAuditRequest(providerRequest),
      requestedProviderEndpoint: providerRequest.stage === "FINAL" ? "provider-a/fp4" : null,
    }),
    complete: async (providerRequest) => {
      calls.push({
        endpoint: providerRequest.stage === "FINAL" ? "provider-a/fp4" : null,
        stage: providerRequest.stage,
      });
      if (providerRequest.stage === "FINAL") {
        throw new ProviderCallError(
          "UNPRODUCTIVE_STREAM",
          "Structured output stopped making progress.",
          {
            retryable: true,
            responseBody: partial,
            responseMetadata: {
              responseId: "generation-stalled",
              model: config.model,
              provider: "provider-a/fp4",
              finishReason: null,
              usage: {
                promptTokens: null,
                completionTokens: null,
                totalTokens: null,
                cost: null,
              },
            },
          },
        );
      }
      return successfulEmptyResponse(providerRequest);
    },
    forRetry: (error, providerRequest) => {
      assert.equal(error.code, "UNPRODUCTIVE_STREAM");
      assert.equal(providerRequest.stage, "FINAL");
      return secondary;
    },
  };

  try {
    const result = await runTwoStageReviewV1(packetPath, config, primary);
    assert.equal(result.report.verdict, "READY");
    assert.deepEqual(calls, [
      { endpoint: null, stage: "PRELIMINARY" },
      { endpoint: "provider-a/fp4", stage: "FINAL" },
      { endpoint: "provider-b/bf16", stage: "FINAL" },
    ]);
    assert.deepEqual(
      JSON.parse(
        await readFile(join(packetPath, "review", "provider-response-attempt-2.raw.json"), "utf8"),
      ),
      partial,
    );
    const events = (await readFile(result.runRecordPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events
        .filter((event) => event.type === "CALL_STARTED")
        .map((event) => ({
          attempt: event.attemptNumber,
          endpoint: event.requestedProviderEndpoint,
          stage: event.stage,
        })),
      [
        { attempt: 1, endpoint: null, stage: "PRELIMINARY" },
        { attempt: 2, endpoint: "provider-a/fp4", stage: "FINAL" },
        { attempt: 3, endpoint: "provider-b/bf16", stage: "FINAL" },
      ],
    );
    const failed = events.find((event) => event.type === "CALL_FAILED");
    assert.equal(failed.error.code, "UNPRODUCTIVE_STREAM");
    assert.deepEqual(failed.responseMetadata.usage, {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      cost: null,
    });
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

it("permits only one provider retry across both review stages", async () => {
  const { repositoryPath, packetPath } = await arrangePacket();
  const calls: ReviewProviderRequestV1[] = [];
  const provider: ReviewProviderV1 = {
    auditRequest: mockAuditRequest,
    complete: async (request) => {
      calls.push(request);
      if (calls.length === 1 || request.stage === "FINAL") throw transientFailure();
      return successfulEmptyResponse(request);
    },
  };
  try {
    await assert.rejects(
      () => runTwoStageReviewV1(packetPath, config, provider),
      /Temporarily unavailable/,
    );
    assert.deepEqual(
      calls.map((request) => request.stage),
      ["PRELIMINARY", "PRELIMINARY", "FINAL"],
    );
    assert.deepEqual(calls[0], calls[1]);
    assert.doesNotMatch(JSON.stringify(calls[0]?.messages), /Reported by author/);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

it("does not retry when failed-call usage leaves insufficient tokens or cost", async () => {
  for (const budget of ["tokens", "cost"]) {
    const { repositoryPath, packetPath } = await arrangePacket();
    let calls = 0;
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async () => {
        calls++;
        const error = transientFailure();
        throw new ProviderCallError("PROVIDER_ERROR", "Temporarily unavailable", {
          ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
          responseMetadata: {
            responseId: null,
            model: null,
            provider: null,
            finishReason: "error",
            usage: {
              promptTokens: budget === "tokens" ? config.budgets.maxTotalTokens : 1,
              completionTokens: 0,
              totalTokens: budget === "tokens" ? config.budgets.maxTotalTokens : 1,
              cost: budget === "cost" ? config.budgets.maxTotalCostUsd : 0,
            },
          },
        });
      },
    };
    try {
      await assert.rejects(
        () => runTwoStageReviewV1(packetPath, config, provider),
        /remaining .*budget/,
      );
      assert.equal(calls, 1);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  }
});
