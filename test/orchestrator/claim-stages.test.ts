import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReviewBrief } from "../../src/contracts/neutral-review-brief.js";
import type { ReviewClaimSetV1 } from "../../src/contracts/review-claims.js";
import { ReviewRunConfigV3Schema } from "../../src/contracts/review-run-config.js";
import type { RunRecordEventPayloadV2 } from "../../src/contracts/run-record-v2.js";
import type { ReviewPreliminary } from "../../src/contracts/standards-results.js";
import { reviewClaimSetV1 } from "../../src/orchestrator/claim-adapter.js";
import { completeClaimStagesV1 } from "../../src/orchestrator/claim-stages.js";
import type { ReviewProviderRequestV2 } from "../../src/provider/review-provider.js";

const binding = {
  snapshotDigest: { algorithm: "SHA256" as const, value: "a".repeat(64) },
  briefDigest: { algorithm: "SHA256" as const, value: "b".repeat(64) },
};

function judgment(overrides: Record<string, unknown> = {}) {
  return {
    kind: "VIOLATION",
    obligationStatus: "APPLICABLE",
    scenarioStatus: "IN_SCOPE",
    behaviorStatus: "SUPPORTED",
    correctionStatus: "SUPPORTED",
    duplicateOf: null,
    rationale: "PRIOR_PRIVATE_RATIONALE",
    ...overrides,
  };
}

function harness(withFinding = true) {
  const brief = {
    schemaVersion: 1,
    briefDigest: binding.briefDigest,
    snapshotManifest: {
      snapshotDigest: binding.snapshotDigest,
      canonicalInputs: [{ id: "input_requirement" }],
      paths: [{ path: "src/page.ts" }],
    },
    canonicalInputs: {},
  } as unknown as ReviewBrief;
  const preliminary = {
    schemaVersion: 1,
    stage: "PRELIMINARY",
    ...binding,
    findings: withFinding
      ? [
          {
            id: "finding_source",
            severity: "P1",
            title: "PRESENTATION_TITLE",
            scenario: "Empty pages return stale entries.",
            impact: "PRESENTATION_IMPACT",
            correction: "Return an empty array.",
            evidence: [
              {
                path: "src/page.ts",
                anchor: "LINE_RANGE",
                side: "HEAD",
                startLine: 8,
                endLine: 9,
                detail: "PRESENTATION_DETAIL",
              },
            ],
          },
        ]
      : [],
    evidenceGaps: [],
    limitations: [],
  } as unknown as ReviewPreliminary;
  const prior = reviewClaimSetV1(brief, preliminary).set;
  const log: string[] = [];
  const requests: ReviewProviderRequestV2[] = [];
  const saved = new Map<string, unknown>();
  const events: RunRecordEventPayloadV2[] = [];
  const answer: {
    final: unknown;
    blind: unknown;
    post: unknown;
    failPost: boolean;
    failEvidence: boolean;
  } = {
    final: {
      schemaVersion: 4,
      stage: "FINAL",
      mode: "REQUIREMENTS",
      ...binding,
      continuedClaimIds: prior.claims.map((claim) => claim.claimId),
      withdrawnClaimIds: [],
      newClaims: [],
    },
    blind: {
      schemaVersion: 1,
      stage: "FINDING_VERIFICATION",
      assessments: prior.claims.map(() => judgment()),
    },
    post: { schemaVersion: 1, stage: "FINAL_CLAIM_VERIFICATION", assessments: [judgment()] },
    failPost: false,
    failEvidence: false,
  };
  const config = ReviewRunConfigV3Schema.parse({
    schemaVersion: 3,
    configId: "config_test",
    model: "provider/model-v1",
    providerRouting: { maxPrice: { prompt: 2, completion: 5, request: 0 } },
    budgets: {
      maxInitialEvidenceBytes: 100000,
      maxConversationBytes: 100000,
      maxOutputTokensPerCall: 2000,
      maxTotalTokens: 1000000,
      maxTotalCostUsd: 100,
      timeoutMs: 10000,
    },
  });
  const input = {
    brief,
    preliminary,
    config,
    blindEvidence: { evidence: "FROZEN_BLIND_EVIDENCE" },
    authorEvidence: { author: "AUTHOR_PRIVATE_EVIDENCE" },
    authorRelease: { type: "AUTHOR_DELIVERED" as const, authorPacketDigest: binding.briefDigest },
    fragmentLimits: {
      claimSetBytes: 100000,
      verificationBytes: 100000,
      transitionClaimsBytes: 200000,
    },
    complete: async (request: ReviewProviderRequestV2, _promptVersion: string) => {
      requests.push(request);
      log.push(`call:${request.stage}`);
      if (request.stage === "FINAL_CLAIM_VERIFICATION" && answer.failPost)
        throw new Error("post transport failed");
      const value =
        request.stage === "FINAL"
          ? answer.final
          : request.stage === "FINDING_VERIFICATION"
            ? answer.blind
            : answer.post;
      return {
        response: {
          value,
          rawContent: JSON.stringify(value),
          responseId: null,
          model: null,
          provider: null,
          usage: { promptTokens: null, completionTokens: null, totalTokens: null, cost: null },
        },
        attemptNumber: requests.length + 1,
        responseArtifact: `response-${requests.length}.json`,
      };
    },
    persist: async (name: string, value: unknown) => {
      assert.equal(saved.has(name), false, `duplicate persistence ${name}`);
      saved.set(name, value);
      log.push(`persist:${name}`);
    },
    durable: async (event: RunRecordEventPayloadV2) => {
      events.push(event);
      log.push(`event:${event.type}`);
    },
    validateEvidence: async (_claims: ReviewClaimSetV1) => {
      log.push("validate");
      if (answer.failEvidence) throw new Error("invalid frozen anchor");
    },
  };
  return { input, answer, prior, requests, saved, events, log };
}

function newCorrection(run: ReturnType<typeof harness>) {
  const existing = run.prior.claims[0];
  assert.ok(existing);
  run.answer.final = {
    schemaVersion: 4,
    stage: "FINAL",
    mode: "REQUIREMENTS",
    ...binding,
    continuedClaimIds: [existing.claimId],
    withdrawnClaimIds: [],
    newClaims: [{ ...existing.core, correction: "Use a new exact correction." }],
  };
}

describe("selective claim stages", () => {
  it("verifies a final-only claim even when preliminary review was clean", async () => {
    const run = harness(false);
    const introduced = harness().prior.claims[0];
    assert.ok(introduced);
    run.answer.final = {
      schemaVersion: 4,
      stage: "FINAL",
      mode: "REQUIREMENTS",
      ...binding,
      continuedClaimIds: [],
      withdrawnClaimIds: [],
      newClaims: [introduced.core],
    };
    const result = await completeClaimStagesV1(run.input);
    assert.deepEqual(
      run.requests.map((request) => request.stage),
      ["FINAL", "FINAL_CLAIM_VERIFICATION"],
    );
    assert.equal(result.plan.targets.claims.length, 1);
    assert.equal(result.plan.catalog.claims.length, 0);
  });

  it("skips both verifier calls for a clean review but persists both local decisions", async () => {
    const run = harness(false);
    await completeClaimStagesV1(run.input);
    assert.deepEqual(
      run.requests.map((request) => request.stage),
      ["FINAL"],
    );
    assert.ok(run.saved.has("preliminary-claims.json"));
    assert.ok(run.saved.has("finding-verification.json"));
    assert.ok(run.saved.has("final-claim-verification.json"));
    for (const type of ["FINDING_VERIFICATION_PERSISTED", "FINAL_CLAIM_VERIFICATION_PERSISTED"]) {
      const event = run.events.find((entry) => entry.type === type);
      assert.ok(event && "providerCall" in event);
      assert.equal(event.providerCall, false);
    }
  });

  it("persists blind assessment before releasing author evidence and omits post-call for continuation", async () => {
    const run = harness();
    const result = await completeClaimStagesV1(run.input);
    assert.deepEqual(
      run.requests.map((request) => request.stage),
      ["FINDING_VERIFICATION", "FINAL"],
    );
    assert.deepEqual(result.prior, run.prior);
    assert.ok(
      run.log.indexOf("persist:preliminary-claims.json") <
        run.log.indexOf("event:PRELIMINARY_CLAIMS_PERSISTED"),
    );
    assert.ok(
      run.log.indexOf("persist:finding-verification.json") <
        run.log.indexOf("event:FINDING_VERIFICATION_PERSISTED"),
    );
    assert.ok(
      run.log.indexOf("event:FINDING_VERIFICATION_PERSISTED") <
        run.log.indexOf("event:AUTHOR_DELIVERED"),
    );
    assert.ok(run.log.indexOf("event:AUTHOR_DELIVERED") < run.log.indexOf("call:FINAL"));
    const blind = JSON.stringify(run.requests[0]?.messages);
    assert.match(blind, /FROZEN_BLIND_EVIDENCE/);
    assert.doesNotMatch(blind, /AUTHOR_PRIVATE_EVIDENCE|claim_[a-f0-9]{64}|PRESENTATION_/);
  });

  it("carries prior rejections without post-verification even when withdrawal is requested", async () => {
    const run = harness();
    run.answer.blind = {
      schemaVersion: 1,
      stage: "FINDING_VERIFICATION",
      assessments: [judgment({ behaviorStatus: "REFUTED" })],
    };
    run.answer.final = {
      schemaVersion: 4,
      stage: "FINAL",
      mode: "REQUIREMENTS",
      ...binding,
      continuedClaimIds: [],
      withdrawnClaimIds: run.prior.claims.map((claim) => claim.claimId),
      newClaims: [],
    };
    const result = await completeClaimStagesV1(run.input);
    assert.deepEqual(
      run.requests.map((request) => request.stage),
      ["FINDING_VERIFICATION", "FINAL"],
    );
    assert.equal(result.plan.targets.claims.length, 0);
    assert.equal(result.plan.transitions[0]?.kind, "REJECTED_CARRIED");
  });

  it("verifies changed correction with ID-free targets and catalog after durable proposal artifacts", async () => {
    const run = harness();
    newCorrection(run);
    const result = await completeClaimStagesV1(run.input);
    assert.deepEqual(
      run.requests.map((request) => request.stage),
      ["FINDING_VERIFICATION", "FINAL", "FINAL_CLAIM_VERIFICATION"],
    );
    assert.equal(result.plan.targets.claims.length, 1);
    assert.equal(result.plan.catalog.claims.length, 1);
    for (const name of [
      "final-candidate.json",
      "claim-transitions.json",
      "final-claim-targets.json",
      "carried-claim-catalog.json",
    ]) {
      assert.ok(run.saved.has(name), name);
      assert.ok(
        run.log.indexOf(`persist:${name}`) < run.log.indexOf("event:FINAL_CANDIDATE_PERSISTED"),
      );
    }
    assert.ok(
      run.log.indexOf("event:FINAL_CANDIDATE_PERSISTED") <
        run.log.indexOf("call:FINAL_CLAIM_VERIFICATION"),
    );
    const postMessages = JSON.stringify(run.requests[2]?.messages);
    assert.match(postMessages, /AUTHOR_PRIVATE_EVIDENCE/);
    assert.match(postMessages, /FROZEN_BLIND_EVIDENCE/);
    assert.match(postMessages, /Use a new exact correction/);
    assert.doesNotMatch(postMessages, /claim_[a-f0-9]{64}|PRIOR_PRIVATE_RATIONALE|PRESENTATION_/);
    assert.ok(
      run.log.indexOf("persist:final-claim-verification.json") <
        run.log.indexOf("event:FINAL_CLAIM_VERIFICATION_PERSISTED"),
    );
  });

  it("requires post-verification before accepting withdrawal of a demonstrated claim", async () => {
    const run = harness();
    run.answer.final = {
      schemaVersion: 4,
      stage: "FINAL",
      mode: "REQUIREMENTS",
      ...binding,
      continuedClaimIds: [],
      withdrawnClaimIds: run.prior.claims.map((claim) => claim.claimId),
      newClaims: [],
    };
    await completeClaimStagesV1(run.input);
    assert.equal(run.requests.at(-1)?.stage, "FINAL_CLAIM_VERIFICATION");
  });

  it("rejects malformed blind verification before author release or final call", async () => {
    const run = harness();
    run.answer.blind = { schemaVersion: 1, stage: "FINDING_VERIFICATION", assessments: [] };
    await assert.rejects(completeClaimStagesV1(run.input));
    assert.deepEqual(
      run.requests.map((request) => request.stage),
      ["FINDING_VERIFICATION"],
    );
    assert.equal(
      run.events.some((event) => event.type === "AUTHOR_DELIVERED"),
      false,
    );
    assert.equal(run.saved.has("finding-verification.json"), false);
  });

  it("rejects invalid final candidate without another provider call", async () => {
    const run = harness();
    run.answer.final = {
      schemaVersion: 4,
      stage: "FINAL",
      mode: "REQUIREMENTS",
      ...binding,
      continuedClaimIds: [],
      withdrawnClaimIds: [],
      newClaims: [],
      summary: "UNVERIFIED_ALLEGATION",
    };
    await assert.rejects(completeClaimStagesV1(run.input));
    assert.deepEqual(
      run.requests.map((request) => request.stage),
      ["FINDING_VERIFICATION", "FINAL"],
    );
    assert.equal(run.saved.has("final-candidate.json"), false);
  });

  it("validates frozen evidence before a post-author provider call", async () => {
    const run = harness();
    newCorrection(run);
    run.input.validateEvidence = async (claims) => {
      run.log.push("validate");
      if (claims.claims.some((claim) => claim.core.correction === "Use a new exact correction."))
        throw new Error("invalid frozen anchor");
    };
    await assert.rejects(completeClaimStagesV1(run.input), /invalid frozen anchor/);
    assert.equal(
      run.requests.some((request) => request.stage === "FINAL_CLAIM_VERIFICATION"),
      false,
    );
  });

  it("preserves candidate checkpoints when post transport fails without claiming final verification", async () => {
    const run = harness();
    newCorrection(run);
    run.answer.failPost = true;
    await assert.rejects(completeClaimStagesV1(run.input), /post transport failed/);
    assert.ok(run.saved.has("final-candidate.json"));
    assert.ok(run.saved.has("claim-transitions.json"));
    assert.equal(run.saved.has("final-claim-verification.json"), false);
    assert.equal(
      run.events.some((event) => event.type === "FINAL_CLAIM_VERIFICATION_PERSISTED"),
      false,
    );
    assert.equal(
      run.events.some((event) => event.type === "FINAL_REPORT_PERSISTED"),
      false,
    );
  });

  it("refuses malformed post judgment without persisting verification authority", async () => {
    const run = harness();
    newCorrection(run);
    run.answer.post = { schemaVersion: 1, stage: "FINAL_CLAIM_VERIFICATION", assessments: [] };
    await assert.rejects(completeClaimStagesV1(run.input));
    assert.equal(run.requests.length, 3);
    assert.equal(run.saved.has("final-claim-verification.json"), false);
    assert.equal(
      run.events.some((event) => event.type === "FINAL_CLAIM_VERIFICATION_PERSISTED"),
      false,
    );
  });
});
