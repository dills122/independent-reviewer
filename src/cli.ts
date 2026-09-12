#!/usr/bin/env node
import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError, Option } from "commander";
import {
  createProgressOutput,
  formatRunCost,
  terminalReviewSummary,
  terminalText,
} from "./cli/review-output.js";
import {
  readLocalSimpleReviewSettingsV1,
  saveLocalSimpleReviewSettingsV1,
} from "./cli/simple-settings.js";
import {
  assembleStandardsRequest,
  loadLocalSettings,
  saveLocalSettings,
} from "./cli/standards-input.js";
import {
  type FinalReviewReportV1,
  type ResolvedSimpleReviewSettingsV1,
  type ReviewRunConfigV3,
  ReviewRunConfigV3Schema,
  resolveSimpleReviewSettingsV1,
} from "./contracts/index.js";
import { buildInspectionReport, type InspectionReport } from "./contracts/inspection-report.js";
import { jsonDocument } from "./contracts/json-document.js";
import {
  canonicalInputList,
  type ReviewRequest,
  ReviewRequestSchema,
} from "./contracts/standards-review.js";
import { captureReviewerRulesGuidanceV1 } from "./guidance/reviewer-rules.js";
import { withReviewProgress } from "./orchestrator/progress.js";
import {
  preflightReview,
  resumeFinalReview,
  runTwoStageReview,
} from "./orchestrator/two-stage-review.js";
import { ProviderCallPacerV1 } from "./provider/call-pacing.js";
import { OpenRouterProviderV1, ProviderCallError } from "./provider/openrouter.js";
import type { ReviewProviderV1 } from "./provider/review-provider.js";
import { reviewVerdictLabel } from "./report/markdown.js";
import {
  captureGitSnapshotV1,
  isPathIgnoredV1,
  resolveRepositoryRootV1,
} from "./snapshot/git-capture.js";
import { inspectSnapshotPacket, writeSnapshotPacketV1 } from "./snapshot/snapshot-packet.js";

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
  createProvider(apiKey: string, config: ReviewRunConfigV3): ReviewProviderV1;
}

const processDependencies: CliDependenciesV1 = {
  readOpenRouterApiKey: () => process.env.OPENROUTER_API_KEY,
  createProvider: (apiKey, config) =>
    new OpenRouterProviderV1(
      apiKey,
      config.providerRouting,
      fetch,
      // One pacer per run: workers sharing a model stay under the account burst limit, which is
      // where the "rate limited with almost no traffic" 429s came from.
      new ProviderCallPacerV1(config.budgets.minimumCallIntervalMs),
    ),
};

interface PreparedPacketV1 {
  claim?: () => Promise<void>;
  standards: boolean;
  packetPath: string;
  captured: Awaited<ReturnType<typeof captureGitSnapshotV1>>;
  repositoryRoot: string;
  /** Reviewer-rules sources frozen into the packet; undefined when capture did not run. */
  guidanceSourceCount?: number;
}

interface PacketPreparationPolicyV1 {
  expectedConfigId?: string;
  suppliedConfig?: ReviewRunConfigV3;
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

const SNAPSHOT_PACKET_MARKERS_V1 = [
  "snapshot-manifest.json",
  "canonical-inputs.json",
  "packet-metadata.json",
] as const;

const COMMAND_SPECS_V1: Record<string, CommandSpecV1> = {
  init: {
    summary: "Save local review settings without calling a provider.",
    options: {
      repo: { type: "string", description: "Repository (default current directory)." },
      model: { type: "string", description: "Supported review model profile." },
      "max-cost": { type: "string", description: "Maximum review cost in US dollars." },
      config: { type: "string", description: "Advanced review configuration file." },
      standards: {
        type: "string",
        description: "Selected standards profile JSON.",
      },
      author: { type: "string", description: "Author overview or packet file." },
    },
  },
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
      repo: { type: "string", description: "Repository (default current directory)." },
      standards: { type: "string", description: "Selected standards profile JSON." },
      author: { type: "string", description: "Author overview Markdown or author packet JSON." },
      "dry-run": {
        type: "boolean",
        description: "Validate scope and budgets without provider calls.",
      },
      "new-flow": { type: "boolean", description: "Explicitly start a new standards review flow." },
      quiet: { type: "boolean", description: "Suppress progress messages." },
      request: { type: "string", description: "Path to the review request JSON.", required: false },
      config: { type: "string", description: "Path to the review run config.", required: false },
      model: { type: "string", description: "Supported review model profile." },
      "max-cost": { type: "string", description: "Maximum review cost in US dollars." },
      base: { type: "string", description: "Override base ref resolution." },
      output: { type: "string", description: "Packet directory (default <repo>/.review-runs)." },
      exclude: { type: "string", description: "Comma-separated glob patterns to exclude." },
    },
  },
  "resume-final": {
    summary: "Retry only a final stage that failed with a definite provider error.",
    options: {
      packet: { type: "string", description: "Path to the snapshot packet.", required: true },
      config: { type: "string", description: "Path to the advanced review run config." },
      repo: { type: "string", description: "Repository (default current directory)." },
      model: { type: "string", description: "Supported review model profile." },
      "max-cost": { type: "string", description: "Maximum review cost in US dollars." },
    },
  },
  config: {
    summary: "Show simple settings or their resolved runtime policy.",
    options: {
      repo: { type: "string", description: "Repository (default current directory)." },
      model: { type: "string", description: "Override supported review model profile." },
      "max-cost": { type: "string", description: "Override maximum review cost." },
      resolved: { type: "boolean", description: "Include complete resolved runtime policy." },
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
    `Usage: independent-reviewer ${command === "config" ? "config show" : command} [options]`,
    "",
    spec.summary,
    "",
    "Options:",
  ];
  for (const [name, option] of Object.entries(spec.options)) {
    const valueHint = option.type === "string" ? " <value>" : "";
    const requirement = option.required ? " (required)" : "";
    const optionLabel = `  --${name}${valueHint}`.padEnd(24);
    lines.push(`${optionLabel}${option.description}${requirement}`);
  }
  lines.push(`${"  --help".padEnd(24)}Print this message.`);
  return lines.join("\n");
}

/**
 * Uses Commander for option grammar while retaining product-level uniqueness and dash-leading
 * value diagnostics required by digest-bound configuration.
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
  for (const name of Object.keys(spec.options)) {
    const flag = `--${name}`;
    const count = args.filter(
      (argument) => argument === flag || argument.startsWith(`${flag}=`),
    ).length;
    if (count > 1) throw new Error(`Option ${flag} was given ${count} times; give it once.`);
  }
  for (const [index, argument] of args.entries()) {
    const option = argument.startsWith("--") ? spec.options[argument.slice(2)] : undefined;
    if (option?.type === "string" && args[index + 1]?.startsWith("-")) {
      throw new Error(
        `Option ${argument} needs a value. Pass a dash-leading value as ${argument}=<value>.\n\n${usageText(command)}`,
      );
    }
  }
  const parser = new Command(command)
    .helpOption(false)
    .allowUnknownOption(false)
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  for (const [name, option] of Object.entries(spec.options)) {
    parser.addOption(
      new Option(option.type === "string" ? `--${name} <value>` : `--${name}`, option.description),
    );
  }
  try {
    parser.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.optionMissingArgument") {
      const missing = args.find(
        (argument, index) =>
          spec.options[argument.slice(2)]?.type === "string" &&
          (args[index + 1] === undefined || args[index + 1]?.startsWith("-")),
      );
      if (missing) {
        throw new Error(
          `Option ${missing} needs a value. Pass a dash-leading value as ${missing}=<value>.\n\n${usageText(command)}`,
        );
      }
    }
    const message =
      error instanceof Error ? error.message.replace(/^error: /, "") : "Invalid arguments";
    throw new Error(
      `${message.charAt(0).toUpperCase()}${message.slice(1)}\n\n${usageText(command)}`,
    );
  }

  const options = new Map<string, string | true>();
  for (const name of Object.keys(spec.options)) {
    const definition = parser.options.find((candidate) => candidate.long === `--${name}`);
    const value = definition ? parser.getOptionValue(definition.attributeName()) : undefined;
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

function maxCostOptionV1(options: Map<string, string | true>): number | undefined {
  const value = options.get("--max-cost");
  if (typeof value !== "string") return undefined;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    throw new Error("--max-cost must be a positive finite decimal number.");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("--max-cost must be a positive finite decimal number.");
  }
  return parsed;
}

async function resolveSimpleSettingsForOptionsV1(
  options: Map<string, string | true>,
): Promise<ResolvedSimpleReviewSettingsV1> {
  const repository = await resolveRepositoryRootV1(
    typeof options.get("--repo") === "string" ? String(options.get("--repo")) : process.cwd(),
  );
  const maxCostUsd = maxCostOptionV1(options);
  return resolveSimpleReviewSettingsV1({
    local: await readLocalSimpleReviewSettingsV1(repository),
    cli: {
      ...(typeof options.get("--model") === "string" ? { model: options.get("--model") } : {}),
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    },
  });
}

async function initializeReviewSettingsV1(options: Map<string, string | true>): Promise<string> {
  const usesSimpleSettings = options.has("--model") || options.has("--max-cost");
  const usesAdvancedSettings = ["--config", "--standards", "--author"].some((name) =>
    options.has(name),
  );
  if (usesSimpleSettings && usesAdvancedSettings) {
    throw new Error(
      "Use either advanced config/standards/author settings or simple model/cost settings, not both.",
    );
  }
  if (!usesSimpleSettings) return saveLocalSettings(options);

  const repository = await resolveRepositoryRootV1(
    typeof options.get("--repo") === "string" ? String(options.get("--repo")) : process.cwd(),
  );
  const maxCostUsd = maxCostOptionV1(options);
  const resolved = resolveSimpleReviewSettingsV1({
    cli: {
      ...(typeof options.get("--model") === "string" ? { model: options.get("--model") } : {}),
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    },
  });
  return saveLocalSimpleReviewSettingsV1(repository, resolved.settings);
}

async function showSimpleReviewConfigV1(
  options: Map<string, string | true>,
  io: CliIoV1,
): Promise<void> {
  const resolved = await resolveSimpleSettingsForOptionsV1(options);
  const visible = options.has("--resolved")
    ? resolved
    : {
        schemaVersion: resolved.schemaVersion,
        settings: resolved.settings,
        provenance: resolved.provenance,
        profile: resolved.profile,
        settingsDigest: resolved.settingsDigest,
      };
  io.stdout(jsonDocument(visible).trimEnd());
}

/** The run configuration for this invocation, from `--config` or from simple settings. */
async function resolveReviewConfigV1(
  options: Map<string, string | true>,
): Promise<ReviewRunConfigV3> {
  const configPath = options.get("--config");
  const usesSimpleFlags = options.has("--model") || options.has("--max-cost");
  if (typeof configPath === "string" && usesSimpleFlags) {
    throw new Error("Use either --config or simple model/cost settings, not both.");
  }
  if (typeof configPath === "string") {
    return ReviewRunConfigV3Schema.parse(JSON.parse(await readFile(resolve(configPath), "utf8")));
  }
  return (await resolveSimpleSettingsForOptionsV1(options)).reviewRunConfig;
}

function requiredOption(options: Map<string, string | true>, name: string): string {
  const value = options.get(name);
  if (typeof value !== "string") {
    throw new Error(`Missing required option ${name}`);
  }
  return value;
}

/** The human-readable view of the same validated report the JSON view emits. */
/** Says which of the three states a packet is in, so a missing rules file is never ambiguous. */
function reviewerGuidanceSummary(guidance: InspectionReport["reviewerGuidance"]): string {
  if (!guidance.captured) return "not captured for this packet";
  if (guidance.sourceCount === 0) return "captured; repository has no reviewer rules";
  return `${guidance.sourceCount} source(s), graph ${guidance.guidanceGraphDigest?.value ?? "unknown"}`;
}

function formatInspection(report: InspectionReport): string {
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
  lines.push(`Canonical inputs: ${canonicalInputList(report.canonicalInputs).length}`);
  lines.push(`Captured blobs: ${report.blobCount}`);
  lines.push(`Author packet: ${report.authorPacketPresent ? "stored separately" : "not provided"}`);
  lines.push(`Reviewer guidance: ${reviewerGuidanceSummary(report.reviewerGuidance)}`);
  return lines.join("\n");
}

/** Loads the pinned config and constructs the provider for the two commands that call one. */
async function resolveLiveReviewContextV1(
  config: ReviewRunConfigV3,
  dependencies: CliDependenciesV1,
): Promise<{ config: ReviewRunConfigV3; provider: ReviewProviderV1 }> {
  const apiKey = dependencies.readOpenRouterApiKey();
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("OPENROUTER_API_KEY is required in the environment for a live review.");
  }
  return { config, provider: dependencies.createProvider(apiKey, config) };
}

async function resolveAdvancedLiveReviewContextV1(
  options: Map<string, string | true>,
  dependencies: CliDependenciesV1,
): Promise<{ config: ReviewRunConfigV3; provider: ReviewProviderV1 }> {
  const apiKey = dependencies.readOpenRouterApiKey();
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("OPENROUTER_API_KEY is required in the environment for a live review.");
  }
  const config = await resolveReviewConfigV1(options);
  return { config, provider: dependencies.createProvider(apiKey, config) };
}

/** The repository's own preference for letting its committed rules steer a review. */
async function repositoryDiscoversSteeringV1(repositoryPath: string): Promise<boolean> {
  const local = await readLocalSimpleReviewSettingsV1(repositoryPath);
  return local?.discoverRepositorySteering ?? true;
}

async function preparePacket(
  options: Map<string, string | true>,
  policy: PacketPreparationPolicyV1 = {},
): Promise<PreparedPacketV1> {
  const requestOption = options.get("--request");
  if (requestOption && ["--standards", "--author", "--new-flow"].some((key) => options.has(key)))
    throw new Error("Use either --request or standards/author inputs, not both.");
  const assembled = requestOption
    ? undefined
    : await assembleStandardsRequest(options, policy.suppliedConfig);
  const requestPath = typeof requestOption === "string" ? resolve(requestOption) : undefined;
  let request: ReviewRequest;
  if (assembled) request = assembled.request;
  else {
    if (!requestPath) throw new Error("Review request path is required.");
    request = ReviewRequestSchema.parse(JSON.parse(await readFile(requestPath, "utf8")));
  }
  if (policy.expectedConfigId && request.reviewConfigRef !== policy.expectedConfigId) {
    throw new Error(
      `Review request config reference ${request.reviewConfigRef} does not match ${policy.expectedConfigId}.`,
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
  const priorPacketRoots =
    typeof requestedOutput === "string" &&
    (await isStrictDescendantFileSystemPathV1(repositoryRoot, packetRoot))
      ? await findSiblingSnapshotPacketsV1(packetRoot)
      : [];
  const captured = await captureGitSnapshotV1(request, {
    ...(typeof base === "string" ? { base } : {}),
    ...(policy.suppliedConfig
      ? { maxReferencedSourceBytes: policy.suppliedConfig.budgets.maxInitialEvidenceBytes }
      : {}),
    excludedFileSystemPaths: [
      ...(requestPath ? [requestPath] : []),
      ...(assembled?.excludedPaths ?? []),
      ...(typeof configPath === "string" ? [resolve(configPath)] : []),
      defaultPacketRoot,
      packetRoot,
      ...priorPacketRoots,
    ],
    ...(typeof excludePatterns === "string"
      ? { excludedPathPatterns: excludePatterns.split(",").filter((entry) => entry.length > 0) }
      : {}),
  });
  const packetPath =
    typeof requestedOutput === "string"
      ? packetRoot
      : join(defaultPacketRoot, captured.manifest.snapshotId);
  // Reviewer rules are a property of the repository, not of how this run was configured, so every
  // packet-producing path resolves the same preference here rather than each caller deciding. An
  // earlier parameter defaulted to off, which silently dropped guidance from `prepare` and from
  // `review --config` (#105). Guidance is standards-only downstream, so a requirements-mode request
  // never captures it: a graph in a v1 packet would fail brief construction instead.
  const guidance =
    request.schemaVersion === 2 && (await repositoryDiscoversSteeringV1(repositoryRoot))
      ? await captureReviewerRulesGuidanceV1(repositoryRoot, captured.manifest)
      : undefined;
  await writeSnapshotPacketV1(packetPath, captured, request, guidance ? { guidance } : {});
  return {
    ...(guidance ? { guidanceSourceCount: guidance.graph.nodes.length } : {}),
    packetPath,
    captured,
    repositoryRoot,
    standards: request.schemaVersion === 2,
    ...(assembled ? { claim: assembled.claim } : {}),
  };
}

/** Finds complete sibling packets without treating their arbitrary parent as runner-owned. */
async function findSiblingSnapshotPacketsV1(packetRoot: string): Promise<string[]> {
  const packetParent = dirname(packetRoot);
  const entries = await readdir(packetParent, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packetParent, entry.name))
    .filter((candidate) => candidate !== packetRoot);
  const identified = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const [blobs, ...markers] = await Promise.all([
          stat(join(candidate, "blobs")),
          ...SNAPSHOT_PACKET_MARKERS_V1.map((marker) => stat(join(candidate, marker))),
        ]);
        return blobs.isDirectory() && markers.every((marker) => marker.isFile())
          ? candidate
          : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    }),
  );
  return identified.filter((candidate): candidate is string => candidate !== undefined);
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

async function isStrictDescendantFileSystemPathV1(
  parentPath: string,
  candidatePath: string,
): Promise<boolean> {
  const relativePath = relative(parentPath, await realpathNearestAncestor(candidatePath));
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
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
  const insideWorktree = await isStrictDescendantFileSystemPathV1(repositoryRoot, packetPath);
  if (!insideWorktree || (await isPathIgnoredV1(repositoryRoot, resolvedPacketPath))) {
    return;
  }
  io.stderr(
    `Warning: ${packetPath} is inside the reviewed worktree and is not ignored by Git. Add it to .gitignore, or a later review will capture this packet as evidence.`,
  );
}

/** Mirrors the inspect wording so the two views describe the same three states. */
function preparedGuidanceSummary(sourceCount: number | undefined): string {
  if (sourceCount === undefined) return "not captured for this packet";
  return sourceCount === 0
    ? "captured; repository has no reviewer rules"
    : `${sourceCount} source(s)`;
}

async function prepare(options: Map<string, string | true>, io: CliIoV1): Promise<void> {
  const { captured, packetPath, repositoryRoot, guidanceSourceCount } =
    await preparePacket(options);
  await warnUnignoredPacketLocation(repositoryRoot, packetPath, io);
  io.stdout(`Prepared snapshot packet: ${packetPath}`);
  io.stdout(`Snapshot digest: ${captured.manifest.snapshotDigest.value}`);
  io.stdout(`Captured changes: ${captured.manifest.paths.length}`);
  io.stdout(`Visible exclusions: ${captured.manifest.exclusions.length}`);
  io.stdout(`Reviewer guidance: ${preparedGuidanceSummary(guidanceSourceCount)}`);
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
  const explicitAdvancedConfig = options.has("--config");
  const explicitSimpleSettings = options.has("--model") || options.has("--max-cost");
  if (!options.has("--request")) {
    await loadLocalSettings(options);
    if (explicitSimpleSettings && !explicitAdvancedConfig) options.delete("--config");
  }
  if (options.has("--dry-run")) {
    const config = await resolveReviewConfigV1(options);
    const temporary = await mkdtemp(join(tmpdir(), "independent-reviewer-preflight-"));
    try {
      const dryOptions = new Map(options);
      dryOptions.set("--output", join(temporary, "packet"));
      const prepared = await preparePacket(dryOptions, {
        expectedConfigId: config.configId,
        suppliedConfig: config,
      });
      const admission = await preflightReview(prepared.packetPath, config);
      io.stdout(
        `Dry-run: ${prepared.captured.manifest.paths.length} changed paths, ${prepared.captured.manifest.exclusions.length} exclusions. No provider calls.`,
      );
      const routeSummary =
        admission.preferredProviders.length === 0
          ? "any eligible endpoint"
          : `${admission.preferredProviders.map(terminalText).join(", ")}${
              admission.pinnedToPreferredProviders
                ? " (pinned, no failover)"
                : " first, then failover"
            }`;
      const modelSummary = [admission.model, ...admission.fallbackModels]
        .map(terminalText)
        .join(" -> ");
      io.stdout(`Models: ${modelSummary}; providers: ${routeSummary}`);
      io.stdout(
        `Reserved tokens: ${admission.reservedTokens}; reserved cost: $${admission.reservedCostUsd.toFixed(6)} (not a billed amount).`,
      );
      if (admission.guidanceAdmission) {
        io.stdout(
          `Reviewer guidance: ${admission.guidanceAdmission.contentBytes} content bytes (${admission.guidanceAdmission.status}).`,
        );
      }
      return 0;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  const hasSimpleFlags = options.has("--model") || options.has("--max-cost");
  const usesAdvancedConfig = typeof options.get("--config") === "string" && !hasSimpleFlags;
  const live: { config: ReviewRunConfigV3; provider: ReviewProviderV1 } = usesAdvancedConfig
    ? await resolveAdvancedLiveReviewContextV1(options, dependencies)
    : await resolveLiveReviewContextV1(await resolveReviewConfigV1(options), dependencies);
  const { config, provider } = live;
  const prepared = await preparePacket(options, {
    expectedConfigId: config.configId,
    suppliedConfig: config,
  });
  await warnUnignoredPacketLocation(prepared.repositoryRoot, prepared.packetPath, io);
  io.stdout(`Prepared snapshot packet: ${prepared.packetPath}`);
  if (prepared.claim) {
    await preflightReview(prepared.packetPath, config);
    await prepared.claim();
  }
  const progress = createProgressOutput(io.stderr, !prepared.standards || options.has("--quiet"));
  try {
    const result = await withReviewProgress(progress.observe, () =>
      runTwoStageReview(prepared.packetPath, config, provider),
    );
    io.stdout(
      prepared.standards
        ? terminalReviewSummary(result.report)
        : `Verdict: ${reviewVerdictLabel(result.report)}`,
    );
    io.stdout(`Report: ${result.markdownPath}`);
    if (prepared.standards) {
      const events = (await readFile(result.runRecordPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      io.stdout(formatRunCost(events));
    }
    return reviewOutcomeExitCodeV1(result.report.verdict);
  } catch (error) {
    if (prepared.standards) {
      io.stderr(`Review did not complete. Saved packet: ${terminalText(prepared.packetPath)}`);
      if (error instanceof ProviderCallError && error.code === "TRANSPORT_UNCERTAIN")
        io.stderr(
          "Provider outcome and cost may be unknown. This submission cannot be safely replayed automatically.",
        );
      else {
        let events: Record<string, unknown>[] = [];
        try {
          events = (await readFile(join(prepared.packetPath, "review", "run-record.jsonl"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        } catch {
          /* Input/preflight may have failed before a ledger exists. */
        }
        const persisted = events.some((event) => event.type === "PRELIMINARY_PERSISTED");
        io.stderr(
          persisted
            ? "Initial assessment is saved; the final review did not complete."
            : "No valid initial assessment was saved. Correct the reported failure before starting another review.",
        );
        const eligibleShape = [
          "RUN_STARTED",
          "CALL_STARTED",
          "CALL_SUCCEEDED",
          "PRELIMINARY_PERSISTED",
          "AUTHOR_DELIVERED",
          "CALL_STARTED",
          "CALL_FAILED",
          "RUN_FAILED",
        ];
        if (
          error instanceof ProviderCallError &&
          error.diagnostic?.httpStatus === 429 &&
          JSON.stringify(events.map((event) => event.type)) === JSON.stringify(eligibleShape)
        ) {
          const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
          const resumeConfig =
            typeof options.get("--config") === "string"
              ? `--config ${quote(resolve(requiredOption(options, "--config")))}`
              : `--model ${quote(config.model)} --max-cost ${config.budgets.maxTotalCostUsd}`;
          io.stderr(
            `A final-only retry may be available. This command revalidates eligibility: independent-reviewer resume-final --packet ${quote(prepared.packetPath)} ${resumeConfig}`,
          );
        } else if (persisted)
          io.stderr(
            "This failure has no remaining final-only resume under the current policy. No automatic new review will be started.",
          );
        if (events.length) io.stderr(formatRunCost(events));
      }
    }
    throw error;
  } finally {
    progress.close();
  }
}

async function resumeFinal(
  options: Map<string, string | true>,
  io: CliIoV1,
  dependencies: CliDependenciesV1,
): Promise<number> {
  const config = await resolveReviewConfigV1(options);
  const { provider } = await resolveLiveReviewContextV1(config, dependencies);
  const result = await resumeFinalReview(
    resolve(requiredOption(options, "--packet")),
    config,
    provider,
  );
  io.stdout(`Verdict: ${reviewVerdictLabel(result.report)}`);
  io.stdout(`Report: ${result.markdownPath}`);
  return reviewOutcomeExitCodeV1(result.report.verdict);
}

async function inspect(options: Map<string, string | true>, io: CliIoV1): Promise<void> {
  const inspected = await inspectSnapshotPacket(resolve(requiredOption(options, "--packet")));
  const report = buildInspectionReport(inspected);
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
    const commandOptionArgs =
      command === "config"
        ? optionArgs[0] === "show"
          ? optionArgs.slice(1)
          : optionArgs
        : optionArgs;
    if (command === "config" && !["show", "--help", "-h"].includes(optionArgs[0] ?? "")) {
      throw new Error(`Unknown config command ${optionArgs[0] ?? ""}\n\n${usageText(command)}`);
    }
    if (commandOptionArgs.includes("--help") || commandOptionArgs.includes("-h")) {
      io.stdout(usageText(command));
      return 0;
    }
    const options = parseCommandOptions(command, commandOptionArgs);
    if (command === "init") {
      io.stdout(`Saved review settings: ${await initializeReviewSettingsV1(options)}`);
      return 0;
    }
    if (command === "config") {
      await showSimpleReviewConfigV1(options, io);
      return 0;
    }
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
