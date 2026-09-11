import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import {
  captureGitSnapshotV1,
  ProviderCallError,
  type ReviewProviderRequestV1,
  type ReviewProviderResponseV1,
  type ReviewProviderV1,
  type ReviewRunConfigV3,
  resumeFinalReviewV1,
  runTwoStageReviewV1,
  writeSnapshotPacketV1,
} from "../../src/index.js";
import { asFinalCandidateV3 } from "../helpers/final-candidate.js";

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
  includeOutOfScopePath = false,
  includeAdditionalSource = false,
  reviewedBefore = "before\n",
  reviewedAfter = "after\n",
): Promise<{ repositoryPath: string; packetPath: string }> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "independent-reviewer-flow-"));
  await git(repositoryPath, "init", "--initial-branch=main");
  await git(repositoryPath, "config", "user.name", "Flow Test");
  await git(repositoryPath, "config", "user.email", "flow@example.invalid");
  await git(repositoryPath, "config", "commit.gpgsign", "false");
  await writeFile(join(repositoryPath, "reviewed.ts"), reviewedBefore);
  await git(repositoryPath, "add", ".");
  await git(repositoryPath, "commit", "-m", "initial");
  await git(repositoryPath, "switch", "-c", "feature/flow");
  await writeFile(join(repositoryPath, "reviewed.ts"), reviewedAfter);
  if (includeExcludedPath) {
    await writeFile(join(repositoryPath, ".env"), "DO_NOT_SEND=secret\n");
  }
  if (includeOutOfScopePath) {
    await writeFile(join(repositoryPath, "notes.md"), "Documentation only.\n");
  }
  if (includeAdditionalSource) {
    await writeFile(join(repositoryPath, "second.ts"), "additional change\n");
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
      componentWalkthrough: [{ component: "reviewed.ts", changes: "Changed one line." }],
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

const config: ReviewRunConfigV3 = {
  schemaVersion: 3,
  configId: "config_test",
  model: "mock/reviewer",
  fallbackModels: [],
  providerRouting: {
    order: ["provider-a/fp4", "provider-b/bf16"],
    pinToOrder: false,
    zeroDataRetention: false,
    denyDataCollection: false,
    maxPrice: { prompt: 0.5, completion: 1.5, request: 0 },
  },
  budgets: {
    maxInitialEvidenceBytes: 32_000,
    maxConversationBytes: 128_000,
    maxOutputTokensPerCall: 1_000,
    maxTotalTokens: 100_000,
    maxTotalCostUsd: 1,
    timeoutMs: 10_000,
    maxAttemptsPerCall: 2,
    minimumCallIntervalMs: 0,
  },
};

function response(value: unknown, totalTokens = 100): ReviewProviderResponseV1 {
  value = asFinalCandidateV3(value);
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

function confirmedFindingVerificationResponse(
  request: ReviewProviderRequestV1,
): ReviewProviderResponseV1 {
  const input = JSON.parse(request.messages[1]?.content ?? "{}");
  return response({
    schemaVersion: 1,
    stage: "FINDING_VERIFICATION",
    snapshotDigest: input.blindReviewEvidence.snapshotManifest.snapshotDigest,
    briefDigest: input.blindReviewEvidence.briefDigest,
    assessments: input.preliminaryAssessment.findings.map((finding: { id: string }) => ({
      preliminaryFindingId: finding.id,
      status: "CONFIRMED",
      rationale: "The cited changed evidence supports this in-scope finding.",
    })),
  });
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
        path: "reviewed.ts",
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
  it("uses a fresh blind verifier and enforces rejection before author reconciliation", async () => {
    const { repositoryPath, packetPath } = await arrangePacket(
      false,
      "AUTHOR_SECRET",
      undefined,
      undefined,
      false,
      false,
      "export function page(items, pageNumber, pageSize) { return items.slice(0, pageSize); }\n",
      "export function page(items, pageNumber, pageSize) { const end = pageSize; return items.slice(0, end); }\n",
    );
    const calls: ReviewProviderRequestV1[] = [];
    let finalCalls = 0;
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
            summary: "The function does not reject page zero.",
            inspectedPaths: ["reviewed.ts"],
            canonicalInputCoverage: canonicalInputCoverage(),
            findings: [
              {
                id: "finding_invalid_domain",
                severity: "P1",
                title: "Missing page-number validation",
                scenario: "Calling page with pageNumber zero returns a value.",
                impact: "The caller can supply an invalid page number.",
                evidence: [
                  {
                    path: "reviewed.ts",
                    anchor: "LINE_RANGE",
                    side: "HEAD",
                    startLine: 1,
                    endLine: 1,
                    detail: "The function does not reject page zero.",
                  },
                ],
                correction: "Reject page zero.",
              },
            ],
            evidenceGaps: [],
            limitations: [],
            nextAction: "REQUEST_AUTHOR_PACKET",
          });
        }
        if (providerRequest.stage === "FINDING_VERIFICATION") {
          assert.doesNotMatch(JSON.stringify(providerRequest), /AUTHOR_SECRET/);
          assert.equal(providerRequest.messages.length, 2);
          const input = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
          assert.equal(input.preliminaryAssessment.findings[0].id, "finding_invalid_domain");
          return response({
            schemaVersion: 1,
            stage: "FINDING_VERIFICATION",
            snapshotDigest: input.blindReviewEvidence.snapshotManifest.snapshotDigest,
            briefDigest: input.blindReviewEvidence.briefDigest,
            assessments: [
              {
                preliminaryFindingId: "finding_invalid_domain",
                status: "REJECTED",
                rationale:
                  "Page zero is outside the stated valid input domain and no validation behavior is required.",
              },
            ],
          });
        }
        assert.match(JSON.stringify(providerRequest), /AUTHOR_SECRET/);
        assert.match(JSON.stringify(providerRequest), /FINDING_VERIFICATION/);
        finalCalls += 1;
        if (finalCalls === 1) {
          return response({
            schemaVersion: 1,
            stage: "FINAL",
            snapshotDigest: brief.snapshotManifest.snapshotDigest,
            briefDigest: brief.briefDigest,
            summary: "The preliminary finding remains.",
            findings: [
              {
                ...brief.preliminaryAssessment?.findings?.[0],
                id: "finding_invalid_domain",
                severity: "P1",
                title: "Missing page-number validation",
                scenario: "Calling page with pageNumber zero returns a value.",
                impact: "The caller can supply an invalid page number.",
                evidence: [
                  {
                    path: "reviewed.ts",
                    anchor: "LINE_RANGE",
                    side: "HEAD",
                    startLine: 1,
                    endLine: 1,
                    detail: "The function does not reject page zero.",
                  },
                ],
                correction: "Reject page zero.",
                origin: "PRELIMINARY",
                emergenceRationale: null,
              },
            ],
            preliminaryFindingDispositions: [
              {
                preliminaryFindingId: "finding_invalid_domain",
                disposition: "RETAINED",
                finalFindingId: "finding_invalid_domain",
                rationale: "The code still permits page zero.",
              },
            ],
            ...finalCoverage(),
            authorClaims: [],
            limitations: [],
            verdict: "NOT_READY",
            nextActions: { blockers: ["Reject page zero."], fastFollows: [] },
          });
        }
        assert.match(JSON.stringify(providerRequest.messages), /FINAL_OUTPUT_REPAIR/);
        assert.match(
          JSON.stringify(providerRequest.messages),
          /Adversarially rejected preliminary finding must be withdrawn/,
        );
        return response({
          schemaVersion: 3,
          stage: "FINAL",
          snapshotDigest: brief.snapshotManifest.snapshotDigest,
          briefDigest: brief.briefDigest,
          summary: "No supported defect remains.",
          findings: [],
          withdrawnPreliminaryFindings: [
            {
              preliminaryFindingId: "finding_invalid_domain",
              rationale: "Fresh verification showed that the scenario is outside contract scope.",
            },
          ],
          authorClaims: [],
          authorVerificationClaims: finalCoverage().authorVerificationClaims,
          preliminaryConcernDispositions: [],
          limitations: [],
          verdict: "READY",
          nextActions: { blockers: [], fastFollows: [] },
        });
      },
    };

    try {
      const result = await runTwoStageReviewV1(packetPath, config, provider);
      assert.equal(result.report.verdict, "READY");
      assert.deepEqual(
        calls.map((call) => call.stage),
        ["PRELIMINARY", "FINDING_VERIFICATION", "FINAL", "FINAL"],
      );
      await readFile(join(packetPath, "review", "finding-verification.json"), "utf8");
      await readFile(
        join(packetPath, "review", "finding-verification-provider-response.json"),
        "utf8",
      );
      await readFile(join(packetPath, "review", "final-repair-provider-response.json"), "utf8");
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("fails closed before author disclosure when verification does not cover exact findings", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    const calls: ReviewProviderRequestV1[] = [];
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async (providerRequest) => {
        calls.push(providerRequest);
        const input = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
        if (providerRequest.stage === "PRELIMINARY") {
          return response({
            schemaVersion: 1,
            stage: "PRELIMINARY",
            snapshotDigest: input.snapshotManifest.snapshotDigest,
            briefDigest: input.briefDigest,
            summary: "One candidate defect requires verification.",
            inspectedPaths: ["reviewed.ts"],
            canonicalInputCoverage: canonicalInputCoverage(),
            findings: [
              {
                id: "finding_expected",
                severity: "P2",
                title: "Changed behavior",
                scenario: "The changed path returns a different value.",
                impact: "The requirement may not be met.",
                evidence: [
                  {
                    path: "reviewed.ts",
                    anchor: "LINE_RANGE",
                    side: "HEAD",
                    startLine: 1,
                    endLine: 1,
                    detail: "The changed value appears on line one.",
                  },
                ],
                correction: "Restore the required behavior.",
              },
            ],
            evidenceGaps: [],
            limitations: [],
            nextAction: "REQUEST_AUTHOR_PACKET",
          });
        }
        assert.equal(providerRequest.stage, "FINDING_VERIFICATION");
        assert.doesNotMatch(JSON.stringify(providerRequest), /AUTHOR_SECRET/);
        return response({
          schemaVersion: 1,
          stage: "FINDING_VERIFICATION",
          snapshotDigest: input.blindReviewEvidence.snapshotManifest.snapshotDigest,
          briefDigest: input.blindReviewEvidence.briefDigest,
          assessments: [
            {
              preliminaryFindingId: "finding_unknown",
              status: "CONFIRMED",
              rationale: "This identifier was not present in the preliminary assessment.",
            },
          ],
        });
      },
    };

    try {
      await assert.rejects(
        () => runTwoStageReviewV1(packetPath, config, provider),
        /finding verification must assess every preliminary finding exactly once/i,
      );
      assert.deepEqual(
        calls.map((call) => call.stage),
        ["PRELIMINARY", "FINDING_VERIFICATION"],
      );
      const events = (await readFile(join(packetPath, "review", "run-record.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        events.some((event) => event.type === "AUTHOR_DELIVERED"),
        false,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("completes a clean review without repairing model-owned bookkeeping", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    const calls: ReviewProviderRequestV1[] = [];
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
            summary: "No defect was found in the changed behavior.",
            inspectedPaths: ["reviewed.ts"],
            canonicalInputCoverage: canonicalInputCoverage(),
            findings: [],
            evidenceGaps: [],
            limitations: [],
            nextAction: "REQUEST_AUTHOR_PACKET",
          });
        }
        return response({
          schemaVersion: 3,
          stage: "FINAL",
          snapshotDigest: brief.snapshotManifest.snapshotDigest,
          briefDigest: brief.briefDigest,
          summary: "The change satisfies the supplied requirements.",
          findings: [],
          withdrawnPreliminaryFindings: [],
          authorClaims: [],
          authorVerificationClaims: finalCoverage().authorVerificationClaims,
          preliminaryConcernDispositions: [],
          limitations: [],
          verdict: "NOT_READY",
          nextActions: {
            blockers: ["Run the author-reported tests before approval."],
            fastFollows: [],
          },
        });
      },
    };

    try {
      const result = await runTwoStageReviewV1(packetPath, config, provider);

      assert.equal(result.report.verdict, "READY");
      assert.deepEqual(result.report.nextActions.blockers, []);
      assert.deepEqual(
        calls.map((call) => call.stage),
        ["PRELIMINARY", "FINAL"],
      );
      const rawFinal = JSON.parse(
        await readFile(join(packetPath, "review", "final-provider-response.json"), "utf8"),
      );
      assert.match(rawFinal.rawContent, /Run the author-reported tests before approval/);
      const persistedFinal = JSON.parse(await readFile(result.finalPath, "utf8"));
      assert.equal(persistedFinal.verdict, "READY");
      assert.deepEqual(persistedFinal.nextActions.blockers, []);
      const events = (await readFile(result.runRecordPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        events.some(
          (event) =>
            event.type === "FINAL_CANDIDATE_REJECTED" || event.type === "FINAL_REPAIR_REQUESTED",
        ),
        false,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("repairs one invalid preliminary candidate before revealing author context", async () => {
    const before = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");
    const afterLines = before.split("\n");
    afterLines[41] = "changed line 42";
    const { repositoryPath, packetPath } = await arrangePacket(
      false,
      "AUTHOR_SECRET",
      undefined,
      undefined,
      false,
      false,
      `${before}\n`,
      `${afterLines.join("\n")}\n`,
    );
    const calls: ReviewProviderRequestV1[] = [];
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async (providerRequest) => {
        calls.push(providerRequest);
        const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
        if (providerRequest.stage === "PRELIMINARY") {
          assert.equal(brief.reviewUnitPlan.schemaVersion, 1);
          assert.equal(brief.reviewUnitPlan.units[0]?.targetPaths[0], "reviewed.ts");
          assert.equal(brief.reviewContext.regions.length > 0, true);
          assert.equal(brief.reviewContext.producers.length > 0, true);
          assert.equal(
            brief.reviewContext.producers.every(
              (producer: { status?: string; diagnostics?: unknown[] }) =>
                typeof producer.status === "string" && Array.isArray(producer.diagnostics),
            ),
            true,
          );
          assert.equal(
            brief.reviewContext.regions.every(
              (region: { producerId?: string }) => typeof region.producerId === "string",
            ),
            true,
          );
          assert.doesNotMatch(JSON.stringify(providerRequest), /AUTHOR_SECRET/);
          if (calls.length === 1) {
            return {
              ...response({
                schemaVersion: 1,
                stage: "PRELIMINARY",
                snapshotDigest: brief.snapshotManifest.snapshotDigest,
                briefDigest: brief.briefDigest,
                summary: "The change has a blocking defect.",
                inspectedPaths: ["reviewed.ts"],
                canonicalInputCoverage: canonicalInputCoverage(),
                findings: [
                  {
                    id: "finding_unseen_line",
                    severity: "P1",
                    title: "Unsupported finding",
                    scenario: "The reviewer cites source it was not sent.",
                    impact: "The claimed evidence cannot support the finding.",
                    evidence: [
                      {
                        path: "reviewed.ts",
                        anchor: "LINE_RANGE",
                        side: "HEAD",
                        startLine: 10,
                        endLine: 10,
                        detail: "Line 10 allegedly proves the defect.",
                      },
                    ],
                    correction: "Cite transmitted changed evidence.",
                  },
                ],
                evidenceGaps: [],
                limitations: [],
                nextAction: "REQUEST_AUTHOR_PACKET",
              }),
              model: "fallback/reviewer",
            };
          }
          assert.deepEqual(providerRequest.models, ["fallback/reviewer"]);
          assert.match(JSON.stringify(providerRequest.messages), /PRELIMINARY_OUTPUT_REPAIR/);
          assert.match(
            JSON.stringify(providerRequest.messages),
            /not included in transmitted evidence/i,
          );
          return {
            ...response({
              schemaVersion: 1,
              stage: "PRELIMINARY",
              snapshotDigest: brief.snapshotManifest.snapshotDigest,
              briefDigest: brief.briefDigest,
              summary: "No supported defect was found.",
              inspectedPaths: ["reviewed.ts"],
              canonicalInputCoverage: canonicalInputCoverage(),
              findings: [],
              evidenceGaps: [],
              limitations: [],
              nextAction: "REQUEST_AUTHOR_PACKET",
            }),
            model: "fallback/reviewer",
          };
        }
        assert.match(JSON.stringify(providerRequest), /AUTHOR_SECRET/);
        assert.doesNotMatch(providerRequest.messages.at(-2)?.content ?? "", /finding_unseen_line/);
        return response({
          schemaVersion: 3,
          stage: "FINAL",
          snapshotDigest: brief.snapshotManifest.snapshotDigest,
          briefDigest: brief.briefDigest,
          summary: "No defect remains after reconciliation.",
          findings: [],
          withdrawnPreliminaryFindings: [],
          authorClaims: [],
          authorVerificationClaims: finalCoverage().authorVerificationClaims,
          preliminaryConcernDispositions: [],
          limitations: [],
          verdict: "READY",
          nextActions: { blockers: [], fastFollows: [] },
        });
      },
    };

    try {
      const result = await runTwoStageReviewV1(
        packetPath,
        { ...config, fallbackModels: ["fallback/reviewer"] },
        provider,
      );

      assert.equal(result.report.verdict, "READY");
      assert.deepEqual(
        calls.map((call) => call.stage),
        ["PRELIMINARY", "PRELIMINARY", "FINAL"],
      );
      await readFile(join(packetPath, "review", "review-unit-plan.json"), "utf8");
      await readFile(
        join(packetPath, "review", "preliminary-repair-provider-response.json"),
        "utf8",
      );
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
          "PRELIMINARY_CANDIDATE_REJECTED",
          "PRELIMINARY_REPAIR_REQUESTED",
          "CALL_STARTED",
          "CALL_SUCCEEDED",
          "PRELIMINARY_PERSISTED",
          "FINDING_VERIFICATION_PERSISTED",
          "AUTHOR_DELIVERED",
          "CALL_STARTED",
          "CALL_SUCCEEDED",
          "RUN_COMPLETED",
        ],
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("does not buy a preliminary repair for a local frozen-evidence failure", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    let calls = 0;
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async (providerRequest) => {
        calls += 1;
        const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
        const manifest = JSON.parse(
          await readFile(join(packetPath, "snapshot-manifest.json"), "utf8"),
        );
        await writeFile(
          join(packetPath, "blobs", manifest.paths[0].after.digest.value),
          "tampered\n",
        );
        return response({
          schemaVersion: 1,
          stage: "PRELIMINARY",
          snapshotDigest: brief.snapshotManifest.snapshotDigest,
          briefDigest: brief.briefDigest,
          summary: "The changed line has a defect.",
          inspectedPaths: ["reviewed.ts"],
          canonicalInputCoverage: canonicalInputCoverage(),
          findings: [
            {
              id: "finding_valid_anchor",
              severity: "P2",
              title: "Changed behavior",
              scenario: "The changed input produces the wrong result.",
              impact: "The caller receives an incorrect value.",
              evidence: [
                {
                  path: "reviewed.ts",
                  anchor: "LINE_RANGE",
                  side: "HEAD",
                  startLine: 1,
                  endLine: 1,
                  detail: "The changed line produces the result.",
                },
              ],
              correction: "Return the expected value.",
            },
          ],
          evidenceGaps: [],
          limitations: [],
          nextAction: "REQUEST_AUTHOR_PACKET",
        });
      },
    };

    try {
      await assert.rejects(
        () => runTwoStageReviewV1(packetPath, config, provider),
        /captured evidence could not be validated locally/i,
      );
      assert.equal(calls, 1);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("does not buy a preliminary repair after usage consumes mandatory remaining calls", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    let calls = 0;
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async () => {
        calls += 1;
        return response({ verdict: "READY" }, 70_000);
      },
    };

    try {
      await assert.rejects(
        () => runTwoStageReviewV1(packetPath, config, provider),
        /provider-reported usage exceeded the total token budget/i,
      );
      assert.equal(calls, 1);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("rejects a frozen line citation after one bounded preliminary repair", async () => {
    const before = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");
    const afterLines = before.split("\n");
    afterLines[41] = "changed line 42";
    const { repositoryPath, packetPath } = await arrangePacket(
      false,
      "AUTHOR_SECRET",
      undefined,
      undefined,
      false,
      false,
      `${before}\n`,
      `${afterLines.join("\n")}\n`,
    );
    let calls = 0;
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async (providerRequest) => {
        calls += 1;
        assert.equal(providerRequest.stage, "PRELIMINARY");
        const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
        assert.match(brief.initialEvidence[0].content, /changed line 42/);
        assert.doesNotMatch(brief.initialEvidence[0].content, /line 10/);
        return response({
          schemaVersion: 1,
          stage: "PRELIMINARY",
          snapshotDigest: brief.snapshotManifest.snapshotDigest,
          briefDigest: brief.briefDigest,
          summary: "The change has a blocking defect.",
          inspectedPaths: ["reviewed.ts"],
          canonicalInputCoverage: canonicalInputCoverage(),
          findings: [
            {
              id: "finding_unseen_line",
              severity: "P1",
              title: "Unsupported finding",
              scenario: "The reviewer cites source it was not sent.",
              impact: "The claimed evidence cannot support the finding.",
              evidence: [
                {
                  path: "reviewed.ts",
                  anchor: "LINE_RANGE",
                  side: "HEAD",
                  startLine: 10,
                  endLine: 10,
                  detail: "Line 10 allegedly proves the defect.",
                },
              ],
              correction: "Cite transmitted changed evidence.",
            },
          ],
          evidenceGaps: [],
          limitations: [],
          nextAction: "REQUEST_AUTHOR_PACKET",
        });
      },
    };

    try {
      await assert.rejects(
        () => runTwoStageReviewV1(packetPath, config, provider),
        /not included in transmitted evidence/i,
      );
      assert.equal(calls, 2);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("assembles exact final coverage from frozen scope without asking the model to repeat ledgers", async () => {
    const { repositoryPath, packetPath } = await arrangePacket(
      false,
      "AUTHOR_SECRET",
      undefined,
      undefined,
      true,
      true,
    );
    const calls: ReviewProviderRequestV1[] = [];
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
            summary: "Only the source file was inspected.",
            inspectedPaths: ["reviewed.ts"],
            canonicalInputCoverage: canonicalInputCoverage(),
            findings: [],
            evidenceGaps: [],
            limitations: [],
            nextAction: "REQUEST_AUTHOR_PACKET",
          });
        }
        const properties = valueAtPath(providerRequest.responseSchema.schema, [
          "properties",
        ]) as Record<string, unknown>;
        assert.equal("changedPathCoverage" in properties, false);
        assert.equal("canonicalInputCoverage" in properties, false);
        return response({
          schemaVersion: 3,
          stage: "FINAL",
          snapshotDigest: brief.snapshotManifest.snapshotDigest,
          briefDigest: brief.briefDigest,
          summary: "No defect was found in the inspected source.",
          findings: [],
          withdrawnPreliminaryFindings: [],
          preliminaryConcernDispositions: [],
          authorClaims: [],
          authorVerificationClaims: [
            {
              claimIndex: 0,
              status: "UNVERIFIED",
              explanation: "The reviewer did not run the author-reported command.",
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
      assert.equal(result.report.verdict, "UNABLE_TO_VERIFY");
      assert.deepEqual(
        result.report.changedPathCoverage.map(({ path, status }) => ({ path, status })),
        [
          { path: "reviewed.ts", status: "INSPECTED" },
          { path: "second.ts", status: "UNASSESSED" },
        ],
      );
      assert.deepEqual(result.report.canonicalInputCoverage, canonicalInputCoverage());
      assert.match(result.report.limitations.join("\n"), /second\.ts/);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("persists the blind assessment before revealing the author packet", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    const calls: ReviewProviderRequestV1[] = [];
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async (providerRequest) => {
        calls.push(providerRequest);
        if (providerRequest.stage === "PRELIMINARY") {
          assert.doesNotMatch(JSON.stringify(providerRequest), /AUTHOR_SECRET/);
          assert.match(
            providerRequest.messages[0]?.content ?? "",
            /referencedSources.*context, not a review target.*never report a finding against.*never cite/s,
          );
          const blindEvidence = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
          assert.deepEqual(blindEvidence.requiredCoverage, {
            changedPaths: ["reviewed.ts"],
            canonicalInputIds: ["input_requirement", "input_plan"],
          });
          assert.match(
            blindEvidence.initialEvidence[0].content,
            /--- BASE\/reviewed\.ts\n\+\+\+ HEAD\/reviewed\.ts\n@@ -1,1 \+1,1 @@\n-before\n\+after/,
          );
          assert.match(blindEvidence.initialEvidence[0].content, /Evidence form: WHOLE_FILE/);
          return response({
            schemaVersion: 1,
            stage: "PRELIMINARY",
            snapshotDigest: blindEvidence.snapshotManifest.snapshotDigest,
            briefDigest: blindEvidence.briefDigest,
            summary: "The one-file change is understandable.",
            inspectedPaths: ["reviewed.ts"],
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
          "FINDING_VERIFICATION_PERSISTED",
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
          assert.deepEqual(valueAtPath(variant, ["properties", "path", "enum"]), ["reviewed.ts"]);
        }
        const properties = valueAtPath(call.responseSchema.schema, ["properties"]) as Record<
          string,
          unknown
        >;
        if (call.stage === "PRELIMINARY") {
          const canonicalCoverage = properties.canonicalInputCoverage as Record<string, unknown>;
          assert.equal(canonicalCoverage.minItems, 2);
          assert.equal(canonicalCoverage.maxItems, 2);
          assert.deepEqual(
            valueAtPath(canonicalCoverage, ["items", "properties", "canonicalInputId", "enum"]),
            ["input_plan", "input_requirement"],
          );
        } else {
          assert.equal("canonicalInputCoverage" in properties, false);
        }
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
          assert.equal("changedPathCoverage" in properties, false);
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
          path: "reviewed.ts",
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
            inspectedPaths: ["reviewed.ts"],
            canonicalInputCoverage: canonicalInputCoverage(),
            findings: [finding],
            evidenceGaps: [],
            limitations: [],
            nextAction: "REQUEST_AUTHOR_PACKET",
          });
        }
        if (providerRequest.stage === "FINDING_VERIFICATION") {
          return confirmedFindingVerificationResponse(providerRequest);
        }
        const isRepair = JSON.stringify(providerRequest.messages).includes("FINAL_OUTPUT_REPAIR");
        if (isRepair) {
          assert.deepEqual(providerRequest.models, ["fallback/reviewer"]);
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
        return {
          ...response({
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
          }),
          model: "fallback/reviewer",
        };
      },
    };

    try {
      const result = await runTwoStageReviewV1(
        packetPath,
        { ...config, fallbackModels: ["fallback/reviewer"] },
        provider,
      );

      assert.equal(result.report.verdict, "NOT_READY");
      assert.equal(calls.length, 4);
      assert.deepEqual(
        calls.map((call) => call.stage),
        ["PRELIMINARY", "FINDING_VERIFICATION", "FINAL", "FINAL"],
      );
      assert.match(JSON.stringify(calls[3]?.messages), /FINAL_OUTPUT_REPAIR/);
      assert.match(JSON.stringify(calls[3]?.messages), /finding_missing/);
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
          "CALL_STARTED",
          "CALL_SUCCEEDED",
          "FINDING_VERIFICATION_PERSISTED",
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
            inspectedPaths: ["reviewed.ts"],
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
      assert.equal(calls, 2);
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

  it("retries an uncertain transport and persists a durable attempt and terminal record", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    const provider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async () => {
        throw new ProviderCallError("TRANSPORT_UNCERTAIN", "The request may have been submitted.");
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

      // An inference call is idempotent, so an uncertain submission is reissued rather than
      // failing the run. The uncertain attempt is still charged the full conservative
      // reservation before the retry is admitted, so a double submission cannot be free.
      assert.deepEqual(
        events.map((event) => event.type),
        [
          "RUN_STARTED",
          "CALL_STARTED",
          "CALL_FAILED",
          "PROVIDER_RETRY_REQUESTED",
          "CALL_STARTED",
          "CALL_FAILED",
          "RUN_FAILED",
        ],
      );
      assert.equal(events[1]?.stage, "PRELIMINARY");
      assert.equal(events[2]?.error.code, "TRANSPORT_UNCERTAIN");
      assert.ok(events[3]?.chargedFailedTokens > 0);
      assert.equal(events.at(-1)?.terminalState, "TRANSPORT_UNCERTAIN");
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

  it("resumes only the failed final stage after a repaired preliminary", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    let preliminaryCalls = 0;
    const firstProvider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async (providerRequest) => {
        const brief = JSON.parse(providerRequest.messages[1]?.content ?? "{}");
        if (providerRequest.stage === "PRELIMINARY") {
          preliminaryCalls += 1;
          if (preliminaryCalls === 1) {
            return response({ verdict: "READY" });
          }
          return {
            ...response({
              schemaVersion: 1,
              stage: "PRELIMINARY",
              snapshotDigest: brief.snapshotManifest.snapshotDigest,
              briefDigest: brief.briefDigest,
              summary: "The change was inspected before the final provider failure.",
              inspectedPaths: ["reviewed.ts"],
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

      const rejectedProviderPath = join(packetPath, "review", "preliminary-provider-response.json");
      const rejectedProviderDocument = await readFile(rejectedProviderPath, "utf8");
      const tamperedRejectedProvider = JSON.parse(rejectedProviderDocument);
      tamperedRejectedProvider.rawContent = "{}";
      await writeFile(rejectedProviderPath, `${JSON.stringify(tamperedRejectedProvider)}\n`);
      await assert.rejects(
        () => resumeFinalReviewV1(packetPath, config, resumedProvider),
        /preliminary repair.*input digest/i,
      );
      assert.equal(resumedCalls.length, 0);
      await writeFile(rejectedProviderPath, rejectedProviderDocument);

      const runRecordPath = join(packetPath, "review", "run-record.jsonl");
      const originalRunRecord = await readFile(runRecordPath, "utf8");
      const pointerEvents = originalRunRecord
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const preliminaryPersisted = pointerEvents.find(
        (event) => event.type === "PRELIMINARY_PERSISTED",
      );
      preliminaryPersisted.acceptedAttemptNumber = 1;
      await writeFile(
        runRecordPath,
        `${pointerEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
      );
      await assert.rejects(
        () => resumeFinalReviewV1(packetPath, config, resumedProvider),
        /persisted run state is not eligible/i,
      );
      assert.equal(resumedCalls.length, 0);
      await writeFile(runRecordPath, originalRunRecord);

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
          failedAttemptNumber: 3,
          claimedAttemptNumber: 4,
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
          "PRELIMINARY_CANDIDATE_REJECTED",
          "PRELIMINARY_REPAIR_REQUESTED",
          "CALL_STARTED",
          "CALL_SUCCEEDED",
          "PRELIMINARY_PERSISTED",
          "FINDING_VERIFICATION_PERSISTED",
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
        [1, 2, 3, 4],
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

  it("reuses persisted finding verification when resuming a failed final stage", async () => {
    const { repositoryPath, packetPath } = await arrangePacket();
    const finding = {
      id: "finding_resume",
      severity: "P2" as const,
      title: "Changed behavior",
      scenario: "The changed path returns a different value.",
      impact: "The caller receives an unexpected value.",
      evidence: [
        {
          path: "reviewed.ts",
          anchor: "LINE_RANGE" as const,
          side: "HEAD" as const,
          startLine: 1,
          endLine: 1,
          detail: "The changed value appears on line one.",
        },
      ],
      correction: "Restore the expected value.",
    };
    const initialCalls: ReviewProviderRequestV1[] = [];
    const initialProvider: ReviewProviderV1 = {
      auditRequest: mockAuditRequest,
      complete: async (request) => {
        initialCalls.push(request);
        const input = JSON.parse(request.messages[1]?.content ?? "{}");
        if (request.stage === "PRELIMINARY") {
          return response({
            schemaVersion: 1,
            stage: "PRELIMINARY",
            snapshotDigest: input.snapshotManifest.snapshotDigest,
            briefDigest: input.briefDigest,
            summary: "The changed behavior has one defect.",
            inspectedPaths: ["reviewed.ts"],
            canonicalInputCoverage: canonicalInputCoverage(),
            findings: [finding],
            evidenceGaps: [],
            limitations: [],
            nextAction: "REQUEST_AUTHOR_PACKET",
          });
        }
        if (request.stage === "FINDING_VERIFICATION") {
          return confirmedFindingVerificationResponse(request);
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
      await assert.rejects(
        () => runTwoStageReviewV1(packetPath, config, initialProvider),
        /rate limit/i,
      );
      assert.deepEqual(
        initialCalls.map((call) => call.stage),
        ["PRELIMINARY", "FINDING_VERIFICATION", "FINAL"],
      );
      const persistedVerification = await readFile(
        join(packetPath, "review", "finding-verification.json"),
        "utf8",
      );
      const resumedCalls: ReviewProviderRequestV1[] = [];
      const resumedProvider: ReviewProviderV1 = {
        auditRequest: mockAuditRequest,
        complete: async (request) => {
          resumedCalls.push(request);
          const brief = JSON.parse(request.messages[1]?.content ?? "{}");
          return response({
            schemaVersion: 1,
            stage: "FINAL",
            snapshotDigest: brief.snapshotManifest.snapshotDigest,
            briefDigest: brief.briefDigest,
            summary: "The verified finding remains unresolved.",
            findings: [
              {
                ...finding,
                origin: "PRELIMINARY",
                emergenceRationale: null,
              },
            ],
            preliminaryFindingDispositions: [
              {
                preliminaryFindingId: finding.id,
                disposition: "RETAINED",
                finalFindingId: finding.id,
                rationale: "Fresh verification confirmed the changed behavior.",
              },
            ],
            ...finalCoverage(),
            authorClaims: [],
            limitations: [],
            verdict: "READY_WITH_FOLLOW_UPS",
            nextActions: { blockers: [], fastFollows: [finding.correction] },
          });
        },
      };
      const runRecordPath = join(packetPath, "review", "run-record.jsonl");
      const originalRunRecord = await readFile(runRecordPath, "utf8");
      const tamperedEvents = originalRunRecord
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const verificationStarted = tamperedEvents.find(
        (event) => event.type === "CALL_STARTED" && event.stage === "FINDING_VERIFICATION",
      );
      verificationStarted.promptVersion = "finding-verification-policy-old";
      await writeFile(
        runRecordPath,
        `${tamperedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
      );
      await assert.rejects(
        () => resumeFinalReviewV1(packetPath, config, resumedProvider),
        /persisted finding-verification request is invalid/i,
      );
      assert.equal(resumedCalls.length, 0);
      await writeFile(runRecordPath, originalRunRecord);

      const result = await resumeFinalReviewV1(packetPath, config, resumedProvider);

      assert.equal(result.report.verdict, "READY_WITH_FOLLOW_UPS");
      assert.deepEqual(
        resumedCalls.map((call) => call.stage),
        ["FINAL"],
      );
      assert.match(JSON.stringify(resumedCalls[0]?.messages), /finding_resume/);
      assert.equal(
        await readFile(join(packetPath, "review", "finding-verification.json"), "utf8"),
        persistedVerification,
      );
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
            inspectedPaths: ["reviewed.ts"],
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
                  inspectedPaths: ["reviewed.ts"],
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
            inspectedPaths: ["reviewed.ts"],
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
            maxTotalTokens: 195_000,
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
            inspectedPaths: ["reviewed.ts"],
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
            inspectedPaths: ["reviewed.ts"],
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
          inspectedPaths: ["reviewed.ts"],
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

  it("derives Unable to verify when changed evidence was excluded", async () => {
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
            inspectedPaths: ["reviewed.ts"],
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
      const result = await runTwoStageReviewV1(packetPath, config, provider);
      assert.equal(result.report.verdict, "UNABLE_TO_VERIFY");
      assert.match(
        result.report.limitations.join("\n"),
        /Runner snapshot coverage constraint \(EXCLUDED_PATH\)/,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("accepts Ready when runner-classified paths are explicitly out of scope", async () => {
    const { repositoryPath, packetPath } = await arrangePacket(
      false,
      "AUTHOR_SECRET: make the requested change.",
      undefined,
      "Reported by author.",
      true,
    );
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
            summary: "The reviewable source change was inspected.",
            inspectedPaths: ["reviewed.ts"],
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
          summary: "The selected source scope is ready.",
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
      const result = await runTwoStageReviewV1(packetPath, config, provider);
      assert.equal(result.report.verdict, "READY");
      const markdown = await readFile(result.markdownPath, "utf8");
      assert.match(markdown, /Out-of-scope paths/);
      assert.match(markdown, /notes\\\.md/);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("rejects model-authored final coverage fields", async () => {
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
            inspectedPaths: ["reviewed.ts"],
            canonicalInputCoverage: canonicalInputCoverage(),
            findings: [],
            evidenceGaps: [],
            limitations: [],
            nextAction: "REQUEST_AUTHOR_PACKET",
          });
        }
        return response({
          schemaVersion: 3,
          stage: "FINAL",
          snapshotDigest: brief.snapshotManifest.snapshotDigest,
          briefDigest: brief.briefDigest,
          summary: "The reviewer omitted the real path from its coverage ledger.",
          findings: [],
          withdrawnPreliminaryFindings: [],
          preliminaryConcernDispositions: [],
          authorVerificationClaims: [
            {
              claimIndex: 0,
              status: "UNVERIFIED",
              explanation: "The reviewer did not run the author-reported command.",
            },
          ],
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
        /changedPathCoverage|unrecognized key/i,
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
            inspectedPaths: ["reviewed.ts"],
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
                  path: "reviewed.ts",
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
          inspectedPaths: ["reviewed.ts"],
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

it("charges persisted transport retries when admitting a final-stage resume", async () => {
  const { repositoryPath, packetPath } = await arrangePacket();
  let finalAttempts = 0;
  const firstProvider: ReviewProviderV1 = {
    auditRequest: mockAuditRequest,
    complete: async (request) => {
      if (request.stage === "PRELIMINARY") return successfulEmptyResponse(request);
      finalAttempts += 1;
      if (finalAttempts === 1) {
        throw new ProviderCallError("INVALID_RESPONSE", "Malformed provider response.", {
          retryable: true,
          diagnostic: {
            httpStatus: 503,
            providerErrorCode: "503",
            providerMessage: "Temporarily unavailable",
            errorType: null,
            providerCode: null,
            providerName: "mock",
            model: "mock/reviewer",
            responseId: "failed-with-usage",
            retryAfter: "0",
          },
          responseMetadata: {
            responseId: "failed-with-usage",
            model: "mock/reviewer",
            provider: "mock",
            finishReason: "error",
            usage: {
              promptTokens: 79_999,
              completionTokens: 1,
              totalTokens: 80_000,
              cost: null,
            },
          },
        });
      }
      throw new ProviderCallError("PROVIDER_ERROR", "OpenRouter rate limit exceeded.", {
        diagnostic: {
          httpStatus: 429,
          providerErrorCode: "429",
          providerMessage: "Rate limit exceeded",
          errorType: "rate_limit_exceeded",
          providerCode: "rate_limited",
          providerName: "mock",
          model: "mock/reviewer",
          responseId: null,
          retryAfter: "45",
        },
      });
    },
  };

  try {
    await assert.rejects(() => runTwoStageReviewV1(packetPath, config, firstProvider), /rate/i);
    let resumeCalls = 0;
    await assert.rejects(
      () =>
        resumeFinalReviewV1(packetPath, config, {
          auditRequest: mockAuditRequest,
          complete: async (request) => {
            resumeCalls += 1;
            return successfulEmptyResponse(request);
          },
        }),
      /remaining token budget cannot reserve the final review call/i,
    );
    assert.equal(resumeCalls, 0);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

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
      // The provider rejected the request without reporting usage, so nothing was generated and
      // the failure must not consume the reservation that pays for the retry.
      assert.equal(retry.chargedFailedTokens, 0);
      assert.equal(retry.chargedFailedCostUsd, 0);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

it("retries a rate-limited final call on another endpoint without charging it for tokens", async () => {
  const { repositoryPath, packetPath } = await arrangePacket();
  const calls: Array<{ endpoint: string | null; stage: string }> = [];
  const secondary: ReviewProviderV1 = {
    auditRequest: (providerRequest) => ({
      ...mockAuditRequest(providerRequest),
      preferredProviderEndpoints: ["provider-a/fp4", "provider-b/bf16"],
      excludedProviderEndpoints: ["provider-a"],
    }),
    complete: async (providerRequest) => {
      calls.push({ endpoint: "provider-b/bf16", stage: providerRequest.stage });
      return successfulEmptyResponse(providerRequest);
    },
  };
  const primary: ReviewProviderV1 = {
    auditRequest: (providerRequest) => ({
      ...mockAuditRequest(providerRequest),
      preferredProviderEndpoints: ["provider-a/fp4", "provider-b/bf16"],
      excludedProviderEndpoints: null,
    }),
    complete: async (providerRequest) => {
      calls.push({ endpoint: "provider-a/fp4", stage: providerRequest.stage });
      if (providerRequest.stage === "FINAL") throw transientFailure(429);
      return successfulEmptyResponse(providerRequest);
    },
    forRetry: () => secondary,
  };

  try {
    const result = await runTwoStageReviewV1(packetPath, config, primary);
    assert.equal(result.report.verdict, "READY");
    assert.deepEqual(calls, [
      { endpoint: "provider-a/fp4", stage: "PRELIMINARY" },
      { endpoint: "provider-a/fp4", stage: "FINAL" },
      { endpoint: "provider-b/bf16", stage: "FINAL" },
    ]);
    const events = (await readFile(result.runRecordPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const retry = events.find((event) => event.type === "PROVIDER_RETRY_REQUESTED");
    // A provider error envelope carrying no usage never reached a model, so it must not consume
    // the reservation that pays for the retry.
    assert.equal(retry.chargedFailedTokens, 0);
    assert.equal(retry.chargedFailedCostUsd, 0);
    assert.equal(retry.retriesUsed, 1);
    assert.equal(retry.maxRetries, config.budgets.maxAttemptsPerCall - 1);
    assert.deepEqual(
      events
        .filter((event) => event.type === "CALL_STARTED")
        .map((event) => event.excludedProviderEndpoints),
      [null, null, ["provider-a"]],
    );
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

it("budgets provider retries per call so an early retry cannot starve the final stage", async () => {
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
    // maxAttemptsPerCall is 2, so each logical call gets its own single retry: the preliminary
    // spends one and still leaves the final stage a full attempt budget of its own.
    assert.deepEqual(
      calls.map((request) => request.stage),
      ["PRELIMINARY", "PRELIMINARY", "FINAL", "FINAL"],
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
