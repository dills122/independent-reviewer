import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  appendRunRecordEventV2,
  readRunRecordEventsV2,
} from "../../src/orchestrator/run-record-v2.js";

const at = "2026-09-22T12:00:00.000Z";
const limits = { maxTotalBytes: 10000, maxLineBytes: 2000 };
const event = { schemaVersion: 2, at, type: "RUN_COMPLETED", terminalState: "READY" };

test("V2 writer durably syncs a validated envelope before resolving", async () => {
  const calls: string[] = [];
  let contents = "";
  await appendRunRecordEventV2(
    "run-record.jsonl",
    { type: "RUN_COMPLETED", terminalState: "READY" },
    {
      now: () => new Date(at),
      openFile: async () => {
        calls.push("open");
        return {
          appendFile: async (value: string) => {
            calls.push("append");
            contents = value;
          },
          sync: async () => {
            calls.push("sync");
          },
          close: async () => {
            calls.push("close");
          },
        };
      },
    },
  );
  assert.deepEqual(calls, ["open", "append", "sync", "close"]);
  assert.deepEqual(JSON.parse(contents), event);
  assert.ok(contents.endsWith("\n"));
});

test("V2 writer rejects invalid payload before opening the ledger", async () => {
  let opened = false;
  await assert.rejects(
    appendRunRecordEventV2(
      "run-record.jsonl",
      { type: "FINAL_CANDIDATE_PERSISTED" } as unknown as Parameters<
        typeof appendRunRecordEventV2
      >[1],
      {
        openFile: async () => {
          opened = true;
          throw new Error("Must not open");
        },
      },
    ),
  );
  assert.equal(opened, false);
});

test("V2 writer exposes sync failure and closes the file", async () => {
  let closed = false;
  await assert.rejects(
    appendRunRecordEventV2(
      "run-record.jsonl",
      { type: "RUN_COMPLETED", terminalState: "READY" },
      {
        openFile: async () => ({
          appendFile: async () => {},
          sync: async () => {
            throw new Error("sync failed");
          },
          close: async () => {
            closed = true;
          },
        }),
      },
    ),
    /sync failed/,
  );
  assert.equal(closed, true);
});

test("V2 reader reports complete bytes and recoverable torn tail without modifying ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "run-record-v2-tail-"));
  const path = join(directory, "run-record.jsonl");
  try {
    await appendRunRecordEventV2(
      path,
      { type: "RUN_COMPLETED", terminalState: "READY" },
      { now: () => new Date(at) },
    );
    const complete = await readFile(path, "utf8");
    const tail = '{"schemaVersion":2,"type":';
    await writeFile(path, complete + tail);
    const result = await readRunRecordEventsV2(path, limits);
    assert.deepEqual(result.events, [event]);
    assert.equal(result.completeBytes, Buffer.byteLength(complete));
    assert.equal(result.tailBytes, Buffer.byteLength(tail));
    assert.equal(await readFile(path, "utf8"), complete + tail);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("V2 reader refuses V1 ledgers and mixed generations in either order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "run-record-v2-generation-"));
  const path = join(directory, "run-record.jsonl");
  try {
    const v1 = JSON.stringify({ ...event, schemaVersion: 1 });
    const v2 = JSON.stringify(event);
    for (const lines of [[v1], [v1, v2], [v2, v1]]) {
      await writeFile(path, `${lines.join("\n")}\n`);
      await assert.rejects(readRunRecordEventsV2(path, limits));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("V2 reader rejects malformed completed records and enforces byte budgets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "run-record-v2-limits-"));
  const path = join(directory, "run-record.jsonl");
  try {
    for (const content of [
      '{"broken":\n',
      `${JSON.stringify({ ...event, secret: "Unexpected field" })}\n`,
    ]) {
      await writeFile(path, content);
      await assert.rejects(readRunRecordEventsV2(path, limits));
    }
    await writeFile(path, `${JSON.stringify(event)}\n`);
    await assert.rejects(readRunRecordEventsV2(path, { ...limits, maxTotalBytes: 10 }));
    await assert.rejects(readRunRecordEventsV2(path, { ...limits, maxLineBytes: 10 }));
    const result = await readRunRecordEventsV2(path, limits);
    assert.deepEqual(result.events, [event]);
    assert.equal(result.tailBytes, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
