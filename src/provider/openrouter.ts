import * as z from "zod";

import { sha256Utf8 } from "../contracts/index.js";
import type {
  ReviewProviderRequestV1,
  ReviewProviderResponseV1,
  ReviewProviderV1,
} from "./review-provider.js";

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_PROVIDER_POLICY_VERSION_V1 = "openrouter-chat-completions-v1";
const OPENROUTER_PUBLIC_HEADERS_V1 = {
  "content-type": "application/json",
  "x-openrouter-cache": "false",
} as const;

export type ProviderCallErrorCode =
  | "INVALID_CONFIGURATION"
  | "PROVIDER_ERROR"
  | "INVALID_RESPONSE"
  | "TRANSPORT_UNCERTAIN";

export class ProviderCallError extends Error {
  readonly code: ProviderCallErrorCode;

  constructor(code: ProviderCallErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderCallError";
    this.code = code;
  }
}

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
  model: z.string().optional(),
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

function openRouterWireBodyV1(request: ReviewProviderRequestV1): string {
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
      allow_fallbacks: false,
      data_collection: "deny",
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

  constructor(apiKey: string, fetchImplementation: typeof fetch = fetch) {
    if (apiKey.trim().length === 0) {
      throw new ProviderCallError("INVALID_CONFIGURATION", "OpenRouter API key is required.");
    }
    this.#apiKey = apiKey;
    this.#fetch = fetchImplementation;
  }

  auditRequest(request: ReviewProviderRequestV1) {
    const wireBody = openRouterWireBodyV1(request);
    const credentialFreeWireRequest = JSON.stringify({
      url: OPENROUTER_CHAT_COMPLETIONS_URL,
      method: "POST",
      headers: OPENROUTER_PUBLIC_HEADERS_V1,
      body: wireBody,
    });
    return {
      providerPolicyVersion: OPENROUTER_PROVIDER_POLICY_VERSION_V1,
      wireBodyDigest: sha256Utf8(wireBody),
      wireBodyBytes: Buffer.byteLength(wireBody, "utf8"),
      credentialFreeWireRequestDigest: sha256Utf8(credentialFreeWireRequest),
    };
  }

  async complete(request: ReviewProviderRequestV1): Promise<ReviewProviderResponseV1> {
    const wireBody = openRouterWireBodyV1(request);
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
    if (body && typeof body === "object" && "error" in body) {
      throw new ProviderCallError(
        "PROVIDER_ERROR",
        `OpenRouter reported provider error ${safeProviderErrorLabel((body as { error?: unknown }).error)}.`,
      );
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
      model: parsed.data.model ?? null,
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
