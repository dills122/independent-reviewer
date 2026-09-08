import * as z from "zod";

import type {
  ReviewProviderRequestV1,
  ReviewProviderResponseV1,
  ReviewProviderV1,
} from "./review-provider.js";

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

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
  usage: z
    .object({
      prompt_tokens: z.number().nonnegative().optional(),
      completion_tokens: z.number().nonnegative().optional(),
      total_tokens: z.number().nonnegative().optional(),
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
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

  async complete(request: ReviewProviderRequestV1): Promise<ReviewProviderResponseV1> {
    let response: Response;
    try {
      response = await this.#fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
          // Response caching is opt-in, but make the live-review policy explicit.
          "x-openrouter-cache": "false",
        },
        body: JSON.stringify({
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
        }),
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
