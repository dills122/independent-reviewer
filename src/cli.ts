#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { captureGitSnapshotV1 } from "./snapshot/git-capture.js";
import { inspectSnapshotPacketV1, writeSnapshotPacketV1 } from "./snapshot/snapshot-packet.js";

export interface CliIoV1 {
  stdout(message: string): void;
  stderr(message: string): void;
}

const processIo: CliIoV1 = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
};

function parseOptions(args: string[]): Map<string, string | true> {
  const options = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!option?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${option ?? ""}`);
    }
    if (option === "--json") {
      options.set(option, true);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${option}`);
    }
    options.set(option, value);
    index += 1;
  }
  return options;
}

function requiredOption(options: Map<string, string | true>, name: string): string {
  const value = options.get(name);
  if (typeof value !== "string") {
    throw new Error(`Missing required option ${name}`);
  }
  return value;
}

function assertAllowedOptions(options: Map<string, string | true>, allowed: string[]): void {
  for (const option of options.keys()) {
    if (!allowed.includes(option)) {
      throw new Error(`Unknown option ${option}`);
    }
  }
}

function formatInspection(inspected: Awaited<ReturnType<typeof inspectSnapshotPacketV1>>): string {
  const lines = [
    `Snapshot: ${inspected.manifest.snapshotDigest.value}`,
    `Base: ${inspected.manifest.source.baseCommit}`,
    `Head: ${inspected.manifest.source.headCommit}`,
    `Changes: ${inspected.manifest.paths.length}`,
  ];
  for (const entry of inspected.manifest.paths) {
    lines.push(`${entry.changeType} ${entry.path}`);
  }
  lines.push(`Exclusions: ${inspected.manifest.exclusions.length}`);
  for (const exclusion of inspected.manifest.exclusions) {
    lines.push(`${exclusion.reason} ${exclusion.path}`);
  }
  lines.push(`Omissions: ${inspected.manifest.omissions.length}`);
  lines.push(`Captured blobs: ${inspected.blobCount}`);
  lines.push(`Author packet: ${inspected.authorPacket ? "stored separately" : "not provided"}`);
  return lines.join("\n");
}

async function prepare(options: Map<string, string | true>, io: CliIoV1): Promise<void> {
  assertAllowedOptions(options, ["--request", "--base", "--output"]);
  const requestPath = resolve(requiredOption(options, "--request"));
  const request = JSON.parse(await readFile(requestPath, "utf8")) as unknown;
  const base = options.get("--base");
  const captured = await captureGitSnapshotV1(request, {
    ...(typeof base === "string" ? { base } : {}),
  });
  const requestedOutput = options.get("--output");
  const packetPath =
    typeof requestedOutput === "string"
      ? resolve(requestedOutput)
      : resolve(".review-runs", captured.manifest.snapshotId);
  await writeSnapshotPacketV1(packetPath, captured, request);
  io.stdout(`Prepared snapshot packet: ${packetPath}`);
  io.stdout(`Snapshot digest: ${captured.manifest.snapshotDigest.value}`);
  io.stdout(`Captured changes: ${captured.manifest.paths.length}`);
  io.stdout(`Visible exclusions: ${captured.manifest.exclusions.length}`);
}

async function inspect(options: Map<string, string | true>, io: CliIoV1): Promise<void> {
  assertAllowedOptions(options, ["--packet", "--json"]);
  const inspected = await inspectSnapshotPacketV1(resolve(requiredOption(options, "--packet")));
  if (options.get("--json") === true) {
    io.stdout(
      JSON.stringify(
        {
          snapshotManifest: inspected.manifest,
          canonicalInputs: inspected.canonicalInputs,
          authorPacketPresent: inspected.authorPacket !== undefined,
        },
        null,
        2,
      ),
    );
    return;
  }
  io.stdout(formatInspection(inspected));
}

export async function runCliV1(args: string[], io: CliIoV1 = processIo): Promise<number> {
  const [command, ...optionArgs] = args;
  try {
    const options = parseOptions(optionArgs);
    if (command === "prepare") {
      await prepare(options, io);
      return 0;
    }
    if (command === "inspect") {
      await inspect(options, io);
      return 0;
    }
    throw new Error("Usage: independent-reviewer <prepare|inspect> [options]");
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "Unknown command failure");
    return 1;
  }
}

const executablePath = process.argv[1];
if (executablePath && import.meta.url === pathToFileURL(resolve(executablePath)).href) {
  process.exitCode = await runCliV1(process.argv.slice(2));
}
