#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type FinalReviewReportV1,
  type OpenRouterProviderRoutingV1,
  ReviewRequestV1Schema,
  ReviewRunConfigV2Schema,
} from "./contracts/index.js";
import { resumeFinalReviewV1, runTwoStageReviewV1 } from "./orchestrator/two-stage-review.js";
import { OpenRouterProviderV1, ProviderCallError } from "./provider/openrouter.js";
import type { ReviewProviderV1 } from "./provider/review-provider.js";
import { VERDICT_LABELS_V1 } from "./report/markdown.js";
import {
  captureGitSnapshotV1,
  isPathIgnoredV1,
  resolveRepositoryRootV1,
} from "./snapshot/git-capture.js";
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
  createProvider(apiKey: string, routing: OpenRouterProviderRoutingV1): ReviewProviderV1;
}

const processDependencies: CliDependenciesV1 = {
  readOpenRouterApiKey: () => process.env.OPENROUTER_API_KEY,
  createProvider: (apiKey, routing) => new OpenRouterProviderV1(apiKey, routing),
};

interface PreparedPacketV1 {
  packetPath: string;
  captured: Awaited<ReturnType<typeof captureGitSnapshotV1>>;
  repositoryRoot: string;
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
  const excludePatterns = options.get("--exclude");
  // Packet locations are resolved before capture so the packets themselves never become evidence:
  // a prior run's blobs, canonical inputs, and author packet would otherwise be captured as
  // untracked files and transmitted on the next review.
  const repositoryRoot = await resolveRepositoryRootV1(request.repository.path);
  const requestedOutput = options.get("--output");
  const defaultPacketRoot = join(repositoryRoot, ".review-runs");
  const packetRoot =
    typeof requestedOutput === "string" ? resolve(requestedOutput) : defaultPacketRoot;
  // Sibling packets from earlier runs live beside the requested one, so the containing directory
  // is excluded too, unless that would exclude the whole worktree.
  const packetParent = dirname(packetRoot);
  const packetSiblingRoot =
    packetParent === repositoryRoot || packetParent === dirname(packetParent) ? [] : [packetParent];
  const captured = await captureGitSnapshotV1(request, {
    ...(typeof base === "string" ? { base } : {}),
    excludedFileSystemPaths: [
      requestPath,
      ...(typeof configPath === "string" ? [resolve(configPath)] : []),
      defaultPacketRoot,
      packetRoot,
      ...packetSiblingRoot,
    ],
    ...(typeof excludePatterns === "string"
      ? { excludedPathPatterns: excludePatterns.split(",").filter((entry) => entry.length > 0) }
      : {}),
  });
  const packetPath =
    typeof requestedOutput === "string"
      ? packetRoot
      : join(defaultPacketRoot, captured.manifest.snapshotId);
  await writeSnapshotPacketV1(packetPath, captured, request);
  return { packetPath, captured, repositoryRoot };
}

/**
 * Resolves symlinks on the nearest existing ancestor of a path that may not exist yet, so a
 * not-yet-created packet directory compares correctly against a realpath-resolved worktree root.
 */
async function realpathNearestAncestor(path: string): Promise<string> {
  const trailing: string[] = [];
  let candidate = resolve(path);
  for (;;) {
    try {
      return join(await realpath(candidate), ...trailing.reverse());
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) {
        return resolve(path);
      }
      trailing.push(basename(candidate));
      candidate = parent;
    }
  }
}

/** Warns when packets are written into the reviewed worktree without being ignored by Git. */
async function warnUnignoredPacketLocation(
  repositoryRoot: string,
  packetPath: string,
  io: CliIoV1,
): Promise<void> {
  // Compare and query Git with symlinks resolved: on macOS a /tmp path and its /private/tmp
  // realpath would otherwise look like different repositories.
  const resolvedPacketPath = await realpathNearestAncestor(packetPath);
  const relativePath = relative(repositoryRoot, resolvedPacketPath);
  const insideWorktree =
    relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
  if (!insideWorktree || (await isPathIgnoredV1(repositoryRoot, resolvedPacketPath))) {
    return;
  }
  io.stderr(
    `Warning: ${packetPath} is inside the reviewed worktree and is not ignored by Git. Add it to .gitignore, or a later review will capture this packet as evidence.`,
  );
}

async function prepare(options: Map<string, string | true>, io: CliIoV1): Promise<void> {
  assertAllowedOptions(options, ["--request", "--base", "--output", "--exclude"]);
  const { captured, packetPath, repositoryRoot } = await preparePacket(options);
  await warnUnignoredPacketLocation(repositoryRoot, packetPath, io);
  io.stdout(`Prepared snapshot packet: ${packetPath}`);
  io.stdout(`Snapshot digest: ${captured.manifest.snapshotDigest.value}`);
  io.stdout(`Captured changes: ${captured.manifest.paths.length}`);
  io.stdout(`Visible exclusions: ${captured.manifest.exclusions.length}`);
}

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
  assertAllowedOptions(options, ["--request", "--config", "--base", "--output", "--exclude"]);
  const apiKey = dependencies.readOpenRouterApiKey();
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("OPENROUTER_API_KEY is required in the environment for a live review.");
  }
  const configPath = resolve(requiredOption(options, "--config"));
  const config = ReviewRunConfigV2Schema.parse(JSON.parse(await readFile(configPath, "utf8")));
  const provider = dependencies.createProvider(apiKey, config.providerRouting);
  const prepared = await preparePacket(options, config.configId);
  await warnUnignoredPacketLocation(prepared.repositoryRoot, prepared.packetPath, io);
  io.stdout(`Prepared snapshot packet: ${prepared.packetPath}`);
  const result = await runTwoStageReviewV1(prepared.packetPath, config, provider);
  io.stdout(`Verdict: ${VERDICT_LABELS_V1[result.report.verdict]}`);
  io.stdout(`Report: ${result.markdownPath}`);
  return reviewOutcomeExitCodeV1(result.report.verdict);
}

async function resumeFinal(
  options: Map<string, string | true>,
  io: CliIoV1,
  dependencies: CliDependenciesV1,
): Promise<number> {
  assertAllowedOptions(options, ["--packet", "--config"]);
  const apiKey = dependencies.readOpenRouterApiKey();
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("OPENROUTER_API_KEY is required in the environment for a live review.");
  }
  const configPath = resolve(requiredOption(options, "--config"));
  const config = ReviewRunConfigV2Schema.parse(JSON.parse(await readFile(configPath, "utf8")));
  const provider = dependencies.createProvider(apiKey, config.providerRouting);
  const result = await resumeFinalReviewV1(
    resolve(requiredOption(options, "--packet")),
    config,
    provider,
  );
  io.stdout(`Verdict: ${VERDICT_LABELS_V1[result.report.verdict]}`);
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
    if (command === "resume-final") {
      return await resumeFinal(options, io, dependencies);
    }
    throw new Error("Usage: independent-reviewer <prepare|inspect|review|resume-final> [options]");
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
