import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OpenRouterProviderV1, ProviderCallError } from "../../src/index.js";

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

describe("OpenRouterProviderV1", () => {
  it("uses strict structured output and explicit privacy and routing controls", async () => {
    let capturedInput: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const provider = new OpenRouterProviderV1("secret-key", async (input, init) => {
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
    });

    const result = await provider.complete(request);

    assert.equal(capturedInput, "https://openrouter.ai/api/v1/chat/completions");
    const headers = new Headers(capturedInit?.headers);
    assert.equal(headers.get("authorization"), "Bearer secret-key");
    assert.equal(headers.get("x-openrouter-cache"), "false");
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    assert.deepEqual(body.provider, {
      allow_fallbacks: false,
      data_collection: "deny",
      require_parameters: true,
      zdr: true,
    });
    assert.deepEqual(body.plugins, [{ id: "context-compression", enabled: false }]);
    assert.deepEqual(result.value, { ok: true });
    assert.equal(result.usage.totalTokens, 25);
    assert.equal(result.provider, "Mock Provider");
  });

  it("rejects an error embedded in an HTTP 200 response", async () => {
    const provider = new OpenRouterProviderV1("secret-key", async () =>
      Response.json({ error: { code: 429, message: "Rate limited" } }),
    );

    await assert.rejects(
      () => provider.complete(request),
      (error: unknown) => error instanceof ProviderCallError && error.code === "PROVIDER_ERROR",
    );
  });

  it("treats a fetch failure after submission as transport-uncertain", async () => {
    const provider = new OpenRouterProviderV1("secret-key", async () => {
      throw new TypeError("connection lost");
    });

    await assert.rejects(
      () => provider.complete(request),
      (error: unknown) =>
        error instanceof ProviderCallError && error.code === "TRANSPORT_UNCERTAIN",
    );
  });
});
