import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decodeOpenRouterSseV1,
  OpenRouterSseDecodeErrorV1,
} from "../../src/provider/openrouter-sse-decoder.js";

function byteStream(parts: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>) {
  const events = [];
  for await (const event of decodeOpenRouterSseV1(body)) events.push(event);
  return events;
}

describe("decodeOpenRouterSseV1", () => {
  it("handles split UTF-8, CRLF framing, comments, multiline data, and DONE", async () => {
    const wire =
      ": keepalive\r\n" +
      'data: {"choices":[{"delta":\r\n' +
      'data: {"content":"café"}}]}\r\n\r\n' +
      "data: [DONE]\r\n\r\n";
    const bytes = new TextEncoder().encode(wire);
    const split = bytes.indexOf(0xc3) + 1;

    assert.deepEqual(await collect(byteStream([bytes.slice(0, split), bytes.slice(split)])), [
      {
        kind: "CHUNK",
        rawData: '{"choices":[{"delta":\n{"content":"café"}}]}',
        value: { choices: [{ delta: { content: "café" } }] },
      },
      { kind: "DONE" },
    ]);
  });

  it("rejects malformed SSE and malformed event JSON with stable codes", async () => {
    const cases = [
      ["unknown: field\n\n", "INVALID_SSE"],
      ["data: {broken}\n\n", "INVALID_EVENT_JSON"],
    ] as const;
    for (const [wire, code] of cases) {
      await assert.rejects(
        () => collect(byteStream([new TextEncoder().encode(wire)])),
        (error: unknown) => error instanceof OpenRouterSseDecodeErrorV1 && error.code === code,
      );
    }
  });

  it("bounds both incomplete event buffering and total raw response bytes", async () => {
    await assert.rejects(
      async () => {
        for await (const _event of decodeOpenRouterSseV1(
          byteStream([new TextEncoder().encode(`data: ${"x".repeat(20)}`)]),
          { maxEventBufferCharacters: 8 },
        )) {
          // no-op
        }
      },
      (error: unknown) =>
        error instanceof OpenRouterSseDecodeErrorV1 && error.code === "EVENT_TOO_LARGE",
    );
    await assert.rejects(
      async () => {
        for await (const _event of decodeOpenRouterSseV1(
          byteStream([new TextEncoder().encode("data: {}\n\ndata: [DONE]\n\n")]),
          { maxResponseBytes: 8 },
        )) {
          // no-op
        }
      },
      (error: unknown) =>
        error instanceof OpenRouterSseDecodeErrorV1 && error.code === "RESPONSE_TOO_LARGE",
    );
  });

  it("rejects streams without DONE and invalid UTF-8", async () => {
    await assert.rejects(
      () => collect(byteStream([new TextEncoder().encode("data: {}\n\n")])),
      (error: unknown) =>
        error instanceof OpenRouterSseDecodeErrorV1 && error.code === "TRUNCATED_STREAM",
    );
    await assert.rejects(
      () => collect(byteStream([Uint8Array.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff])])),
      (error: unknown) =>
        error instanceof OpenRouterSseDecodeErrorV1 && error.code === "INVALID_UTF8",
    );
  });

  it("captures exact raw chunks and cancels upstream when consumer stops", async () => {
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"   "}}]}\n\ndata: [DONE]\n\n',
    );
    const captured: Uint8Array[] = [];
    let cancelled = false;
    const cancellable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel() {
        cancelled = true;
      },
    });
    const decoder = decodeOpenRouterSseV1(cancellable, {
      onRawChunk: (chunk) => {
        captured.push(chunk.slice());
      },
    });

    const first = await decoder.next();
    assert.equal(first.value?.kind, "CHUNK");
    await decoder.return(undefined);

    assert.deepEqual(captured, [bytes]);
    assert.equal(cancelled, true);
  });

  it("drains many events from one input chunk without shifting the queue", async () => {
    const count = 10_000;
    const wire = `${'data: {"ok":true}\n\n'.repeat(count)}data: [DONE]\n\n`;
    const events = await collect(byteStream([new TextEncoder().encode(wire)]));

    assert.equal(events.length, count + 1);
    assert.deepEqual(events.at(-1), { kind: "DONE" });
  });
});
