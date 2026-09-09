#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import * as z from "zod";

import {
  buildInspectionReportV1,
  type FinalReviewReportV1,
  type InspectionReportV1,
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

/** Kept in step with package.json by the version test. */
const CLI_VERSION_V1 = "0.0.0";

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

interface CommandOptionSpecV1 {
  type: "string" | "boolean";
  description: string;
  required?: boolean;
}

interface CommandSpecV1 {
  summary: string;
  options: Record<string, CommandOptionSpecV1>;
}

const COMMAND_SPECS_V1: Record<string, CommandSpecV1> = {
  prepare: {
    summary: "Capture a frozen snapshot packet without contacting a provider.",
    options: {
      request: { type: "string", description: "Path to the review request JSON.", required: true },
      base: { type: "string", description: "Override base ref resolution." },
      output: { type: "string", description: "Packet directory (default <repo>/.review-runs)." },
      exclude: { type: "string", description: "Comma-separated glob patterns to exclude." },
    },
  },
  inspect: {
    summary: "Validate a packet and report what it contains.",
    options: {
      packet: { type: "string", description: "Path to the snapshot packet.", required: true },
      json: { type: "boolean", description: "Emit the versioned inspection report as JSON." },
    },
  },
  review: {
    summary: "Prepare a packet and run the complete two-stage review.",
    options: {
      request: { type: "string", description: "Path to the review request JSON.", required: true },
      config: { type: "string", description: "Path to the review run config.", required: true },
      base: { type: "string", description: "Override base ref resolution." },
      output: { type: "string", description: "Packet directory (default <repo>/.review-runs)." },
      exclude: { type: "string", description: "Comma-separated glob patterns to exclude." },
    },
  },
  "resume-final": {
    summary: "Retry only a final stage that failed with a definite provider error.",
    options: {
      packet: { type: "string", description: "Path to the snapshot packet.", required: true },
      config: { type: "string", description: "Path to the review run config.", required: true },
    },
  },
};

function usageText(command?: string): string {
  const commands = Object.keys(COMMAND_SPECS_V1);
  if (!command || !COMMAND_SPECS_V1[command]) {
    const lines = [
      `Usage: independent-reviewer <${commands.join("|")}> [options]`,
      "",
      "Commands:",
      ...commands.map((name) => `  ${name.padEnd(14)}${COMMAND_SPECS_V1[name]?.summary ?? ""}`),
      "",
      "Run 'independent-reviewer <command> --help' for command options.",
      "Set OPENROUTER_API_KEY in the environment for 'review' and 'resume-final'.",
    ];
    return lines.join("\n");
  }
  const spec = COMMAND_SPECS_V1[command];
  const lines = [
    `Usage: independent-reviewer ${command} [options]`,
    "",
    spec.summary,
    "",
    "Options:",
  ];
  for (const [name, option] of Object.entries(spec.options)) {
    const valueHint = option.type === "string" ? " <value>" : "";
    const requirement = option.required ? " (required)" : "";
    lines.push(`  --${name}${valueHint}`.padEnd(24) + `${option.description}${requirement}`);
  }
  lines.push("  --help".padEnd(24) + "Print this message.");
  return lines.join("\n");
}

/**
 * Parses one command's arguments with `node:util`, which supports `--flag=value` and `--`, and
 * reports a dash-leading value precisely instead of claiming the value is missing.
 *
 * Every option is collected as a list so a repeated flag is rejected rather than silently taking
 * the last one: the configuration this tool runs on is digest-bound, and quietly preferring the
 * second `--config` is the wrong default.
 */
function parseCommandOptions(command: string, args: string[]): Map<string, string | true> {
  const spec = COMMAND_SPECS_V1[command];
  if (!spec) {
    throw new Error(usageText());
  }
  const parseOptionsConfig = Object.fromEntries(
    Object.entries(spec.options).map(([name, option]) => [
      name,
      { type: option.type, multiple: true } as const,
    ]),
  );
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      options: { ...parseOptionsConfig, help: { type: "boolean" } },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : "Invalid arguments"}\n\n${usageText(command)}`,
    );
  }

  const options = new Map<string, string | true>();
  for (const [name, values] of Object.entries(parsed.values)) {
    if (!Array.isArray(values)) {
      if (values === true) {
        options.set(`--${name}`, true);
      }
      continue;
    }
    if (values.length > 1) {
      throw new Error(`Option --${name} was given ${values.length} times; give it once.`);
    }
    const value = values[0];
    if (typeof value === "string") {
      options.set(`--${name}`, value);
    } else if (value === true) {
      options.set(`--${name}`, true);
    }
  }
  for (const [name, option] of Object.entries(spec.options)) {
    if (option.required && !options.has(`--${name}`)) {
      throw new Error(`Missing required option --${name}\n\n${usageText(command)}`);
    }
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

/** The human-readable view of the same validated report the JSON view emits. */
function formatInspection(report: InspectionReportV1): string {
  const lines = [
    `Snapshot: ${report.snapshotManifest.snapshotDigest.value}`,
    `Base: ${report.snapshotManifest.source.baseCommit}`,
    `Head: ${report.snapshotManifest.source.headCommit}`,
    `Config: ${report.reviewConfigRef}`,
    `Changes: ${report.snapshotManifest.paths.length}`,
  ];
  for (const entry of report.snapshotManifest.paths) {
    lines.push(`${entry.changeType} ${entry.path}`);
  }
  lines.push(`Exclusions: ${report.snapshotManifest.exclusions.length}`);
  for (const exclusion of report.snapshotManifest.exclusions) {
    lines.push(`${exclusion.reason} ${exclusion.path}`);
  }
  lines.push(`Omissions: ${report.snapshotManifest.omissions.length}`);
  lines.push(`Canonical inputs: ${report.canonicalInputs.requirements.length + 1}`);
  lines.push(`Captured blobs: ${report.blobCount}`);
  lines.push(`Author packet: ${report.authorPacketPresent ? "stored separately" : "not provided"}`);
  return lines.join("\n");
}

/** Loads the pinned config and constructs the provider for the two commands that call one. */
async function resolveLiveReviewContextV1(
  options: Map<string, string | true>,
  dependencies: CliDependenciesV1,
): Promise<{ config: z.infer<typeof ReviewRunConfigV2Schema>; provider: ReviewProviderV1 }> {
  const apiKey = dependencies.readOpenRouterApiKey();
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("OPENROUTER_API_KEY is required in the environment for a live review.");
  }
  const configPath = resolve(requiredOption(options, "--config"));
  const config = ReviewRunConfigV2Schema.parse(JSON.parse(await readFile(configPath, "utf8")));
  return { config, provider: dependencies.createProvider(apiKey, config.providerRouting) };
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
  const { config, provider } = await resolveLiveReviewContextV1(options, dependencies);
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
  const { config, provider } = await resolveLiveReviewContextV1(options, dependencies);
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
  const inspected = await inspectSnapshotPacketV1(resolve(requiredOption(options, "--packet")));
  const report = buildInspectionReportV1(inspected);
  if (options.get("--json") === true) {
    io.stdout(JSON.stringify(report, null, 2));
    return;
  }
  io.stdout(formatInspection(report));
}

export async function runCliV1(
  args: string[],
  io: CliIoV1 = processIo,
  dependencies: CliDependenciesV1 = processDependencies,
): Promise<number> {
  const [command, ...optionArgs] = args;
  // Help and version answer on stdout with exit 0: they are the successful outcome of the
  // request, not a failure to parse it.
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.stdout(usageText());
    return 0;
  }
  if (command === "--version" || command === "-v") {
    io.stdout(CLI_VERSION_V1);
    return 0;
  }
  try {
    if (!COMMAND_SPECS_V1[command]) {
      throw new Error(`Unknown command ${command}\n\n${usageText()}`);
    }
    if (optionArgs.includes("--help") || optionArgs.includes("-h")) {
      io.stdout(usageText(command));
      return 0;
    }
    const options = parseCommandOptions(command, optionArgs);
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
    return await resumeFinal(options, io, dependencies);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "Unknown command failure");
    if (error instanceof ProviderCallError && error.responseMetadata !== null) {
      io.stderr(`Provider response metadata: ${JSON.stringify(error.responseMetadata)}`);
    }
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
