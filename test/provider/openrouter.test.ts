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

const finalRequest = {
  ...request,
  stage: "FINAL" as const,
  responseSchema: { ...request.responseSchema, name: "final_review_candidate_v2" },
};

function sseResponse(events: unknown[]): Response {
  const wire = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(wire, { headers: { "content-type": "text/event-stream" } });
}

const providerRouting = {
  order: ["provider-a/fp4", "provider-b/bf16"],
  maxPrice: { prompt: 0.03, completion: 0.14, request: 0 },
};

describe("OpenRouterProviderV1", () => {
  it("streams final output on one pinned endpoint and preserves terminal usage", async () => {
    let wire: Record<string, unknown> = {};
    const provider = new OpenRouterProviderV1(
      "secret-key",
      providerRouting,
      async (_input, init) => {
        wire = JSON.parse(String(init?.body));
        return sseResponse([
          {
            id: "generation-streamed",
            model: "vendor/model",
            provider: "Provider A",
            choices: [{ delta: { content: '{"ok":' }, finish_reason: null }],
          },
          { choices: [{ delta: { content: "true}" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
          {
            choices: [],
            usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, cost: 0.001 },
          },
        ]);
      },
    );

    const result = await provider.complete(finalRequest);

    assert.equal(wire.stream, true);
    assert.deepEqual(wire.stream_options, { include_usage: true });
    assert.deepEqual(wire.provider, {
      order: ["provider-a/fp4"],
      only: ["provider-a/fp4"],
      allow_fallbacks: false,
      data_collection: "deny",
      max_price: { prompt: 0.03, completion: 0.14, request: 0 },
      require_parameters: true,
      zdr: true,
    });
    assert.deepEqual(result.value, { ok: true });
    assert.equal(result.rawContent, '{"ok":true}');
    assert.equal(result.responseId, "generation-streamed");
    assert.equal(result.provider, "Provider A");
    assert.deepEqual(result.usage, {
      promptTokens: 20,
      completionTokens: 5,
      totalTokens: 25,
      cost: 0.001,
    });
    assert.equal(provider.auditRequest(finalRequest).requestedProviderEndpoint, "provider-a/fp4");
    assert.equal(
      provider.auditRequest(finalRequest).providerPolicyVersion,
      "openrouter-chat-completions-v4",
    );
  });

  it("aborts runaway formatting whitespace with credential-screened diagnostics", async () => {
    let cancelled = false;
    const event = JSON.stringify({
      diagnostic: "secret-key",
      choices: [{ delta: { content: `{"ok":true}${" ".repeat(512)}` }, finish_reason: null }],
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${event}\n\n`));
      },
      cancel() {
        cancelled = true;
      },
    });
    const provider = new OpenRouterProviderV1(
      "secret-key",
      providerRouting,
      async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );

    await assert.rejects(
      () => provider.complete(finalRequest),
      (error: unknown) => {
        assert.ok(error instanceof ProviderCallError);
        assert.equal(error.code, "UNPRODUCTIVE_STREAM");
        assert.equal(error.retryable, true);
        assert.equal(error.responseMetadata?.provider, "provider-a/fp4");
        assert.deepEqual(error.responseMetadata?.usage, {
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          cost: null,
        });
        assert.doesNotMatch(JSON.stringify(error.responseBody), /secret-key/);
        assert.match(JSON.stringify(error.responseBody), /\[REDACTED\]/);
        return true;
      },
    );
    assert.equal(cancelled, true);
  });

  it("does not count whitespace inside streamed JSON strings", async () => {
    const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () =>
      sseResponse([
        {
          model: "vendor/model",
          choices: [{ delta: { content: `{"text":"${" ".repeat(600)}` }, finish_reason: null }],
        },
        { choices: [{ delta: { content: '"}' }, finish_reason: "stop" }] },
      ]),
    );

    const result = await provider.complete(finalRequest);
    assert.deepEqual(result.value, { text: " ".repeat(600) });
  });

  it("retains partial streamed diagnostics when the body fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              model: "vendor/model",
              choices: [{ delta: { content: '{"ok":' }, finish_reason: null }],
            })}\n\n`,
          ),
        );
        controller.error(new DOMException("connection lost", "NetworkError"));
      },
    });
    const provider = new OpenRouterProviderV1(
      "secret-key",
      providerRouting,
      async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );

    await assert.rejects(
      () => provider.complete(finalRequest),
      (error: unknown) => {
        assert.ok(error instanceof ProviderCallError);
        assert.equal(error.code, "TRANSPORT_UNCERTAIN");
        assert.match(JSON.stringify(error.responseBody), /OPENROUTER_SSE/);
        assert.equal(error.responseMetadata?.provider, "provider-a/fp4");
        return true;
      },
    );
  });

  it("pins a final retry to a different configured endpoint", async () => {
    let wire: Record<string, unknown> = {};
    const provider = new OpenRouterProviderV1(
      "secret-key",
      providerRouting,
      async (_input, init) => {
        wire = JSON.parse(String(init?.body));
        return sseResponse([
          {
            model: "vendor/model",
            choices: [{ delta: { content: "{}" }, finish_reason: "stop" }],
          },
        ]);
      },
    );
    const retry = provider.forRetry(
      new ProviderCallError("UNPRODUCTIVE_STREAM", "stalled", { retryable: true }),
      finalRequest,
    );

    assert.ok(retry);
    await retry.complete(finalRequest);
    assert.deepEqual((wire.provider as { only: string[] }).only, ["provider-b/bf16"]);
    assert.equal(
      new OpenRouterProviderV1(
        "secret-key",
        { ...providerRouting, order: ["provider-a/fp4"] },
        async () => sseResponse([]),
      ).forRetry(
        new ProviderCallError("UNPRODUCTIVE_STREAM", "stalled", { retryable: true }),
        finalRequest,
      ),
      null,
    );
  });

  it("pins one endpoint without silently falling back to another provider", async () => {
    let wire: Record<string, unknown> = {};
    const provider = new OpenRouterProviderV1(
      "secret-key",
      {
        ...providerRouting,
        order: ["deepinfra/bf16"],
      },
      async (_input, init) => {
        wire = JSON.parse(String(init?.body));
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] });
      },
    );
    await provider.complete(request);
    const routing = wire.provider as Record<string, unknown>;
    assert.deepEqual(routing.only, ["deepinfra/bf16"]);
    assert.deepEqual(routing.order, ["deepinfra/bf16"]);
    assert.equal(routing.allow_fallbacks, false);
    assert.equal(routing.zdr, true);
    assert.equal(routing.data_collection, "deny");
  });

  it("redacts rejected envelope labels and keeps invalid usage unknown", async () => {
    const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () =>
      Response.json({
        id: "secret-key",
        model: "secret-key",
        provider: "secret-key",
        choices: [{ finish_reason: "secret-key", message: { content: null } }],
        usage: { prompt_tokens: 1.5, completion_tokens: -1, total_tokens: "30", cost: -2 },
      }),
    );
    await assert.rejects(
      () => provider.complete(request),
      (error: unknown) => {
        assert.ok(error instanceof ProviderCallError);
        assert.doesNotMatch(error.message + JSON.stringify(error.responseMetadata), /secret-key/);
        assert.deepEqual(error.responseMetadata?.usage, {
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          cost: null,
        });
        return true;
      },
    );
  });

  it("retains safe usage and routing when null or truncated completions are rejected", async () => {
    for (const finishReason of ["stop", "length"]) {
      const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () =>
        Response.json({
          id: "generation-rejected",
          model: "vendor/model",
          provider: "Mock Provider",
          choices: [{ finish_reason: finishReason, message: { content: null } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.003 },
        }),
      );
      await assert.rejects(
        () => provider.complete(request),
        (error: unknown) => {
          assert.ok(error instanceof ProviderCallError);
          assert.equal(error.code, "INVALID_RESPONSE");
          assert.deepEqual(error.responseMetadata, {
            responseId: "generation-rejected",
            model: "vendor/model",
            provider: "Mock Provider",
            finishReason,
            usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cost: 0.003 },
          });
          return true;
        },
      );
    }
  });

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
    assert.equal(body.max_tokens, 500);
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
    assert.equal(audit.providerPolicyVersion, "openrouter-chat-completions-v4");
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
        assert.doesNotMatch(JSON.stringify(error.responseBody), /secret-key/);
        assert.match(JSON.stringify(error.responseBody), /\[REDACTED\]/);
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

  it("accepts optional envelope metadata and ignores unusable telemetry", async () => {
    const rawResponseBody = {
      choices: [
        {
          finish_reason: "stop",
          message: { content: '{"ok":true}', ignored_annotation: "provider-specific" },
          ignored_choice_field: true,
        },
      ],
      usage: {
        prompt_tokens: 20.5,
        completion_tokens: 5,
        total_tokens: 25.5,
        cost: "unknown",
      },
      ignored_envelope_field: true,
    };
    const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () =>
      Response.json(rawResponseBody),
    );

    const result = await provider.complete(request);

    assert.equal(result.model, null);
    assert.equal(result.provider, null);
    assert.deepEqual(result.usage, {
      promptTokens: null,
      completionTokens: 5,
      totalTokens: null,
      cost: null,
    });
    assert.deepEqual(result.rawResponseBody, rawResponseBody);
  });

  it("retains the raw provider body when the usable completion content is missing", async () => {
    const rawResponseBody = {
      id: "generation-invalid",
      model: "vendor/model",
      choices: [{ finish_reason: "stop", message: { content: null } }],
      provider_extension: { useful_for_diagnosis: true },
    };
    const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () =>
      Response.json(rawResponseBody),
    );

    await assert.rejects(
      () => provider.complete(request),
      (error: unknown) => {
        assert.ok(error instanceof ProviderCallError);
        assert.equal(error.code, "INVALID_RESPONSE");
        assert.match(error.message, /usable completion content/i);
        assert.deepEqual(error.responseBody, rawResponseBody);
        return true;
      },
    );
  });

  it("reports truncation before inspecting missing completion content", async () => {
    const rawResponseBody = {
      model: "vendor/model",
      choices: [{ finish_reason: "length", message: { content: null } }],
    };
    const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () =>
      Response.json(rawResponseBody),
    );

    await assert.rejects(
      () => provider.complete(request),
      (error: unknown) => {
        assert.ok(error instanceof ProviderCallError);
        assert.match(error.message, /finish reason: length/i);
        assert.deepEqual(error.responseBody, rawResponseBody);
        return true;
      },
    );
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
  it("classifies a body-phase abort as transport-uncertain, not a definite failure", async () => {
    const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () => {
      // fetch resolves on headers; the body then fails the way an aborted stalled body does.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":"x","choices":['));
          setTimeout(
            () => controller.error(new DOMException("The operation was aborted", "TimeoutError")),
            10,
          );
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });

    await assert.rejects(
      () => provider.complete({ ...request, timeoutMs: 200 }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderCallError);
        assert.equal(error.code, "TRANSPORT_UNCERTAIN");
        return true;
      },
    );
  });

  it("rejects a response body larger than the response cap", async () => {
    const oversized = "y".repeat(9 * 1024 * 1024);
    const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () =>
      Response.json({
        id: "generation-large",
        model: "vendor/model",
        choices: [{ finish_reason: "stop", message: { content: `{"padding":"${oversized}"}` } }],
      }),
    );

    await assert.rejects(
      () => provider.complete(request),
      (error: unknown) => {
        assert.ok(error instanceof ProviderCallError);
        assert.equal(error.code, "INVALID_RESPONSE");
        assert.match(error.message, /response cap/);
        return true;
      },
    );
  });

  it("rejects a response nested past the redaction depth limit", async () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 200; depth += 1) {
      nested = { nested };
    }
    const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () =>
      Response.json({
        id: "generation-deep",
        model: "vendor/model",
        choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
        deep: nested,
      }),
    );

    await assert.rejects(
      () => provider.complete(request),
      (error: unknown) => {
        assert.ok(error instanceof ProviderCallError);
        assert.equal(error.code, "INVALID_RESPONSE");
        assert.match(error.message, /nests deeper/);
        return true;
      },
    );
  });

  it("discards a successful response whose fields reflect the credential", async () => {
    const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () =>
      Response.json({
        id: "generation-reflected",
        model: "vendor/model",
        choices: [
          { finish_reason: "stop", message: { content: '{"echo":"your key is secret-key"}' } },
        ],
      }),
    );

    await assert.rejects(
      () => provider.complete(request),
      (error: unknown) => {
        assert.ok(error instanceof ProviderCallError);
        assert.equal(error.code, "INVALID_RESPONSE");
        assert.doesNotMatch(error.message, /secret-key/);
        return true;
      },
    );
  });

  it("does not echo a credential-shaped provider error code", async () => {
    const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () =>
      Response.json({
        id: "generation-error-2",
        model: "vendor/model",
        error: { code: "secret-key", message: "rejected" },
      }),
    );

    await assert.rejects(
      () => provider.complete(request),
      (error: unknown) => {
        assert.ok(error instanceof ProviderCallError);
        assert.equal(error.code, "PROVIDER_ERROR");
        assert.equal(error.diagnostic?.providerErrorCode, "unknown");
        assert.doesNotMatch(error.message, /secret-key/);
        return true;
      },
    );
  });
});
