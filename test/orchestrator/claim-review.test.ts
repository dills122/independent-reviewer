import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { digestCanonicalJson } from "../../src/contracts/canonical-json.js";
import type { ReviewClaimSetV1 } from "../../src/contracts/review-claims.js";
import { ReviewRunConfigV3Schema } from "../../src/contracts/review-run-config.js";
import { RunRecordEventV2Schema } from "../../src/contracts/run-record-v2.js";
import { runClaimReviewV2 } from "../../src/orchestrator/claim-review.js";
import {
  ProviderCallError,
  type ReviewProviderRequestV2,
  type ReviewProviderResponseV1,
  type ReviewProviderV2,
} from "../../src/provider/review-provider.js";
import { captureGitSnapshotV1 } from "../../src/snapshot/git-capture.js";
import { writeSnapshotPacketV1 } from "../../src/snapshot/snapshot-packet.js";

const exec = promisify(execFile);
const config = ReviewRunConfigV3Schema.parse({
  schemaVersion: 3,
  configId: "config_test",
  model: "mock/reviewer",
  providerRouting: { maxPrice: { prompt: 0.5, completion: 1.5, request: 0 } },
  budgets: {
    maxInitialEvidenceBytes: 100000,
    maxConversationBytes: 1000000,
    maxOutputTokensPerCall: 8192,
    maxTotalTokens: 2000000,
    maxTotalCostUsd: 10,
    timeoutMs: 10000,
    minimumCallIntervalMs: 0,
    maxAttemptsPerCall: 1,
  },
});

async function packet(t: TestContext, standards = false) {
  const repo = await mkdtemp(join(tmpdir(), "claim-review-flow-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args]);
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Claim Test");
  await git("config", "user.email", "claim@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await writeFile(join(repo, "reviewed.ts"), "export const value = 1;\n");
  await writeFile(join(repo, ".gitignore"), ".review-runs/\n");
  await git("add", ".");
  await git("commit", "-m", "base");
  await writeFile(join(repo, "reviewed.ts"), "export const value = 2;\n");
  const provenance = { type: "INLINE" as const, label: "Claim integration test" };
  const common = {
    flowId: "flow_claim_test",
    reviewInstance: { number: 1, maximum: 3 },
    repository: { path: repo, base: "main" },
    reviewConfigRef: "config_test",
  };
  const request = standards
    ? {
        ...common,
        schemaVersion: 2,
        mode: "STANDARDS",
        canonicalInputs: {
          standards: [
            {
              id: "input_standard",
              kind: "PROJECT_GUIDANCE",
              title: "Value rule",
              provenance,
              content: JSON.stringify({
                schemaVersion: 1,
                name: "Values",
                source: "Project rules",
                rules: [
                  {
                    id: "rule_value",
                    text: "The exported value must equal one.",
                    enforcement: "REQUIRED",
                    paths: ["**/*.ts"],
                    exceptions: null,
                  },
                ],
              }),
            },
          ],
        },
        authorPacket: {
          schemaVersion: 2,
          overview: "AUTHOR_PRIVATE_CONTEXT",
          claimedVerification: [
            { command: "npm test", outcome: "PASSED", summary: "AUTHOR_TEST_SUMMARY" },
          ],
        },
      }
    : {
        ...common,
        schemaVersion: 1,
        canonicalInputs: {
          requirements: [
            {
              id: "input_requirement",
              kind: "REQUIREMENTS",
              title: "Value requirement",
              content: "The exported value must equal one.",
              provenance,
            },
          ],
          implementationPlan: {
            id: "input_plan",
            kind: "IMPLEMENTATION_PLAN",
            title: "Plan",
            content: "Preserve the exported value.",
            provenance,
          },
          projectGuidance: [],
        },
        authorPacket: {
          schemaVersion: 1,
          intent: "AUTHOR_PRIVATE_CONTEXT",
          successCriteria: ["Preserve the value."],
          planTraceability: [],
          technicalApproach: "Update the value.",
          componentWalkthrough: [],
          decisions: [],
          invariants: [],
          claimedVerification: [
            { command: "npm test", outcome: "PASSED", summary: "AUTHOR_TEST_SUMMARY" },
          ],
          risks: [],
          knownGaps: [],
          challengePoints: [],
        },
      };
  const path = join(repo, ".review-runs", "packet");
  await writeSnapshotPacketV1(path, await captureGitSnapshotV1(request), request);
  return path;
}

async function ledger(path: string) {
  return (await readFile(join(path, "review", "run-record.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => RunRecordEventV2Schema.parse(JSON.parse(line)));
}

function response(value: unknown): ReviewProviderResponseV1 {
  return {
    value,
    rawContent: JSON.stringify(value),
    responseId: null,
    model: "mock/reviewer",
    provider: "mock",
    usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200, cost: 0.001 },
  };
}

function mock(
  path: string,
  options: {
    finding?: boolean;
    standards?: boolean;
    changedCorrection?: boolean;
    failPost?: boolean;
    invalidAnchor?: boolean;
  } = {},
) {
  const requests: ReviewProviderRequestV2[] = [];
  let binding: Record<string, unknown> = {};
  const provider: ReviewProviderV2 = {
    auditRequest: (request) => ({
      providerPolicyVersion: "mock-v2",
      wireBodyDigest: digestCanonicalJson(request),
      wireBodyBytes: Buffer.byteLength(JSON.stringify(request)),
      credentialFreeWireRequestDigest: digestCanonicalJson(request),
    }),
    complete: async (request) => {
      requests.push(request);
      const user = JSON.parse(
        request.messages.find((message) => message.role === "user")?.content ?? "{}",
      );
      if (request.stage === "PRELIMINARY") {
        assert.doesNotMatch(
          JSON.stringify(request.messages),
          /AUTHOR_PRIVATE_CONTEXT|AUTHOR_TEST_SUMMARY/,
        );
        binding = {
          snapshotDigest: user.snapshotManifest.snapshotDigest,
          briefDigest: user.briefDigest,
        };
        const finding = {
          id: "finding_value",
          severity: options.standards ? "REQUIRED" : "P1",
          title: "UNTRUSTED_FINDING_TITLE",
          impact: "UNTRUSTED_FINDING_IMPACT",
          correction: "Restore the exported value to one.",
          evidence: [
            {
              path: "reviewed.ts",
              anchor: "LINE_RANGE",
              side: "HEAD",
              startLine: 1,
              endLine: 1,
              detail: "UNTRUSTED_EVIDENCE_DETAIL",
            },
          ],
          ...(options.standards
            ? {
                ruleIds: ["rule_value"],
                problem: "Reading the exported value returns two instead of one.",
              }
            : { scenario: "Reading the exported value returns two instead of one." }),
        };
        return response({
          schemaVersion: options.standards ? 2 : 1,
          stage: "PRELIMINARY",
          ...binding,
          summary: "UNTRUSTED_PRELIMINARY_SUMMARY",
          inspectedPaths: ["reviewed.ts"],
          canonicalInputCoverage: (options.standards
            ? ["input_standard"]
            : ["input_plan", "input_requirement"]
          ).map((canonicalInputId) => ({
            canonicalInputId,
            status: "ASSESSED",
            explanation: "UNTRUSTED_COVERAGE_PROSE",
          })),
          findings: options.finding ? [finding] : [],
          evidenceGaps: [],
          limitations: [],
          nextAction: "REQUEST_AUTHOR_PACKET",
          ...(options.standards
            ? {
                ruleAssessments: [
                  {
                    ruleId: "rule_value",
                    status: "ASSESSED",
                    conflictingRuleIds: [],
                    explanation: "Rule inspected.",
                  },
                ],
              }
            : {}),
        });
      }
      if (request.stage === "FINAL") {
        const prior = user.priorClaims as ReviewClaimSetV1;
        assert.ok(Array.isArray(prior.claims));
        assert.match(JSON.stringify(user.untrustedAuthorEvidence), /AUTHOR_PRIVATE_CONTEXT/);
        const first = prior.claims[0];
        const changed = options.changedCorrection || options.invalidAnchor;
        return response({
          schemaVersion: 4,
          stage: "FINAL",
          mode: options.standards ? "STANDARDS" : "REQUIREMENTS",
          ...binding,
          continuedClaimIds: changed ? [] : prior.claims.map((claim) => claim.claimId),
          withdrawnClaimIds: changed ? prior.claims.map((claim) => claim.claimId) : [],
          newClaims:
            changed && first
              ? [
                  {
                    ...first.core,
                    correction: "Replace the exported value with one.",
                    ...(options.invalidAnchor
                      ? {
                          evidence: [
                            {
                              path: "reviewed.ts",
                              anchor: "LINE_RANGE",
                              side: "HEAD",
                              startLine: 99,
                              endLine: 99,
                            },
                          ],
                        }
                      : {}),
                  },
                ]
              : [],
        });
      }
      if (request.stage === "FINDING_VERIFICATION")
        assert.doesNotMatch(
          JSON.stringify(request.messages),
          /AUTHOR_PRIVATE_CONTEXT|AUTHOR_TEST_SUMMARY|claim_[a-f0-9]{64}/,
        );
      if (request.stage === "FINAL_CLAIM_VERIFICATION") {
        const events = await ledger(path);
        assert.ok(events.some((event) => event.type === "FINAL_CANDIDATE_PERSISTED"));
        await readFile(join(path, "review", "final-candidate.json"), "utf8");
        await readFile(join(path, "review", "claim-transitions.json"), "utf8");
        if (options.failPost)
          throw new ProviderCallError("TRANSPORT_UNCERTAIN", "Post verification failed.");
      }
      const count = request.stage === "FINDING_VERIFICATION" ? 1 : 2;
      return response({
        schemaVersion: 1,
        stage: request.stage,
        assessments: Array.from({ length: count }, () => ({
          kind: "VIOLATION",
          obligationStatus: "APPLICABLE",
          scenarioStatus: "IN_SCOPE",
          behaviorStatus: "SUPPORTED",
          correctionStatus: "SUPPORTED",
          duplicateOf: null,
          rationale: "The frozen source establishes this behavior.",
        })),
      });
    },
  };
  return { provider, requests };
}

describe("provider-free claim review integration", () => {
  it("completes clean requirements review in two calls with V2 ledger and unverified author commands", async (t) => {
    const path = await packet(t);
    const run = mock(path);
    const result = await runClaimReviewV2(path, config, run.provider);
    assert.deepEqual(
      run.requests.map((request) => request.stage),
      ["PRELIMINARY", "FINAL"],
    );
    assert.equal(result.report.schemaVersion, 2);
    assert.equal(result.report.verdict, "READY");
    assert.equal(result.report.authorVerificationClaims[0]?.status, "UNVERIFIED");
    assert.equal(result.report.authorVerificationClaims[0]?.claimedSummary, "AUTHOR_TEST_SUMMARY");
    assert.doesNotMatch(result.report.summary, /UNTRUSTED_|AUTHOR_/);
    const events = await ledger(path);
    assert.ok(events.every((event) => event.schemaVersion === 2));
    assert.ok(
      events.findIndex((event) => event.type === "FINAL_REPORT_PERSISTED") <
        events.findIndex((event) => event.type === "RUN_COMPLETED"),
    );
  });

  it("keeps an unchanged verified finding with three calls and runner-owned presentation", async (t) => {
    const path = await packet(t);
    const run = mock(path, { finding: true });
    const result = await runClaimReviewV2(path, config, run.provider);
    assert.deepEqual(
      run.requests.map((request) => request.stage),
      ["PRELIMINARY", "FINDING_VERIFICATION", "FINAL"],
    );
    assert.equal(result.report.verdict, "NOT_READY");
    assert.equal(result.report.findings.length, 1);
    assert.doesNotMatch(JSON.stringify(result.report), /UNTRUSTED_/);
  });

  it("verifies correction changes in a fourth call after persisting exact proposal checkpoints", async (t) => {
    const path = await packet(t);
    const run = mock(path, { finding: true, changedCorrection: true });
    const result = await runClaimReviewV2(path, config, run.provider);
    assert.deepEqual(
      run.requests.map((request) => request.stage),
      ["PRELIMINARY", "FINDING_VERIFICATION", "FINAL", "FINAL_CLAIM_VERIFICATION"],
    );
    assert.equal(result.report.verdict, "NOT_READY");
    const events = await ledger(path);
    assert.equal(
      events.filter((event) => event.type === "FINAL_CLAIM_VERIFICATION_PERSISTED").length,
      1,
    );
  });

  it("leaves resumable proposal artifacts but no report after post-verification transport failure", async (t) => {
    const path = await packet(t);
    const run = mock(path, { finding: true, changedCorrection: true, failPost: true });
    await assert.rejects(runClaimReviewV2(path, config, run.provider));
    await readFile(join(path, "review", "final-candidate.json"), "utf8");
    await assert.rejects(readFile(join(path, "review", "final.json")), { code: "ENOENT" });
    const events = await ledger(path);
    assert.equal(
      events.some((event) => event.type === "FINAL_REPORT_PERSISTED"),
      false,
    );
    assert.equal(
      events.some((event) => event.type === "FINAL_CLAIM_VERIFICATION_PERSISTED"),
      false,
    );
  });

  it("refuses insufficient four-call reservations before provider I/O", async (t) => {
    const path = await packet(t);
    const run = mock(path);
    await assert.rejects(
      runClaimReviewV2(
        path,
        { ...config, budgets: { ...config.budgets, maxTotalTokens: 20000 } },
        run.provider,
      ),
    );
    assert.equal(run.requests.length, 0);
  });

  it("rejects final claim anchors outside frozen source before post-verification", async (t) => {
    const path = await packet(t);
    const run = mock(path, { finding: true, invalidAnchor: true });
    await assert.rejects(runClaimReviewV2(path, config, run.provider));
    assert.equal(
      run.requests.some((request) => request.stage === "FINAL_CLAIM_VERIFICATION"),
      false,
    );
    await assert.rejects(readFile(join(path, "review", "final.json")), { code: "ENOENT" });
  });

  it("publishes standards V4 through the same verified three-call path", async (t) => {
    const path = await packet(t, true);
    const run = mock(path, { finding: true, standards: true });
    const result = await runClaimReviewV2(path, config, run.provider);
    assert.equal(result.report.schemaVersion, 4);
    assert.equal(result.report.mode, "STANDARDS");
    assert.equal(result.report.verdict, "NOT_READY");
    assert.equal(run.requests.length, 3);
  });
});
