#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type FinalReviewReportV1,
  ReviewRequestV1Schema,
  ReviewRunConfigV1Schema,
} from "./contracts/index.js";
import { runTwoStageReviewV1 } from "./orchestrator/two-stage-review.js";
import { OpenRouterProviderV1, ProviderCallError } from "./provider/openrouter.js";
import type { ReviewProviderV1 } from "./provider/review-provider.js";
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

export interface CliDependenciesV1 {
  readOpenRouterApiKey(): string | undefined;
  createProvider(apiKey: string): ReviewProviderV1;
}

const processDependencies: CliDependenciesV1 = {
  readOpenRouterApiKey: () => process.env.OPENROUTER_API_KEY,
  createProvider: (apiKey) => new OpenRouterProviderV1(apiKey),
};

interface PreparedPacketV1 {
  packetPath: string;
  captured: Awaited<ReturnType<typeof captureGitSnapshotV1>>;
}

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

async function preparePacket(
  options: Map<string, string | true>,
  expectedConfigId?: string,
): Promise<PreparedPacketV1> {
  const requestPath = resolve(requiredOption(options, "--request"));
  const request = ReviewRequestV1Schema.parse(JSON.parse(await readFile(requestPath, "utf8")));
  if (expectedConfigId && request.reviewConfigRef !== expectedConfigId) {
    throw new Error(
      `Review request config reference ${request.reviewConfigRef} does not match ${expectedConfigId}.`,
    );
  }
  const base = options.get("--base");
  const configPath = options.get("--config");
  const captured = await captureGitSnapshotV1(request, {
    ...(typeof base === "string" ? { base } : {}),
    excludedFileSystemPaths: [
      requestPath,
      ...(typeof configPath === "string" ? [resolve(configPath)] : []),
    ],
  });
  const requestedOutput = options.get("--output");
  const packetPath =
    typeof requestedOutput === "string"
      ? resolve(requestedOutput)
      : resolve(".review-runs", captured.manifest.snapshotId);
  await writeSnapshotPacketV1(packetPath, captured, request);
  return { packetPath, captured };
}

async function prepare(options: Map<string, string | true>, io: CliIoV1): Promise<void> {
  assertAllowedOptions(options, ["--request", "--base", "--output"]);
  const { captured, packetPath } = await preparePacket(options);
  io.stdout(`Prepared snapshot packet: ${packetPath}`);
  io.stdout(`Snapshot digest: ${captured.manifest.snapshotDigest.value}`);
  io.stdout(`Captured changes: ${captured.manifest.paths.length}`);
  io.stdout(`Visible exclusions: ${captured.manifest.exclusions.length}`);
}

const verdictLabels: Record<FinalReviewReportV1["verdict"], string> = {
  READY: "Ready",
  READY_WITH_FOLLOW_UPS: "Ready with non-blocking follow-ups",
  NOT_READY: "Not ready",
  UNABLE_TO_VERIFY: "Unable to verify",
};

export function reviewOutcomeExitCodeV1(verdict: FinalReviewReportV1["verdict"]): number {
  if (verdict === "NOT_READY") {
    return 2;
  }
  if (verdict === "UNABLE_TO_VERIFY") {
    return 3;
  }
  return 0;
}

async function review(
  options: Map<string, string | true>,
  io: CliIoV1,
  dependencies: CliDependenciesV1,
): Promise<number> {
  assertAllowedOptions(options, ["--request", "--config", "--base", "--output"]);
  const apiKey = dependencies.readOpenRouterApiKey();
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("OPENROUTER_API_KEY is required in the environment for a live review.");
  }
  const configPath = resolve(requiredOption(options, "--config"));
  const config = ReviewRunConfigV1Schema.parse(JSON.parse(await readFile(configPath, "utf8")));
  const provider = dependencies.createProvider(apiKey);
  const prepared = await preparePacket(options, config.configId);
  io.stdout(`Prepared snapshot packet: ${prepared.packetPath}`);
  const result = await runTwoStageReviewV1(prepared.packetPath, config, provider);
  io.stdout(`Verdict: ${verdictLabels[result.report.verdict]}`);
  io.stdout(`Report: ${result.markdownPath}`);
  return reviewOutcomeExitCodeV1(result.report.verdict);
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

export async function runCliV1(
  args: string[],
  io: CliIoV1 = processIo,
  dependencies: CliDependenciesV1 = processDependencies,
): Promise<number> {
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
    if (command === "review") {
      return await review(options, io, dependencies);
    }
    throw new Error("Usage: independent-reviewer <prepare|inspect|review> [options]");
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "Unknown command failure");
    if (error instanceof ProviderCallError && error.code === "TRANSPORT_UNCERTAIN") {
      return 4;
    }
    return 1;
  }
}

const executablePath = process.argv[1];
if (executablePath && import.meta.url === pathToFileURL(resolve(executablePath)).href) {
  process.exitCode = await runCliV1(process.argv.slice(2));
}
