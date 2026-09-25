import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { digestCanonicalJson } from "../../src/contracts/canonical-json.js";
import type { ReviewClaimSetV1 } from "../../src/contracts/review-claims.js";
import { ReviewRunConfigV3Schema } from "../../src/contracts/review-run-config.js";
import { RunRecordEventV2Schema } from "../../src/contracts/run-record-v2.js";
import { resumeClaimReviewV2 } from "../../src/orchestrator/claim-resume.js";
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

function retryableFailure() {
  return new ProviderCallError("PROVIDER_ERROR", "Rate limited.", {
    retryable: true,
    diagnostic: {
      httpStatus: 429,
      providerErrorCode: "429",
      providerMessage: "Rate limited.",
      errorType: null,
      providerCode: null,
      providerName: null,
      model: null,
      responseId: null,
      retryAfter: "0",
    },
  });
}

async function failStage(
  t: TestContext,
  stage: "FINAL" | "FINAL_CLAIM_VERIFICATION",
  uncertain = false,
) {
  const path = await packet(t);
  const run = mock(path, {
    finding: true,
    changedCorrection: stage === "FINAL_CLAIM_VERIFICATION",
  });
  const complete = run.provider.complete;
  let failed = false;
  run.provider.complete = async (request) => {
    if (request.stage === stage && !failed) {
      failed = true;
      run.requests.push(request);
      throw uncertain
        ? new ProviderCallError("TRANSPORT_UNCERTAIN", "Outcome uncertain.")
        : retryableFailure();
    }
    return complete(request);
  };
  await assert.rejects(runClaimReviewV2(path, config, run.provider));
  const callsBefore = run.requests.length;
  return { path, run, callsBefore };
}

describe("claim review resume", () => {
  it("resumes failed final reconciliation without repeating blind review or author release", async (t) => {
    const { path, run, callsBefore } = await failStage(t, "FINAL");
    const before = await ledger(path);
    const result = await resumeClaimReviewV2(path, config, run.provider);
    assert.deepEqual(
      run.requests.slice(callsBefore).map((request) => request.stage),
      ["FINAL"],
    );
    assert.equal(result.report.verdict, "NOT_READY");
    const events = await ledger(path);
    assert.equal(
      events.filter((event) => event.type === "AUTHOR_DELIVERED").length,
      before.filter((event) => event.type === "AUTHOR_DELIVERED").length,
    );
    assert.equal(
      events.filter((event) => event.type === "FINDING_VERIFICATION_PERSISTED").length,
      1,
    );
    const attempts = events
      .filter((event) => event.type === "CALL_STARTED")
      .map((event) => event.attemptNumber);
    assert.equal(new Set(attempts).size, attempts.length);
    assert.deepEqual(attempts, [1, 2, 3, 4]);
    assert.equal(events.at(-1)?.type, "RUN_COMPLETED");
  });

  it("resumes failed post-author verification from the saved proposal without regenerating final", async (t) => {
    const { path, run, callsBefore } = await failStage(t, "FINAL_CLAIM_VERIFICATION");
    const candidate = await readFile(join(path, "review", "final-candidate.json"), "utf8");
    const plan = await readFile(join(path, "review", "claim-transitions.json"), "utf8");
    const result = await resumeClaimReviewV2(path, config, run.provider);
    assert.deepEqual(
      run.requests.slice(callsBefore).map((request) => request.stage),
      ["FINAL_CLAIM_VERIFICATION"],
    );
    assert.equal(await readFile(join(path, "review", "final-candidate.json"), "utf8"), candidate);
    assert.equal(await readFile(join(path, "review", "claim-transitions.json"), "utf8"), plan);
    assert.equal(result.report.verdict, "NOT_READY");
    const events = await ledger(path);
    assert.equal(events.filter((event) => event.type === "FINAL_CANDIDATE_PERSISTED").length, 1);
    assert.equal(
      events.filter((event) => event.type === "FINAL_CLAIM_VERIFICATION_PERSISTED").length,
      1,
    );
  });

  it("resumes local projection with no provider call after persisted verification", async (t) => {
    const path = await packet(t);
    const run = mock(path, { finding: true });
    const complete = run.provider.complete;
    run.provider.complete = async (request) => {
      const result = await complete(request);
      if (request.stage === "FINAL") await mkdir(join(path, "review", "final.json"));
      return result;
    };
    await assert.rejects(runClaimReviewV2(path, config, run.provider));
    const before = await ledger(path);
    assert.ok(before.some((event) => event.type === "FINAL_CLAIM_VERIFICATION_PERSISTED"));
    const callsBefore = run.requests.length;
    await rm(join(path, "review", "final.json"), { recursive: true });
    const result = await resumeClaimReviewV2(path, config, run.provider);
    assert.equal(run.requests.length, callsBefore);
    assert.equal(result.report.verdict, "NOT_READY");
    assert.equal(result.report.findings[0]?.correction, "Restore the exported value to one.");
    const events = await ledger(path);
    const resumed = events.findLast((event) => event.type === "RUN_RESUMED");
    assert.ok(resumed?.type === "RUN_RESUMED");
    assert.equal(resumed.stage, "PROJECTION");
    assert.ok(
      events.findLastIndex((event) => event.type === "FINAL_REPORT_PERSISTED") <
        events.findLastIndex((event) => event.type === "RUN_COMPLETED"),
    );
  });

  it("refuses uncertain transport without submitting another request", async (t) => {
    const { path, run, callsBefore } = await failStage(t, "FINAL_CLAIM_VERIFICATION", true);
    await assert.rejects(resumeClaimReviewV2(path, config, run.provider));
    assert.equal(run.requests.length, callsBefore);
  });

  it("refuses a changed config without provider I/O", async (t) => {
    const { path, run, callsBefore } = await failStage(t, "FINAL");
    await assert.rejects(
      resumeClaimReviewV2(
        path,
        {
          ...config,
          budgets: { ...config.budgets, maxTotalCostUsd: config.budgets.maxTotalCostUsd + 1 },
        },
        run.provider,
      ),
    );
    assert.equal(run.requests.length, callsBefore);
  });

  it("refuses modified saved claims, judgments, candidate, transitions, targets, or catalog", async (t) => {
    for (const artifact of [
      "preliminary-claims.json",
      "finding-verification.json",
      "final-candidate.json",
      "claim-transitions.json",
      "final-claim-targets.json",
      "carried-claim-catalog.json",
    ]) {
      const { path, run, callsBefore } = await failStage(t, "FINAL_CLAIM_VERIFICATION");
      const artifactPath = join(path, "review", artifact);
      const value = JSON.parse(await readFile(artifactPath, "utf8"));
      await writeFile(artifactPath, JSON.stringify({ ...value, attackerControlled: "changed" }));
      await assert.rejects(resumeClaimReviewV2(path, config, run.provider));
      assert.equal(run.requests.length, callsBefore, artifact);
    }
  });

  it("rejects mixed-generation ledgers without reinterpreting old semantics", async (t) => {
    const { path, run, callsBefore } = await failStage(t, "FINAL");
    const recordPath = join(path, "review", "run-record.jsonl");
    const original = await readFile(recordPath, "utf8");
    await writeFile(
      recordPath,
      `${original}${JSON.stringify({ schemaVersion: 1, at: "2026-09-22T12:00:00.000Z", type: "RUN_COMPLETED", terminalState: "READY" })}\n`,
    );
    await assert.rejects(resumeClaimReviewV2(path, config, run.provider));
    assert.equal(run.requests.length, callsBefore);
  });

  it("does not turn a schema-invalid successful final reply into a resumable semantic retry", async (t) => {
    const path = await packet(t);
    const run = mock(path, { finding: true });
    const complete = run.provider.complete;
    run.provider.complete = async (request) => {
      if (request.stage === "FINAL") {
        run.requests.push(request);
        return response({
          schemaVersion: 4,
          stage: "FINAL",
          summary: "Invalid semantic candidate.",
        });
      }
      return complete(request);
    };
    await assert.rejects(runClaimReviewV2(path, config, run.provider));
    const callsBefore = run.requests.length;
    await assert.rejects(resumeClaimReviewV2(path, config, run.provider));
    assert.equal(run.requests.length, callsBefore);
  });
});
