import * as z from "zod";
import { ProviderCallPacerV1 } from "./call-pacing.js";

import {
  OpenRouterProviderRoutingV2Schema,
  sha256Utf8,
  type OpenRouterProviderRoutingV2,
} from "../contracts/index.js";
import { parseStrictJsonV1 } from "../contracts/strict-json.js";
import {
  ProviderCallError,
  type ProviderErrorDiagnosticV1,
  type ProviderResponseMetadataV1,
  type ReviewProviderRequestV1,
  type ReviewProviderResponseV1,
  type ReviewProviderV1,
} from "./review-provider.js";

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_PROVIDER_POLICY_VERSION_V5 = "openrouter-chat-completions-v5";
/** Shared by every provider instance that is not handed an explicit pacer, including tests. */
const sharedCallPacer = new ProviderCallPacerV1();
const OPENROUTER_PUBLIC_HEADERS_V1 = {
  "content-type": "application/json",
  "x-openrouter-cache": "false",
} as const;
/** Ceiling on a single provider response; a review reply is orders of magnitude smaller. */
const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Nesting ceiling for credential redaction, so a hostile body cannot overflow the stack. */
const MAX_REDACTION_DEPTH = 64;
/** Below this length a credential is too short to search for without absurd false positives. */
const MIN_CREDENTIAL_MATCH_LENGTH = 8;

export { ProviderCallError } from "./review-provider.js";
export type {
  ProviderCallErrorCode,
  ProviderCallErrorOptions,
  ProviderErrorDiagnosticV1,
} from "./review-provider.js";

const OpenRouterResponseSchema = z
  .object({
    id: z.unknown().optional(),
    model: z.unknown().optional(),
    provider: z.unknown().optional(),
    choices: z
      .array(
        z
          .object({
            finish_reason: z.unknown().optional(),
            message: z.looseObject({ content: z.unknown() }),
          })
          .loose(),
      )
      .min(1),
    usage: z.unknown().optional(),
  })
  .loose();

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function nullableNonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizedUsage(value: unknown): ReviewProviderResponseV1["usage"] {
  const usage = value && typeof value === "object" ? value : {};
  const promptTokens = nullableNonnegativeInteger(
    (usage as { prompt_tokens?: unknown }).prompt_tokens,
  );
  const completionTokens = nullableNonnegativeInteger(
    (usage as { completion_tokens?: unknown }).completion_tokens,
  );
  let totalTokens = nullableNonnegativeInteger((usage as { total_tokens?: unknown }).total_tokens);
  if (
    promptTokens !== null &&
    completionTokens !== null &&
    totalTokens !== null &&
    promptTokens + completionTokens !== totalTokens
  ) {
    totalTokens = null;
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cost: nullableNonnegativeNumber((usage as { cost?: unknown }).cost),
  };
}

function redactCredential(value: unknown, credential: string, depth = 0): unknown {
  if (depth > MAX_REDACTION_DEPTH) {
    throw new ProviderCallError(
      "INVALID_RESPONSE",
      `OpenRouter response nests deeper than ${MAX_REDACTION_DEPTH} levels.`,
    );
  }
  if (typeof value === "string") {
    return value.replaceAll(credential, "[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactCredential(item, credential, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replaceAll(credential, "[REDACTED]"),
        redactCredential(item, credential, depth + 1),
      ]),
    );
  }
  return value;
}

/**
 * Reads a response body with a hard byte ceiling instead of buffering whatever arrives.
 *
 * The request direction is bounded by the token budget and the Git side caps its reads; this was
 * the one unbounded direction left.
 */
async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ProviderCallError(
        "INVALID_RESPONSE",
        `OpenRouter response exceeded the ${maxBytes}-byte response cap.`,
      );
    }
    return text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks: string[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        throw new ProviderCallError(
          "INVALID_RESPONSE",
          `OpenRouter response exceeded the ${maxBytes}-byte response cap after ${byteLength} bytes.`,
        );
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

/** Reports whether a provider-supplied string reflects the credential back at us. */
function reflectsCredential(value: string, credential: string): boolean {
  return credential.length >= MIN_CREDENTIAL_MATCH_LENGTH && value.includes(credential);
}

function decodedJsonReflectsCredential(value: unknown, credential: string, depth = 0): boolean {
  if (depth > MAX_REDACTION_DEPTH) {
    throw new ProviderCallError(
      "INVALID_RESPONSE",
      `OpenRouter response nests deeper than ${MAX_REDACTION_DEPTH} levels.`,
    );
  }
  if (typeof value === "string") {
    return reflectsCredential(value, credential);
  }
  if (Array.isArray(value)) {
    return value.some((item) => decodedJsonReflectsCredential(item, credential, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).some(
      ([key, item]) =>
        reflectsCredential(key, credential) ||
        decodedJsonReflectsCredential(item, credential, depth + 1),
    );
  }
  return false;
}

function safeProviderErrorLabel(value: unknown, credential: string): string {
  if (!value || typeof value !== "object") {
    return "unknown";
  }
  const code = (value as { code?: unknown }).code;
  if (typeof code === "number" && Number.isFinite(code)) {
    return String(code);
  }
  // A credential is itself alphanumeric-with-dashes, so the shape check alone would pass it
  // through into error messages, the run ledger, and the report.
  if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(code)) {
    return reflectsCredential(code, credential) ? "unknown" : code;
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
  const limitSource = boundedText(
    (metadata as { limit_source?: unknown }).limit_source,
    80,
    apiKey,
  );
  const previous = (metadata as { previous_errors?: unknown }).previous_errors;
  const previousErrors = Array.isArray(previous)
    ? previous.slice(0, 3).map((entry: unknown) => {
        const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
        return {
          provider: boundedText(item.provider_name, 120, apiKey),
          code: boundedText(
            typeof item.code === "number" ? String(item.code) : item.code,
            80,
            apiKey,
          ),
        };
      })
    : undefined;
  return {
    ...(limitSource ? { limitSource } : {}),
    ...(previousErrors ? { previousErrors } : {}),
    httpStatus: response.status,
    providerErrorCode: safeProviderErrorLabel(errorObject, apiKey),
    providerMessage: boundedText((errorObject as { message?: unknown }).message, 500, apiKey),
    errorType: boundedText((metadata as { error_type?: unknown }).error_type, 80, apiKey),
    providerCode: boundedText(
      (metadata as { provider_code?: unknown }).provider_code ??
        (metadata as { provider_error_code?: unknown }).provider_error_code,
      80,
      apiKey,
    ),
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

function responseMetadata(body: unknown, apiKey: string): ProviderResponseMetadataV1 | null {
  const parsed = OpenRouterResponseSchema.safeParse(body);
  if (!parsed.success) return null;
  return {
    responseId: boundedText(parsed.data.id, 160, apiKey),
    model: boundedText(parsed.data.model, 160, apiKey),
    provider: boundedText(parsed.data.provider, 160, apiKey),
    finishReason: boundedText(parsed.data.choices[0]?.finish_reason, 80, apiKey),
    usage: normalizedUsage(parsed.data.usage),
  };
}

function openRouterWireBodyV5(
  request: ReviewProviderRequestV1,
  routing: OpenRouterProviderRoutingV2,
  ignoredProviders: readonly string[],
): string {
  const [model, ...fallbackModels] = request.models;
  return JSON.stringify({
    model,
    // Model fallback covers rate limiting, downtime, context-length and moderation refusals.
    // The orchestrator accepts any permitted model and records which one answered.
    ...(fallbackModels.length > 0 ? { models: request.models } : {}),
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
      // `order` is a preference. Pinning with `only` removes provider failover, which turns one
      // degraded endpoint into a failed review, so it stays opt-in and diagnostic.
      ...(routing.order ? { order: routing.order } : {}),
      ...(routing.pinToOrder && routing.order ? { only: routing.order } : {}),
      ...(ignoredProviders.length > 0 ? { ignore: [...ignoredProviders] } : {}),
      allow_fallbacks: !routing.pinToOrder,
      ...(routing.denyDataCollection ? { data_collection: "deny" } : {}),
      ...(routing.zeroDataRetention ? { zdr: true } : {}),
      max_price: routing.maxPrice,
      // Structured output is a hard requirement: a provider that ignores response_format returns
      // prose the report contract cannot accept.
      require_parameters: true,
    },
    // OpenRouter context compression may remove middle messages.
    plugins: [{ id: "context-compression", enabled: false }],
  });
}

/** Normalizes an OpenRouter provider name to the base slug accepted by `provider.ignore`. */
function providerSlug(value: string | null | undefined): string | null {
  const slug = (value ?? "").trim().split("/")[0]?.trim();
  return slug ? slug : null;
}

/**
 * OpenRouter adapter. Every call is a single non-streaming request: a review response is
 * structured JSON nobody watches arrive, so streaming only added SSE framing, partial-JSON and
 * UTF-8 boundary failure modes to a call that has no interactive consumer.
 *
 * Routing/privacy fields follow the official Chat Completions and provider-routing contracts:
 * https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion
 * https://openrouter.ai/docs/guides/routing/provider-selection
 */
export class OpenRouterProviderV1 implements ReviewProviderV1 {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #routing: OpenRouterProviderRoutingV2;
  readonly #pacer: ProviderCallPacerV1;
  readonly #ignoredProviders: readonly string[];

  constructor(
    apiKey: string,
    routingValue: unknown,
    fetchImplementation: typeof fetch = fetch,
    pacer: ProviderCallPacerV1 = sharedCallPacer,
    ignoredProviders: readonly string[] = [],
  ) {
    if (apiKey.trim().length === 0) {
      throw new ProviderCallError("INVALID_CONFIGURATION", "OpenRouter API key is required.");
    }
    this.#apiKey = apiKey;
    this.#routing = OpenRouterProviderRoutingV2Schema.parse(routingValue);
    this.#fetch = fetchImplementation;
    this.#pacer = pacer;
    this.#ignoredProviders = ignoredProviders;
  }

  auditRequest(request: ReviewProviderRequestV1) {
    const wireBody = openRouterWireBodyV5(request, this.#routing, this.#ignoredProviders);
    const credentialFreeWireRequest = JSON.stringify({
      url: OPENROUTER_CHAT_COMPLETIONS_URL,
      method: "POST",
      headers: OPENROUTER_PUBLIC_HEADERS_V1,
      body: wireBody,
    });
    return {
      providerPolicyVersion: OPENROUTER_PROVIDER_POLICY_VERSION_V5,
      preferredProviderEndpoints: this.#routing.order ? [...this.#routing.order] : null,
      excludedProviderEndpoints:
        this.#ignoredProviders.length > 0 ? [...this.#ignoredProviders] : null,
      wireBodyDigest: sha256Utf8(wireBody),
      wireBodyBytes: Buffer.byteLength(wireBody, "utf8"),
      credentialFreeWireRequestDigest: sha256Utf8(credentialFreeWireRequest),
    };
  }

  deferRequests(model: string, delayMs: number): void {
    this.#pacer.defer(model, delayMs);
  }

  /**
   * Excludes the endpoint that just failed and lets OpenRouter re-route. A pinned run has no
   * other endpoint to move to, so it drops the failed head of `order` instead.
   */
  forRetry(error: ProviderCallError, _request: ReviewProviderRequestV1): ReviewProviderV1 | null {
    const failed = providerSlug(
      error.responseMetadata?.provider ?? error.diagnostic?.providerName ?? null,
    );
    if (this.#routing.pinToOrder) {
      const remaining = (this.#routing.order ?? []).slice(1);
      if (remaining.length === 0) return null;
      return new OpenRouterProviderV1(
        this.#apiKey,
        { ...this.#routing, order: remaining },
        this.#fetch,
        this.#pacer,
        this.#ignoredProviders,
      );
    }
    if (!failed || this.#ignoredProviders.includes(failed)) {
      // Nothing new to exclude; OpenRouter still re-routes across the full eligible pool.
      return this;
    }
    return new OpenRouterProviderV1(this.#apiKey, this.#routing, this.#fetch, this.#pacer, [
      ...this.#ignoredProviders,
      failed,
    ]);
  }

  async complete(request: ReviewProviderRequestV1): Promise<ReviewProviderResponseV1> {
    const primaryModel = request.models[0];
    if (primaryModel === undefined) {
      throw new ProviderCallError(
        "INVALID_CONFIGURATION",
        "A review provider request must name at least one model.",
      );
    }
    await this.#pacer.wait(primaryModel);
    const wireBody = openRouterWireBodyV5(request, this.#routing, this.#ignoredProviders);
    let response: Response;
    let rawBody: string;
    // Body consumption stays inside the transport handler: fetch resolves on headers, so a
    // provider that stalls mid-body aborts here. That is the submitted-but-unknown case
    // TRANSPORT_UNCERTAIN exists for, and it must not be recorded as a definite failure.
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
      rawBody = await readBoundedResponseText(response, MAX_PROVIDER_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof ProviderCallError) {
        throw error;
      }
      throw new ProviderCallError(
        "TRANSPORT_UNCERTAIN",
        "OpenRouter transport failed after the request may have been submitted; it was not retried.",
        { cause: error },
      );
    }

    let body: unknown;
    try {
      body = parseStrictJsonV1(rawBody, {
        maxBytes: MAX_PROVIDER_RESPONSE_BYTES,
        source: "OpenRouter response envelope",
      });
    } catch (error) {
      if (!response.ok) {
        const diagnostic = providerErrorDiagnostic(
          {},
          { code: response.status },
          response,
          this.#apiKey,
        );
        throw new ProviderCallError(
          "PROVIDER_ERROR",
          `OpenRouter request failed (HTTP ${response.status}); response body failed strict JSON admission.`,
          {
            cause: error,
            diagnostic,
          },
        );
      }
      throw new ProviderCallError(
        "INVALID_RESPONSE",
        `OpenRouter response envelope failed strict JSON admission (HTTP ${response.status}).`,
        { cause: error },
      );
    }
    const responseBody = redactCredential(body, this.#apiKey);
    const metadata = responseMetadata(body, this.#apiKey);
    const rejectedResponse = {
      responseBody,
      ...(metadata === null ? {} : { responseMetadata: metadata }),
    };

    // OpenRouter can report generation errors inside an HTTP 200 response.
    // https://openrouter.ai/docs/api_reference/errors-and-debugging
    const providerError = providerErrorFromBody(body);
    if (providerError !== undefined) {
      const diagnostic = providerErrorDiagnostic(body, providerError, response, this.#apiKey);
      throw new ProviderCallError("PROVIDER_ERROR", providerErrorMessage(diagnostic), {
        diagnostic,
        ...rejectedResponse,
      });
    }
    if (!response.ok) {
      throw new ProviderCallError(
        "PROVIDER_ERROR",
        `OpenRouter request failed (HTTP ${response.status}).`,
        {
          ...rejectedResponse,
          diagnostic: providerErrorDiagnostic(
            body,
            { code: response.status },
            response,
            this.#apiKey,
          ),
        },
      );
    }

    const parsed = OpenRouterResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProviderCallError(
        "INVALID_RESPONSE",
        "OpenRouter response did not match the expected envelope.",
        rejectedResponse,
      );
    }
    const choice = parsed.data.choices[0];
    if (choice?.finish_reason !== "stop") {
      // An absent finish reason means the provider ended the generation without saying how, which
      // is a malfunction another endpoint may not repeat. An explicit reason such as "length" or
      // "content_filter" is a deterministic outcome of this request and would recur on retry.
      const malfunctioned = choice?.finish_reason === undefined || choice?.finish_reason === null;
      throw new ProviderCallError(
        "INVALID_RESPONSE",
        `OpenRouter response did not complete normally (finish reason: ${metadata?.finishReason ?? "missing"}).`,
        { ...rejectedResponse, ...(malfunctioned ? { retryable: true } : {}) },
      );
    }
    const content = choice.message.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new ProviderCallError(
        "INVALID_RESPONSE",
        "OpenRouter response did not contain usable completion content.",
        { ...rejectedResponse, retryable: true },
      );
    }
    const returnedModel = nullableString(parsed.data.model);
    if (returnedModel !== null && !request.models.includes(returnedModel)) {
      // Adapter-level guard on the wire response; the orchestrator repeats the rule for any
      // provider implementation. Distinct wording keeps a failure attributable to one layer.
      // A configured fallback model is a permitted answer; anything else is not.
      throw new ProviderCallError(
        "INVALID_RESPONSE",
        `OpenRouter returned a model outside the permitted set (${returnedModel}).`,
        rejectedResponse,
      );
    }

    let value: unknown;
    try {
      value = parseStrictJsonV1(content, {
        maxBytes: MAX_PROVIDER_RESPONSE_BYTES,
        source: "OpenRouter structured completion",
      });
    } catch (error) {
      throw new ProviderCallError(
        "INVALID_RESPONSE",
        "OpenRouter structured completion failed strict JSON admission.",
        { cause: error },
      );
    }

    // Error diagnostics are redacted field by field, but the success path hands its fields back
    // unredacted: rawContent feeds the next request in the conversation, and value becomes the
    // report. A response echoing the credential is discarded rather than partially sanitized,
    // which would present altered evidence as an unchanged response.
    const returnedStrings = [
      content,
      returnedModel,
      nullableString(parsed.data.id),
      nullableString(parsed.data.provider),
    ];
    if (
      decodedJsonReflectsCredential(value, this.#apiKey) ||
      returnedStrings.some((candidate) => candidate && reflectsCredential(candidate, this.#apiKey))
    ) {
      throw new ProviderCallError(
        "INVALID_RESPONSE",
        "OpenRouter returned completion content that reflected the API credential.",
      );
    }

    const usage = parsed.data.usage;
    return {
      value,
      rawContent: content,
      responseId: nullableString(parsed.data.id),
      model: returnedModel,
      provider: nullableString(parsed.data.provider),
      usage: normalizedUsage(usage),
      rawResponseBody: responseBody,
    };
  }
}
