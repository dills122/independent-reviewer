import { createParser, type ParseError } from "eventsource-parser";

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BUFFER_CHARACTERS = 1024 * 1024;

export type OpenRouterSseDecodeErrorCodeV1 =
  | "EVENT_TOO_LARGE"
  | "INVALID_CONFIGURATION"
  | "INVALID_EVENT_JSON"
  | "INVALID_SSE"
  | "INVALID_UTF8"
  | "RESPONSE_TOO_LARGE"
  | "TRUNCATED_STREAM";

export class OpenRouterSseDecodeErrorV1 extends Error {
  readonly code: OpenRouterSseDecodeErrorCodeV1;

  constructor(code: OpenRouterSseDecodeErrorCodeV1, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenRouterSseDecodeErrorV1";
    this.code = code;
  }
}

export type OpenRouterSseDecodedEventV1 =
  | { kind: "CHUNK"; rawData: string; value: unknown }
  | { kind: "DONE" };

export interface OpenRouterSseDecoderOptionsV1 {
  /** Total raw response-byte cap, independent from parser buffering. */
  maxResponseBytes?: number;
  /** Cap for a partial SSE line plus one not-yet-dispatched event. */
  maxEventBufferCharacters?: number;
  /** Receives exact response bytes before UTF-8 or SSE decoding. */
  onRawChunk?: (chunk: Uint8Array) => void | Promise<void>;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new OpenRouterSseDecodeErrorV1(
      "INVALID_CONFIGURATION",
      `${name} must be a positive safe integer.`,
    );
  }
  return resolved;
}

function parserError(error: ParseError): OpenRouterSseDecodeErrorV1 {
  return error.type === "max-buffer-size-exceeded"
    ? new OpenRouterSseDecodeErrorV1(
        "EVENT_TOO_LARGE",
        "OpenRouter SSE event exceeded the configured parser buffer.",
        { cause: error },
      )
    : new OpenRouterSseDecodeErrorV1("INVALID_SSE", "OpenRouter returned malformed SSE.", {
        cause: error,
      });
}

/**
 * Decodes one OpenRouter Chat Completions SSE body without owning HTTP, retries, or validation.
 * Breaking iteration cancels the source stream. A complete stream must contain `[DONE]`.
 */
export async function* decodeOpenRouterSseV1(
  body: ReadableStream<Uint8Array>,
  options: OpenRouterSseDecoderOptionsV1 = {},
): AsyncGenerator<OpenRouterSseDecodedEventV1> {
  const maxResponseBytes = positiveInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
  );
  const maxEventBufferCharacters = positiveInteger(
    options.maxEventBufferCharacters,
    DEFAULT_MAX_EVENT_BUFFER_CHARACTERS,
    "maxEventBufferCharacters",
  );
  const pending: OpenRouterSseDecodedEventV1[] = [];
  let parseFailure: OpenRouterSseDecodeErrorV1 | undefined;
  let completed = false;
  const parser = createParser({
    maxBufferSize: maxEventBufferCharacters,
    onError(error) {
      parseFailure ??= parserError(error);
    },
    onEvent(event) {
      if (completed) {
        parseFailure ??= new OpenRouterSseDecodeErrorV1(
          "INVALID_SSE",
          "OpenRouter SSE contained data after the [DONE] event.",
        );
        return;
      }
      if (event.data === "[DONE]") {
        completed = true;
        pending.push({ kind: "DONE" });
        return;
      }
      try {
        pending.push({ kind: "CHUNK", rawData: event.data, value: JSON.parse(event.data) });
      } catch (error) {
        parseFailure ??= new OpenRouterSseDecodeErrorV1(
          "INVALID_EVENT_JSON",
          "OpenRouter SSE data was not valid JSON.",
          { cause: error },
        );
      }
    },
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reader = body.getReader();
  let responseBytes = 0;

  const feed = (text: string): void => {
    if (text.length > 0) parser.feed(text);
    if (parseFailure) throw parseFailure;
  };

  try {
    while (!completed) {
      const next = await reader.read();
      if (next.done) break;
      responseBytes += next.value.byteLength;
      if (responseBytes > maxResponseBytes) {
        throw new OpenRouterSseDecodeErrorV1(
          "RESPONSE_TOO_LARGE",
          "OpenRouter SSE response exceeded the configured byte cap.",
        );
      }
      await options.onRawChunk?.(next.value.slice());
      try {
        feed(decoder.decode(next.value, { stream: true }));
      } catch (error) {
        if (error instanceof OpenRouterSseDecodeErrorV1) throw error;
        throw new OpenRouterSseDecodeErrorV1(
          "INVALID_UTF8",
          "OpenRouter SSE response was not valid UTF-8.",
          { cause: error },
        );
      }
      while (pending.length > 0) yield pending.shift() as OpenRouterSseDecodedEventV1;
    }
    try {
      feed(decoder.decode());
      parser.reset({ consume: true });
      if (parseFailure) throw parseFailure;
    } catch (error) {
      if (error instanceof OpenRouterSseDecodeErrorV1) throw error;
      throw new OpenRouterSseDecodeErrorV1(
        "INVALID_UTF8",
        "OpenRouter SSE response ended with invalid UTF-8.",
        { cause: error },
      );
    }
    while (pending.length > 0) yield pending.shift() as OpenRouterSseDecodedEventV1;
    if (!completed) {
      throw new OpenRouterSseDecodeErrorV1(
        "TRUNCATED_STREAM",
        "OpenRouter SSE response ended before the [DONE] event.",
      );
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
