import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OpenRouterProviderV1, ProviderCallError, sha256Utf8 } from "../../src/index.js";

const request = {
  stage: "PRELIMINARY" as const,
  models: ["vendor/model", "vendor/fallback-model"],
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

const providerRouting = {
  order: ["provider-a/fp4", "provider-b/bf16"],
  maxPrice: { prompt: 0.5, completion: 1.5, request: 0 },
};

describe("OpenRouterProviderV1", () => {
  it("keeps provider failover available and sends the model fallback chain", async () => {
    let wire: Record<string, unknown> = {};
    const provider = new OpenRouterProviderV1(
      "secret-key",
      providerRouting,
      async (_input, init) => {
        wire = JSON.parse(String(init?.body));
        return Response.json({
          model: "vendor/fallback-model",
          choices: [{ finish_reason: "stop", message: { content: "{}" } }],
        });
      },
    );

    await provider.complete(finalRequest);

    assert.equal(wire.stream, false);
    assert.equal(wire.model, "vendor/model");
    assert.deepEqual(wire.models, ["vendor/model", "vendor/fallback-model"]);
    const routing = wire.provider as Record<string, unknown>;
    assert.deepEqual(routing.order, ["provider-a/fp4", "provider-b/bf16"]);
    assert.equal(routing.allow_fallbacks, true);
    assert.equal("only" in routing, false);
    assert.equal("zdr" in routing, false);
    assert.equal("data_collection" in routing, false);
  });

  it("sends privacy filters only when the run opts in", async () => {
    let wire: Record<string, unknown> = {};
    const provider = new OpenRouterProviderV1(
      "secret-key",
      {
        ...providerRouting,
        order: ["deepinfra/bf16"],
        pinToOrder: true,
        zeroDataRetention: true,
        denyDataCollection: true,
      },
      async (_input, init) => {
        wire = JSON.parse(String(init?.body));
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] });
      },
    );

    await provider.complete(request);

    const routing = wire.provider as Record<string, unknown>;
    assert.deepEqual(routing.only, ["deepinfra/bf16"]);
    assert.equal(routing.allow_fallbacks, false);
    assert.equal(routing.zdr, true);
    assert.equal(routing.data_collection, "deny");
  });

  it("excludes the endpoint that just failed from the next attempt", async () => {
    let wire: Record<string, unknown> = {};
    const provider = new OpenRouterProviderV1(
      "secret-key",
      providerRouting,
      async (_input, init) => {
        wire = JSON.parse(String(init?.body));
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] });
      },
    );
    const retry = provider.forRetry(
      new ProviderCallError("PROVIDER_ERROR", "overloaded", {
        retryable: true,
        diagnostic: {
          httpStatus: 429,
          providerErrorCode: "429",
          providerMessage: null,
          errorType: null,
          providerCode: null,
          providerName: "Provider A",
          model: null,
          responseId: null,
          retryAfter: null,
        },
      }),
      request,
    );

    assert.ok(retry);
    await retry.complete(request);
    const routing = wire.provider as Record<string, unknown>;
    assert.deepEqual(routing.ignore, ["Provider A"]);
    assert.equal(routing.allow_fallbacks, true);
  });

  it("gives up when a pinned run has no other configured endpoint", async () => {
    const pinned = new OpenRouterProviderV1(
      "secret-key",
      { ...providerRouting, order: ["provider-a/fp4"], pinToOrder: true },
      async () => Response.json({}),
    );

    assert.equal(
      pinned.forRetry(new ProviderCallError("PROVIDER_ERROR", "overloaded"), finalRequest),
      null,
    );
  });

  it("retries a missing finish reason but not an explicit one", async () => {
    const outcomes: Array<[unknown, boolean]> = [
      [undefined, true],
      [null, true],
      ["length", false],
      ["content_filter", false],
    ];
    for (const [finishReason, retryable] of outcomes) {
      const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () =>
        Response.json({
          model: "vendor/model",
          choices: [
            {
              ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
              message: { content: '{"ok":true}' },
            },
          ],
        }),
      );
      await assert.rejects(
        () => provider.complete(request),
        (error: unknown) => {
          assert.ok(error instanceof ProviderCallError);
          assert.equal(error.code, "INVALID_RESPONSE");
          assert.equal(error.retryable, retryable);
          return true;
        },
      );
    }
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
      allow_fallbacks: true,
      max_price: { prompt: 0.5, completion: 1.5, request: 0 },
      require_parameters: true,
    });
    assert.deepEqual(body.plugins, [{ id: "context-compression", enabled: false }]);
    assert.deepEqual(result.value, { ok: true });
    assert.equal(result.usage.totalTokens, 25);
    assert.equal(result.provider, "Mock Provider");

    const audit = provider.auditRequest(request);
    assert.equal(audit.providerPolicyVersion, "openrouter-chat-completions-v5");
    assert.deepEqual(audit.wireBodyDigest, sha256Utf8(String(capturedInit?.body)));
    assert.equal(audit.wireBodyBytes, Buffer.byteLength(String(capturedInit?.body), "utf8"));
    assert.notDeepEqual(
      audit.credentialFreeWireRequestDigest,
      provider.auditRequest({ ...request, models: ["vendor/another-model"] })
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

  it("rejects ambiguous or non-strict OpenRouter envelopes without retaining their bodies", async () => {
    const apiKey = "synthetic-credential";
    const validChoice = '"choices":[{"finish_reason":"stop","message":{"content":"{}"}}]';
    const cases = [
      `{${validChoice},"duplicate":"first","duplicate":"second"}`,
      `{${validChoice},"sentinel":"safe","\\u0073entinel":"${apiKey}"}`,
      `{${validChoice},/* sentinel ${apiKey} */"commented":true}`,
      `{${validChoice},"trailing":true,}`,
      `{${validChoice},"malformed":}`,
    ];

    for (const rawBody of cases) {
      const provider = new OpenRouterProviderV1(apiKey, providerRouting, async () =>
        Promise.resolve(
          new Response(rawBody, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );

      await assert.rejects(
        () => provider.complete(request),
        (error: unknown) => {
          assert.ok(error instanceof ProviderCallError);
          assert.equal(error.code, "INVALID_RESPONSE");
          assert.match(error.message, /strict JSON admission/i);
          assert.doesNotMatch(error.message, /synthetic-credential|sentinel|duplicate|commented/);
          assert.equal(error.responseBody, null);
          assert.equal(error.responseMetadata, null);
          assert.equal(error.diagnostic, null);
          return true;
        },
      );
    }
  });

  it("rejects ambiguous or non-strict structured completions without retaining the envelope", async () => {
    const apiKey = "synthetic-credential";
    const contents = [
      '{"duplicate":"first","duplicate":"second"}',
      `{"sentinel":"safe","\\u0073entinel":"${apiKey}"}`,
      `{"ok":true/* sentinel ${apiKey} */}`,
      '{"ok":true,}',
      '{"ok":',
    ];

    for (const content of contents) {
      const provider = new OpenRouterProviderV1(apiKey, providerRouting, async () =>
        Response.json({
          id: "generation-non-strict",
          model: "vendor/model",
          provider: "Mock Provider",
          choices: [{ finish_reason: "stop", message: { content } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.003 },
        }),
      );

      await assert.rejects(
        () => provider.complete(request),
        (error: unknown) => {
          assert.ok(error instanceof ProviderCallError);
          assert.equal(error.code, "INVALID_RESPONSE");
          assert.match(error.message, /strict JSON admission/i);
          assert.doesNotMatch(error.message, /synthetic-credential|sentinel|duplicate/);
          assert.equal(error.responseBody, null);
          assert.deepEqual(error.responseMetadata, {
            responseId: "generation-non-strict",
            model: "vendor/model",
            provider: "Mock Provider",
            finishReason: "stop",
            usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cost: 0.003 },
          });
          assert.equal(error.diagnostic, null);
          return true;
        },
      );
    }
  });

  it("rejects invalid UTF-8 response bytes without accepting or retaining replacement text", async () => {
    const prefix = new TextEncoder().encode(
      '{"choices":[{"finish_reason":"stop","message":{"content":"{}"}}],"extension":"',
    );
    const suffix = new TextEncoder().encode('"}');
    const bytes = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength);
    bytes.set(prefix);
    bytes[prefix.byteLength] = 0xff;
    bytes.set(suffix, prefix.byteLength + 1);
    const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () =>
      Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await assert.rejects(
      () => provider.complete(request),
      (error: unknown) => {
        assert.ok(error instanceof ProviderCallError);
        assert.equal(error.code, "INVALID_RESPONSE");
        assert.match(error.message, /UTF-8/i);
        assert.doesNotMatch(error.message, /\uFFFD/);
        assert.equal(error.responseBody, null);
        assert.equal(error.responseMetadata, null);
        assert.equal(error.diagnostic, null);
        return true;
      },
    );
  });

  it("preserves HTTP 429 retry diagnostics when its response body is invalid UTF-8", async () => {
    const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () =>
      Promise.resolve(
        new Response(new Uint8Array([0xff]), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "7" },
        }),
      ),
    );

    await assert.rejects(
      () => provider.complete(request),
      (error: unknown) => {
        assert.ok(error instanceof ProviderCallError);
        assert.equal(error.code, "PROVIDER_ERROR");
        assert.match(error.message, /HTTP 429/);
        assert.doesNotMatch(error.message, /UTF-8|encoded|decoder|0xff/i);
        assert.equal(error.cause, undefined);
        assert.equal(error.responseBody, null);
        assert.equal(error.responseMetadata, null);
        assert.equal(error.diagnostic?.httpStatus, 429);
        assert.equal(error.diagnostic?.providerErrorCode, "429");
        assert.equal(error.diagnostic?.retryAfter, "7");
        return true;
      },
    );
  });

  it("keeps a safe HTTP diagnostic when a rejected error envelope fails strict admission", async () => {
    const apiKey = "synthetic-credential";
    const provider = new OpenRouterProviderV1(apiKey, providerRouting, async () =>
      Promise.resolve(
        new Response(`{"sentinel":"${apiKey}","sentinel":"hidden"}`, {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "12" },
        }),
      ),
    );

    await assert.rejects(
      () => provider.complete(request),
      (error: unknown) => {
        assert.ok(error instanceof ProviderCallError);
        assert.equal(error.code, "PROVIDER_ERROR");
        assert.match(error.message, /HTTP 429/);
        assert.doesNotMatch(error.message, /synthetic-credential|sentinel|hidden/);
        assert.equal(error.responseBody, null);
        assert.equal(error.diagnostic?.httpStatus, 429);
        assert.equal(error.diagnostic?.providerErrorCode, "429");
        assert.equal(error.diagnostic?.retryAfter, "12");
        return true;
      },
    );
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

  it("rejects a response from a model outside the permitted set", async () => {
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
        /outside the permitted set/i.test(error.message),
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
        assert.equal(error.responseBody, null);
        assert.equal(error.responseMetadata, null);
        return true;
      },
    );
  });

  it("discards decoded credential reflections in nested values and object keys", async () => {
    const reflectedContents = [
      '{"outer":[{"echo":"\\u0073ecret-key"}]}',
      '{"outer":{"\\u0073ecret-key":"reflected as a key"}}',
    ];

    for (const content of reflectedContents) {
      const provider = new OpenRouterProviderV1("secret-key", providerRouting, async () =>
        Response.json({
          id: "generation-reflected-escaped",
          model: "vendor/model",
          provider: "Mock Provider",
          choices: [{ finish_reason: "stop", message: { content } }],
        }),
      );

      await assert.rejects(
        () => provider.complete(request),
        (error: unknown) => {
          assert.ok(error instanceof ProviderCallError);
          assert.equal(error.code, "INVALID_RESPONSE");
          assert.doesNotMatch(error.message, /secret-key/);
          assert.equal(error.responseBody, null);
          assert.equal(error.responseMetadata, null);
          assert.equal(error.diagnostic, null);
          return true;
        },
      );
    }
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
