import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { digestCanonicalJson } from "../../src/contracts/canonical-json.js";
import { ReviewRunConfigV3Schema } from "../../src/contracts/review-run-config.js";
import type { RunRecordEventPayloadV2 } from "../../src/contracts/run-record-v2.js";
import { reserveClaimCallsV1 } from "../../src/orchestrator/claim-admission.js";
import { ClaimCallExecutorV1 } from "../../src/orchestrator/claim-call-executor.js";
import {
  ProviderCallError,
  type ReviewProviderRequestV2,
  type ReviewProviderResponseV1,
  type ReviewProviderV2,
} from "../../src/provider/review-provider.js";

function response(
  usage: ReviewProviderResponseV1["usage"] = {
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    cost: 0.01,
  },
): ReviewProviderResponseV1 {
  return {
    value: { ok: true },
    rawContent: '{"ok":true}',
    responseId: "response_test",
    model: "provider/model-v1",
    provider: "endpoint",
    usage,
  };
}

function request(stage: ReviewProviderRequestV2["stage"] = "PRELIMINARY"): ReviewProviderRequestV2 {
  return {
    stage,
    models: ["provider/model-v1"],
    maxOutputTokens: 1000,
    timeoutMs: 10000,
    messages: [{ role: "user", content: "Frozen evidence." }],
    responseSchema: { name: "test-schema", schema: { type: "object" } },
  };
}

function audit(value: ReviewProviderRequestV2) {
  const digest = digestCanonicalJson(value);
  return {
    providerPolicyVersion: "policy-test",
    wireBodyDigest: digest,
    wireBodyBytes: Buffer.byteLength(JSON.stringify(value)),
    credentialFreeWireRequestDigest: digest,
  };
}

async function arrange(
  t: TestContext,
  handler: ReviewProviderV2["complete"] = async () => response(),
  overrides: Record<string, unknown> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "claim-executor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = ReviewRunConfigV3Schema.parse({
    schemaVersion: 3,
    configId: "config_executor",
    model: "provider/model-v1",
    providerRouting: { maxPrice: { prompt: 2, completion: 5, request: 0.01 } },
    budgets: {
      maxInitialEvidenceBytes: 1000000,
      maxConversationBytes: 1000000,
      maxOutputTokensPerCall: 1000,
      maxTotalTokens: 1000000,
      maxTotalCostUsd: 100,
      timeoutMs: 10000,
      maxAttemptsPerCall: 3,
      minimumCallIntervalMs: 0,
      ...overrides,
    },
  });
  const skeleton = {
    messages: request().messages,
    responseSchema: request().responseSchema.schema,
  };
  const admission = reserveClaimCallsV1(
    {
      PRELIMINARY: skeleton,
      FINDING_VERIFICATION: skeleton,
      FINAL: skeleton,
      FINAL_CLAIM_VERIFICATION: skeleton,
    },
    config,
  );
  const events: RunRecordEventPayloadV2[] = [];
  const calls: ReviewProviderRequestV2[] = [];
  const sleeps: number[] = [];
  const provider: ReviewProviderV2 = {
    auditRequest: audit,
    complete: async (value) => {
      calls.push(value);
      return handler(value);
    },
  };
  const options = {
    directory,
    config,
    provider,
    admission,
    durable: async (event: RunRecordEventPayloadV2) => {
      events.push(event);
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  return {
    directory,
    config,
    provider,
    admission,
    events,
    calls,
    sleeps,
    options,
    executor: new ClaimCallExecutorV1(options),
  };
}

describe("claim call executor", () => {
  it("persists audited attempts and private response artifacts while charging known usage", async (t) => {
    const run = await arrange(t, async () => ({
      ...response(),
      rawResponseBody: { privateEnvelope: "PRIVATE_PROVIDER_BODY" },
    }));
    const result = await run.executor.complete(request(), "prompt-test");
    assert.equal(result.attemptNumber, 1);
    assert.equal(run.executor.state.nextAttempt, 2);
    assert.equal(run.executor.state.spentTokens, 30);
    assert.equal(run.executor.state.spentUsd, 0.01);
    assert.deepEqual(
      run.events.map((event) => event.type),
      ["CALL_STARTED", "CALL_SUCCEEDED"],
    );
    const started = run.events[0];
    assert.ok(started?.type === "CALL_STARTED");
    assert.deepEqual(started.wireBodyDigest, audit(request()).wireBodyDigest);
    assert.equal(started.promptVersion, "prompt-test");
    const artifactPath = isAbsolute(result.responseArtifact)
      ? result.responseArtifact
      : join(run.directory, result.responseArtifact);
    assert.match(await readFile(artifactPath, "utf8"), /ok/);
    assert.equal((await stat(artifactPath)).mode & 0o077, 0);
    const files = await readdir(run.directory);
    const contents = await Promise.all(
      files.map((name) => readFile(join(run.directory, name), "utf8")),
    );
    assert.ok(contents.some((content) => content.includes("PRIVATE_PROVIDER_BODY")));
    assert.doesNotMatch(JSON.stringify(run.events), /PRIVATE_PROVIDER_BODY/);
  });

  it("conservatively charges unknown successful usage", async (t) => {
    const run = await arrange(t, async () =>
      response({ promptTokens: null, completionTokens: null, totalTokens: null, cost: null }),
    );
    await run.executor.complete(request(), "prompt-test");
    const reserved =
      Buffer.byteLength(
        JSON.stringify({
          messages: request().messages,
          responseSchema: request().responseSchema.schema,
        }),
        "utf8",
      ) +
      256 +
      1000;
    assert.equal(run.executor.state.spentTokens, reserved);
    assert.ok(run.executor.state.spentUsd > 0);
  });

  it("charges unsent failure zero and uncertain failure conservatively", async (t) => {
    for (const code of ["TRANSPORT_UNSENT", "TRANSPORT_UNCERTAIN"] as const) {
      const run = await arrange(
        t,
        async () => {
          throw new ProviderCallError(code, "Transport failed.");
        },
        { maxAttemptsPerCall: 1 },
      );
      await assert.rejects(run.executor.complete(request(), "prompt-test"));
      assert.equal(run.calls.length, 1);
      if (code === "TRANSPORT_UNSENT") {
        assert.equal(run.executor.state.spentTokens, 0);
        assert.equal(run.executor.state.spentUsd, 0);
      } else {
        assert.ok(run.executor.state.spentTokens >= 1000);
        assert.ok(run.executor.state.spentUsd > 0);
      }
      assert.equal(run.events.at(-1)?.type, "CALL_FAILED");
    }
  });

  it("allows only one retry across the whole run", async (t) => {
    let count = 0;
    const run = await arrange(t, async () => {
      count += 1;
      if (count !== 2)
        throw new ProviderCallError("TRANSPORT_UNSENT", "Retryable failure.", { retryable: true });
      return response();
    });
    await run.executor.complete(request(), "prompt-test");
    assert.equal(run.calls.length, 2);
    assert.equal(run.executor.state.retriesUsed, 1);
    await assert.rejects(run.executor.complete(request("FINAL"), "prompt-test"));
    assert.equal(run.calls.length, 3);
    assert.equal(run.events.filter((event) => event.type === "PROVIDER_RETRY_REQUESTED").length, 1);
    assert.equal(run.sleeps.length, 1);
  });

  it("obeys both attempts-one policy and provider refusal to route a retry", async (t) => {
    const failure = async () => {
      throw new ProviderCallError("TRANSPORT_UNSENT", "Retryable failure.", { retryable: true });
    };
    const single = await arrange(t, failure, { maxAttemptsPerCall: 1 });
    await assert.rejects(single.executor.complete(request(), "prompt-test"));
    assert.equal(single.calls.length, 1);
    const declined = await arrange(t, failure);
    declined.provider.forRetry = () => null;
    await assert.rejects(declined.executor.complete(request(), "prompt-test"));
    assert.equal(declined.calls.length, 1);
    assert.equal(declined.executor.state.retriesUsed, 0);
  });

  it("uses the provider returned by retry routing", async (t) => {
    const run = await arrange(t, async () => {
      throw new ProviderCallError("TRANSPORT_UNSENT", "Retryable failure.", { retryable: true });
    });
    let routedCalls = 0;
    run.provider.forRetry = () => ({
      auditRequest: audit,
      complete: async () => {
        routedCalls += 1;
        return response();
      },
    });
    await run.executor.complete(request(), "prompt-test");
    assert.equal(run.calls.length, 1);
    assert.equal(routedCalls, 1);
    assert.equal(run.executor.state.nextAttempt, 3);
  });

  it("refuses stages already completed or locally skipped", async (t) => {
    const run = await arrange(t);
    await run.executor.complete(request(), "prompt-test");
    await assert.rejects(run.executor.complete(request(), "prompt-test"));
    run.executor.skip("FINDING_VERIFICATION");
    await assert.rejects(run.executor.complete(request("FINDING_VERIFICATION"), "prompt-test"));
    assert.equal(run.calls.length, 1);
  });

  it("reserves remaining stages and rejects oversized actual requests before provider I/O", async (t) => {
    const run = await arrange(t);
    const tight = {
      ...run.config,
      budgets: { ...run.config.budgets, maxTotalTokens: run.admission.requiredWithRetry },
    };
    const executor = new ClaimCallExecutorV1({ ...run.options, config: tight });
    const oversized = {
      ...request(),
      messages: [{ role: "user" as const, content: "x".repeat(run.admission.requiredWithRetry) }],
    };
    await assert.rejects(executor.complete(oversized, "prompt-test"));
    assert.equal(run.calls.length, 0);
    assert.equal(
      run.events.some((event) => event.type === "CALL_STARTED"),
      false,
    );
  });

  it("charges an over-budget successful response before rejecting it", async (t) => {
    const run = await arrange(t, async () =>
      response({ promptTokens: 1_000_000, completionTokens: 1, totalTokens: 1_000_001, cost: 101 }),
    );
    await assert.rejects(run.executor.complete(request(), "prompt-test"));
    assert.equal(run.executor.state.spentTokens, 1_000_001);
    assert.equal(run.executor.state.spentUsd, 101);
    assert.equal(run.calls.length, 1);
    assert.ok(run.events.some((event) => event.type === "CALL_SUCCEEDED"));
  });

  it("reports a structured token-budget-exhausted event before rejecting an over-budget response", async (t) => {
    const baseline = await arrange(t);
    const threshold = baseline.admission.requiredWithRetry;
    const run = await arrange(
      t,
      async () =>
        response({
          promptTokens: threshold,
          completionTokens: threshold,
          totalTokens: threshold * 2,
          cost: 0.01,
        }),
      { maxTotalTokens: threshold },
    );
    await assert.rejects(run.executor.complete(request(), "prompt-test"));
    const exhausted = run.events.find((event) => event.type === "TOKEN_BUDGET_EXHAUSTED");
    assert.ok(exhausted);
    assert.equal(exhausted.phase, "REPORTED");
    assert.equal(exhausted.spentTokens, run.executor.state.spentTokens);
    assert.ok(run.events.every((event) => event.type !== "BUDGET_EXHAUSTED"));
  });

  it("rejects insufficient remaining cost before starting another call", async (t) => {
    const run = await arrange(t);
    const executor = new ClaimCallExecutorV1({
      ...run.options,
      config: { ...run.config, budgets: { ...run.config.budgets, maxTotalCostUsd: 0.001 } },
    });
    await assert.rejects(executor.complete(request(), "prompt-test"));
    assert.equal(run.calls.length, 0);
    assert.equal(
      run.events.some((event) => event.type === "CALL_STARTED"),
      false,
    );
  });

  it("rejects an unrequested returned model after accounting for the response", async (t) => {
    const run = await arrange(t, async () => ({ ...response(), model: "unexpected/model" }));
    await assert.rejects(run.executor.complete(request(), "prompt-test"));
    assert.equal(run.calls.length, 1);
    assert.equal(run.executor.state.spentTokens, 30);
    assert.equal(run.executor.state.spentUsd, 0.01);
  });
});
