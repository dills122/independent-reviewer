import { open } from "node:fs/promises";
import * as z from "zod";
import {
  type RunRecordEventPayloadV1,
  type RunRecordEventV1,
  RunRecordEventV1Schema,
} from "../contracts/run-record.js";
import { RunRecordEventV2Schema } from "../contracts/run-record-v2.js";
import { readRecoverableStrictJsonLinesFileV1 } from "../contracts/strict-json.js";

interface AppendFileHandleV1 {
  appendFile(contents: string): Promise<unknown>;
  sync(): Promise<unknown>;
  close(): Promise<unknown>;
}

export interface AppendRunRecordOptionsV1 {
  readonly now?: () => Date;
  readonly openFile?: (path: string, flags: "a", mode: number) => Promise<AppendFileHandleV1>;
}

export async function appendRunRecordEventV1(
  path: string,
  payload: RunRecordEventPayloadV1,
  options: AppendRunRecordOptionsV1 = {},
): Promise<RunRecordEventV1> {
  return appendRunRecordEvent(path, payload, RunRecordEventV1Schema, 1, options);
}

export async function appendRunRecordEvent<T>(
  path: string,
  payload: unknown,
  schema: z.ZodType<T>,
  schemaVersion: 1 | 2,
  options: AppendRunRecordOptionsV1 = {},
): Promise<T> {
  const event = schema.parse({
    ...(payload as Record<string, unknown>),
    schemaVersion,
    at: (options.now?.() ?? new Date()).toISOString(),
  });
  const handle = await (options.openFile ?? open)(path, "a", 0o600);
  try {
    await handle.appendFile(`${JSON.stringify(event)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return event;
}

export interface ReadRunRecordResultV1 {
  readonly events: readonly RunRecordEventV1[];
  readonly completeBytes: number;
  readonly tailBytes: number;
}

export async function recoverRunRecordTailV1(
  path: string,
  observation: { readonly completeBytes: number; readonly tailBytes: number },
): Promise<void> {
  if (
    !Number.isSafeInteger(observation.completeBytes) ||
    observation.completeBytes < 0 ||
    !Number.isSafeInteger(observation.tailBytes) ||
    observation.tailBytes < 1
  ) {
    throw new TypeError("Run-record recovery requires valid observed byte counts.");
  }
  const handle = await open(path, "r+");
  try {
    const current = await handle.stat();
    if (current.size !== observation.completeBytes + observation.tailBytes) {
      throw new Error("The review run record changed after it was inspected; refusing recovery.");
    }
    await handle.truncate(observation.completeBytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readRunRecordEventsV1(
  path: string,
  options: { readonly maxTotalBytes: number; readonly maxLineBytes: number },
): Promise<ReadRunRecordResultV1> {
  return readRunRecordEvents(path, options, RunRecordEventV1Schema);
}

export async function readRunRecordEvents<T>(
  path: string,
  options: { readonly maxTotalBytes: number; readonly maxLineBytes: number },
  schema: z.ZodType<T>,
): Promise<{ events: T[]; completeBytes: number; tailBytes: number }> {
  const result = await readRecoverableStrictJsonLinesFileV1(path, {
    ...options,
    source: "review run record",
  });
  return {
    events: result.values.map((value, index) => {
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        throw new Error(`Run event ${index + 1} does not match the run-record contract.`);
      }
      return parsed.data;
    }),
    completeBytes: result.completeBytes,
    tailBytes: result.tailBytes,
  };
}

/** Diagnostic readers accept either generation, never a mixture within one run. */
export async function readRunRecordEventsAny(
  path: string,
  options: { readonly maxTotalBytes: number; readonly maxLineBytes: number },
) {
  const result = await readRunRecordEvents(
    path,
    options,
    z.union([RunRecordEventV1Schema, RunRecordEventV2Schema]),
  );
  if (new Set(result.events.map((event) => event.schemaVersion)).size > 1)
    throw new Error("Run record mixes incompatible protocol generations");
  return result;
}
