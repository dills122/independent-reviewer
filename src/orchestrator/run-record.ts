import { open } from "node:fs/promises";

import {
  type RunRecordEventPayloadV1,
  type RunRecordEventV1,
  RunRecordEventV1Schema,
} from "../contracts/run-record.js";
import { readRecoverableStrictJsonLinesFileV1 } from "../contracts/strict-json.js";

interface AppendFileHandleV1 {
  appendFile(contents: string): Promise<unknown>;
  sync(): Promise<unknown>;
  close(): Promise<unknown>;
}

interface AppendRunRecordOptionsV1 {
  readonly now?: () => Date;
  readonly openFile?: (path: string, flags: "a", mode: number) => Promise<AppendFileHandleV1>;
}

export async function appendRunRecordEventV1(
  path: string,
  payload: RunRecordEventPayloadV1,
  options: AppendRunRecordOptionsV1 = {},
): Promise<RunRecordEventV1> {
  const event = RunRecordEventV1Schema.parse({
    ...payload,
    schemaVersion: 1,
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
  const result = await readRecoverableStrictJsonLinesFileV1(path, {
    ...options,
    source: "review run record",
  });
  return {
    events: result.values.map((value, index) => {
      const parsed = RunRecordEventV1Schema.safeParse(value);
      if (!parsed.success) {
        throw new Error(`Run event ${index + 1} does not match the run-record contract.`);
      }
      return parsed.data;
    }),
    completeBytes: result.completeBytes,
    tailBytes: result.tailBytes,
  };
}
