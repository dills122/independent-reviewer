import * as z from "zod";

import {
  OpenRouterProviderRoutingV1Schema,
  sha256Utf8,
  type OpenRouterProviderRoutingV1,
} from "../contracts/index.js";
import {
  ProviderCallError,
  type ProviderErrorDiagnosticV1,
  type ReviewProviderRequestV1,
  type ReviewProviderResponseV1,
  type ReviewProviderV1,
} from "./review-provider.js";

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_PROVIDER_POLICY_VERSION_V2 = "openrouter-chat-completions-v2";
const OPENROUTER_PUBLIC_HEADERS_V1 = {
  "content-type": "application/json",
  "x-openrouter-cache": "false",
} as const;

export { ProviderCallError } from "./review-provider.js";
export type {
  ProviderCallErrorCode,
  ProviderCallErrorOptions,
  ProviderErrorDiagnosticV1,
} from "./review-provider.js";

const TokenUsageSchema = z
  .object({
    prompt_tokens: z.int().nonnegative().optional(),
    completion_tokens: z.int().nonnegative().optional(),
    total_tokens: z.int().nonnegative().optional(),
    cost: z.number().nonnegative().optional(),
  })
  .superRefine((usage, context) => {
    if (
      usage.prompt_tokens !== undefined &&
      usage.completion_tokens !== undefined &&
      usage.total_tokens !== undefined &&
      usage.prompt_tokens + usage.completion_tokens !== usage.total_tokens
    ) {
      context.addIssue({ code: "custom", message: "token usage totals are inconsistent" });
    }
  });

const OpenRouterResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string(),
  provider: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        message: z.object({ content: z.string() }),
      }),
    )
    .min(1),
  usage: TokenUsageSchema.optional(),
});

function safeProviderErrorLabel(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "unknown";
  }
  const code = (value as { code?: unknown }).code;
  if (typeof code === "number" && Number.isFinite(code)) {
    return String(code);
  }
  if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(code)) {
    return code;
  }
  return "unknown";
}

function boundedText(value: unknown, maximum: number, redaction: string): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const withoutControls = Array.from(value.replaceAll(redaction, "[REDACTED]"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
  }).join("");
  const singleLine = withoutControls.replace(/\s+/g, " ").trim();
  if (singleLine.length === 0) {
    return null;
  }
  const characters = Array.from(singleLine);
  return characters.length <= maximum
    ? singleLine
    : `${characters.slice(0, maximum - 3).join("")}...`;
}

function providerErrorFromBody(body: unknown): unknown {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  if ("error" in body) {
    return (body as { error?: unknown }).error;
  }
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) {
    return undefined;
  }
  const choice = choices[0];
  return choice && typeof choice === "object" && "error" in choice
    ? (choice as { error?: unknown }).error
    : undefined;
}

function providerErrorDiagnostic(
  body: unknown,
  error: unknown,
  response: Response,
  apiKey: string,
): ProviderErrorDiagnosticV1 {
  const envelope = body && typeof body === "object" ? body : {};
  const errorObject = error && typeof error === "object" ? error : {};
  const metadataValue = (errorObject as { metadata?: unknown }).metadata;
  const metadata = metadataValue && typeof metadataValue === "object" ? metadataValue : {};
  return {
    httpStatus: response.status,
    providerErrorCode: safeProviderErrorLabel(errorObject),
    providerMessage: boundedText((errorObject as { message?: unknown }).message, 500, apiKey),
    errorType: boundedText((metadata as { error_type?: unknown }).error_type, 80, apiKey),
    providerCode: boundedText((metadata as { provider_code?: unknown }).provider_code, 80, apiKey),
    providerName:
      boundedText((envelope as { provider?: unknown }).provider, 120, apiKey) ??
      boundedText((metadata as { provider_name?: unknown }).provider_name, 120, apiKey),
    model:
      boundedText((envelope as { model?: unknown }).model, 160, apiKey) ??
      boundedText((metadata as { model_slug?: unknown }).model_slug, 160, apiKey),
    responseId: boundedText((envelope as { id?: unknown }).id, 160, apiKey),
    retryAfter: boundedText(response.headers.get("retry-after"), 120, apiKey),
  };
}

function providerErrorMessage(diagnostic: ProviderErrorDiagnosticV1): string {
  const type = diagnostic.errorType ? ` (${diagnostic.errorType})` : "";
  const provider = diagnostic.providerName ? ` from ${diagnostic.providerName}` : "";
  const message = diagnostic.providerMessage ? `: ${diagnostic.providerMessage}` : "";
  return `OpenRouter reported provider error ${diagnostic.providerErrorCode}${type}${provider}${message}.`;
}

function openRouterWireBodyV2(
  request: ReviewProviderRequestV1,
  routing: OpenRouterProviderRoutingV1,
): string {
  return JSON.stringify({
    model: request.model,
    messages: request.messages,
    stream: false,
    max_tokens: request.maxOutputTokens,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: request.responseSchema.name,
        strict: true,
        schema: request.responseSchema.schema,
      },
    },
    provider: {
      order: routing.order,
      only: routing.order,
      allow_fallbacks: true,
      data_collection: "deny",
      max_price: routing.maxPrice,
      require_parameters: true,
      zdr: true,
    },
    // OpenRouter context compression may remove middle messages.
    plugins: [{ id: "context-compression", enabled: false }],
  });
}

/**
 * Minimal non-streaming OpenRouter adapter. Routing/privacy fields follow the
 * official Chat Completions and provider-routing contracts:
 * https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion
 * https://openrouter.ai/docs/guides/routing/provider-selection
 */
export class OpenRouterProviderV1 implements ReviewProviderV1 {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #routing: OpenRouterProviderRoutingV1;

  constructor(apiKey: string, routingValue: unknown, fetchImplementation: typeof fetch = fetch) {
    if (apiKey.trim().length === 0) {
      throw new ProviderCallError("INVALID_CONFIGURATION", "OpenRouter API key is required.");
    }
    this.#apiKey = apiKey;
    this.#routing = OpenRouterProviderRoutingV1Schema.parse(routingValue);
    this.#fetch = fetchImplementation;
  }

  auditRequest(request: ReviewProviderRequestV1) {
    const wireBody = openRouterWireBodyV2(request, this.#routing);
    const credentialFreeWireRequest = JSON.stringify({
      url: OPENROUTER_CHAT_COMPLETIONS_URL,
      method: "POST",
      headers: OPENROUTER_PUBLIC_HEADERS_V1,
      body: wireBody,
    });
    return {
      providerPolicyVersion: OPENROUTER_PROVIDER_POLICY_VERSION_V2,
      wireBodyDigest: sha256Utf8(wireBody),
      wireBodyBytes: Buffer.byteLength(wireBody, "utf8"),
      credentialFreeWireRequestDigest: sha256Utf8(credentialFreeWireRequest),
    };
  }

  async complete(request: ReviewProviderRequestV1): Promise<ReviewProviderResponseV1> {
    const wireBody = openRouterWireBodyV2(request, this.#routing);
    let response: Response;
    try {
      response = await this.#fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          ...OPENROUTER_PUBLIC_HEADERS_V1,
        },
        body: wireBody,
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (error) {
      throw new ProviderCallError(
        "TRANSPORT_UNCERTAIN",
        "OpenRouter transport failed after the request may have been submitted; it was not retried.",
        { cause: error },
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new ProviderCallError(
        "INVALID_RESPONSE",
        `OpenRouter returned a non-JSON response (HTTP ${response.status}).`,
        { cause: error },
      );
    }

    // OpenRouter can report generation errors inside an HTTP 200 response.
    // https://openrouter.ai/docs/api_reference/errors-and-debugging
    const providerError = providerErrorFromBody(body);
    if (providerError !== undefined) {
      const diagnostic = providerErrorDiagnostic(body, providerError, response, this.#apiKey);
      throw new ProviderCallError("PROVIDER_ERROR", providerErrorMessage(diagnostic), {
        diagnostic,
      });
    }
    if (!response.ok) {
      throw new ProviderCallError(
        "PROVIDER_ERROR",
        `OpenRouter request failed (HTTP ${response.status}).`,
      );
    }

    const parsed = OpenRouterResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProviderCallError(
        "INVALID_RESPONSE",
        "OpenRouter response did not match the expected envelope.",
      );
    }
    const choice = parsed.data.choices[0];
    if (choice?.finish_reason !== "stop") {
      throw new ProviderCallError(
        "INVALID_RESPONSE",
        `OpenRouter response did not complete normally (finish reason: ${choice?.finish_reason ?? "missing"}).`,
      );
    }
    if (parsed.data.model !== request.model) {
      throw new ProviderCallError(
        "INVALID_RESPONSE",
        `OpenRouter returned a different model than requested (${parsed.data.model}).`,
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(choice.message.content) as unknown;
    } catch (error) {
      throw new ProviderCallError(
        "INVALID_RESPONSE",
        "OpenRouter returned malformed structured JSON.",
        {
          cause: error,
        },
      );
    }

    const usage = parsed.data.usage;
    return {
      value,
      rawContent: choice.message.content,
      responseId: parsed.data.id ?? null,
      model: parsed.data.model,
      provider: parsed.data.provider ?? null,
      usage: {
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
        totalTokens: usage?.total_tokens ?? null,
        cost: usage?.cost ?? null,
      },
    };
  }
}
