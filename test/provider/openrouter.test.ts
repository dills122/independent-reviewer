import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OpenRouterProviderV1, ProviderCallError, sha256Utf8 } from "../../src/index.js";

const request = {
  stage: "PRELIMINARY" as const,
  model: "vendor/model",
  maxOutputTokens: 500,
  timeoutMs: 5_000,
  messages: [
    { role: "system" as const, content: "Trusted policy" },
    { role: "user" as const, content: "Untrusted evidence" },
  ],
  responseSchema: {
    name: "preliminary_assessment_v1",
    schema: { type: "object", additionalProperties: false },
  },
};

const providerRouting = {
  order: ["provider-a/fp4", "provider-b/bf16"],
  maxPrice: { prompt: 0.03, completion: 0.14, request: 0 },
};

describe("OpenRouterProviderV1", () => {
  it("uses strict structured output and explicit privacy and routing controls", async () => {
    let capturedInput: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const provider = new OpenRouterProviderV1(
      "secret-key",
      providerRouting,
      async (input, init) => {
        capturedInput = input;
        capturedInit = init;
        return new Response(
          JSON.stringify({
            id: "generation-1",
            model: "vendor/model",
            provider: "Mock Provider",
            choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
            usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, cost: 0.001 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );

    const result = await provider.complete(request);

    assert.equal(capturedInput, "https://openrouter.ai/api/v1/chat/completions");
    const headers = new Headers(capturedInit?.headers);
    assert.equal(headers.get("authorization"), "Bearer secret-key");
    assert.equal(headers.get("x-openrouter-cache"), "false");
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    assert.deepEqual(body.provider, {
      order: ["provider-a/fp4", "provider-b/bf16"],
      only: ["provider-a/fp4", "provider-b/bf16"],
      allow_fallbacks: true,
      data_collection: "deny",
      max_price: { prompt: 0.03, completion: 0.14, request: 0 },
      require_parameters: true,
      zdr: true,
    });
    assert.deepEqual(body.plugins, [{ id: "context-compression", enabled: false }]);
    assert.deepEqual(result.value, { ok: true });
    assert.equal(result.usage.totalTokens, 25);
    assert.equal(result.provider, "Mock Provider");

    const audit = provider.auditRequest(request);
    assert.equal(audit.providerPolicyVersion, "openrouter-chat-completions-v2");
    assert.deepEqual(audit.wireBodyDigest, sha256Utf8(String(capturedInit?.body)));
    assert.equal(audit.wireBodyBytes, Buffer.byteLength(String(capturedInit?.body), "utf8"));
    assert.notDeepEqual(
      audit.credentialFreeWireRequestDigest,
      provider.auditRequest({ ...request, model: "vendor/another-model" })
        .credentialFreeWireRequestDigest,
    );
  });

  it("preserves bounded, credential-free diagnostics for an embedded provider error", async () => {
    const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () =>
      Response.json(
        {
          id: "generation-error-1",
          model: "vendor/model",
          provider: "Mock Provider",
          error: {
            code: 429,
            message: `Rate limited for secret-key ${"x".repeat(600)}`,
            metadata: {
              error_type: "rate_limit_exceeded",
              provider_code: "rate_limited",
              ignored_untrusted_field: "must not be persisted",
            },
          },
        },
        { headers: { "retry-after": "45" } },
      ),
    );

    await assert.rejects(
      () => provider.complete(request),
      (error: unknown) => {
        assert.ok(error instanceof ProviderCallError);
        assert.equal(error.code, "PROVIDER_ERROR");
        assert.doesNotMatch(error.message, /secret-key/);
        assert.match(error.message, /rate_limit_exceeded/);
        assert.deepEqual(
          { ...error.diagnostic, providerMessage: null },
          {
            httpStatus: 200,
            providerErrorCode: "429",
            providerMessage: null,
            errorType: "rate_limit_exceeded",
            providerCode: "rate_limited",
            providerName: "Mock Provider",
            model: "vendor/model",
            responseId: "generation-error-1",
            retryAfter: "45",
          },
        );
        const providerMessage = error.diagnostic?.providerMessage;
        assert.ok(providerMessage);
        assert.match(providerMessage, /^Rate limited for \[REDACTED\] x+/);
        assert.match(providerMessage, /\.\.\.$/);
        assert.ok(providerMessage.length <= 500);
        assert.doesNotMatch(JSON.stringify(error.diagnostic), /ignored_untrusted_field/);
        return true;
      },
    );
  });

  it("recognizes provider errors nested in a non-streaming completion choice", async () => {
    const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () =>
      Response.json({
        id: "generation-error-2",
        model: "vendor/model",
        provider: "Mock Provider",
        choices: [
          {
            finish_reason: "error",
            message: { content: "partial output" },
            error: {
              code: 502,
              message: "Provider disconnected",
              metadata: { error_type: "provider_unavailable" },
            },
          },
        ],
      }),
    );

    await assert.rejects(
      () => provider.complete(request),
      (error: unknown) => {
        assert.ok(error instanceof ProviderCallError);
        assert.equal(error.diagnostic?.providerErrorCode, "502");
        assert.equal(error.diagnostic?.errorType, "provider_unavailable");
        assert.equal(error.diagnostic?.responseId, "generation-error-2");
        return true;
      },
    );
  });

  it("treats a fetch failure after submission as transport-uncertain", async () => {
    const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () => {
      throw new TypeError("connection lost");
    });

    await assert.rejects(
      () => provider.complete(request),
      (error: unknown) =>
        error instanceof ProviderCallError && error.code === "TRANSPORT_UNCERTAIN",
    );
  });

  it("rejects fractional or internally inconsistent token usage", async () => {
    for (const usage of [
      { prompt_tokens: 20.5, completion_tokens: 5, total_tokens: 25.5 },
      { prompt_tokens: 20, completion_tokens: 5, total_tokens: 0 },
    ]) {
      const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () =>
        Response.json({
          choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
          usage,
        }),
      );

      await assert.rejects(
        () => provider.complete(request),
        (error: unknown) => error instanceof ProviderCallError && error.code === "INVALID_RESPONSE",
      );
    }
  });

  it("rejects a response from a different model", async () => {
    const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () =>
      Response.json({
        model: "vendor/different-model",
        choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
      }),
    );

    await assert.rejects(
      () => provider.complete(request),
      (error: unknown) =>
        error instanceof ProviderCallError &&
        error.code === "INVALID_RESPONSE" &&
        /different model/i.test(error.message),
    );
  });
});
