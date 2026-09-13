import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { RunRecordEventPayloadV1 } from "../../src/contracts/run-record.js";
import {
  appendRunRecordEventV1,
  recoverRunRecordTailV1,
} from "../../src/orchestrator/run-record.js";

test("run-record append validates then durably syncs before resolving", async () => {
  const calls: string[] = [];
  let contents = "";
  const openFile = async () => {
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
  };

  await appendRunRecordEventV1(
    "run-record.jsonl",
    {
      type: "RUN_FAILED",
      terminalState: "FAILED",
      error: { name: "Error", code: null, message: "failed" },
    },
    { now: () => new Date("2026-09-12T12:00:00.000Z"), openFile },
  );

  assert.deepEqual(calls, ["open", "append", "sync", "close"]);
  assert.deepEqual(JSON.parse(contents), {
    schemaVersion: 1,
    at: "2026-09-12T12:00:00.000Z",
    type: "RUN_FAILED",
    terminalState: "FAILED",
    error: { name: "Error", code: null, message: "failed" },
  });
});

test("run-record append rejects invalid payloads before opening the ledger", async () => {
  let opened = false;
  const invalid = { type: "RUN_FAILED" } as unknown as RunRecordEventPayloadV1;

  await assert.rejects(
    appendRunRecordEventV1("run-record.jsonl", invalid, {
      openFile: async () => {
        opened = true;
        throw new Error("must not open");
      },
    }),
  );
  assert.equal(opened, false);
});

test("run-record recovery truncates only the previously observed incomplete tail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "run-record-tail-"));
  const path = join(directory, "run-record.jsonl");
  const complete = '{"complete":true}\n';
  try {
    await writeFile(path, `${complete}{"torn":`, "utf8");
    await recoverRunRecordTailV1(path, {
      completeBytes: Buffer.byteLength(complete),
      tailBytes: Buffer.byteLength('{"torn":'),
    });
    assert.equal(await readFile(path, "utf8"), complete);

    await writeFile(path, `${complete}{"changed":true}\n`, "utf8");
    await assert.rejects(
      recoverRunRecordTailV1(path, {
        completeBytes: Buffer.byteLength(complete),
        tailBytes: Buffer.byteLength('{"torn":'),
      }),
      /changed after it was inspected/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
