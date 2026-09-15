#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { terminalText } from "../src/cli/review-output.js";
import { runCliV1 } from "../src/cli.js";
import { FinalReviewReportV1Schema } from "../src/contracts/review-results.js";
import {
  type ReviewRunConfigV3,
  ReviewRunConfigV3Schema,
} from "../src/contracts/review-run-config.js";
import type { RunRecordEventV1 } from "../src/contracts/run-record.js";
import { StandardsReportV3Schema } from "../src/contracts/standards-results.js";
import { readStrictJsonFileV1 } from "../src/contracts/strict-json.js";
import { readRunRecordEventsV1 } from "../src/orchestrator/run-record.js";
import { prepareEvaluationCaseV1 } from "./fixture-builder.js";
import { parseEvaluationMatrixCommandV1 } from "./matrix-cli.js";
import {
  EVALUATION_CASES_V1,
  selectEvaluationCasesV1,
  validatePaidMatrixAdmissionV1,
} from "./matrix-selection.js";
import type {
  EvaluationCaseV1,
  EvaluationExecutionV1,
  EvaluationVerdictV1,
} from "./matrix-types.js";

const exec = promisify(execFile);
const DEFAULT_CONFIG_PATH_V1 = resolve("evaluation/configs/gpt-oss-120b-zdr.json");
const RUN_ROOT_V1 = resolve(".review-runs/evaluation");
const MAX_CONFIG_BYTES_V1 = 1024 * 1024;
const MAX_REPORT_BYTES_V1 = 16 * 1024 * 1024;
const MAX_RUN_RECORD_BYTES_V1 = 64 * 1024 * 1024;
const MAX_RUN_RECORD_LINE_BYTES_V1 = 8 * 1024 * 1024;

export interface MatrixIoV1 {
  stdout(message: string): void;
  stderr(message: string): void;
}

const processIoV1: MatrixIoV1 = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
};

export interface RunRecordSummaryV1 {
  callsStarted: number;
  callsSucceeded: number;
  callsFailed: number;
  reportedPromptTokens: number;
  reportedCompletionTokens: number;
  reportedTotalTokens: number;
  reportedCostUsd: number;
  unknownCostAttempts: number;
  conservativeRetryTokens: number;
  conservativeRetryCostUsd: number;
  providers: readonly string[];
  terminalState: EvaluationVerdictV1 | "FAILED" | "TRANSPORT_UNCERTAIN" | null;
}

export interface MatrixCaseResultV1 {
  schemaVersion: 1;
  caseId: EvaluationCaseV1["id"];
  reviewMode: EvaluationCaseV1["reviewMode"];
  expectedVerdict: EvaluationVerdictV1;
  actualVerdict: EvaluationVerdictV1 | null;
  cliExitCode: number | null;
  elapsedMs: number;
  complete: boolean;
  verdictMatched: boolean | null;
  ledgerTerminalStateMatched: boolean;
  accounting: RunRecordSummaryV1;
  stdout: readonly string[];
  stderr: readonly string[];
  error: { name: string; message: string } | null;
}

export const MAX_MATRIX_ERROR_MESSAGE_LENGTH_V1 = 512;
const MAX_MATRIX_ERROR_CONTEXT_LENGTH_V1 = 160;

function boundedMatrixTextV1(message: string, maxLength: number): string {
  const normalized = terminalText(message).trim();
  if (normalized.length <= maxLength) return normalized;
  let prefixLength = maxLength - 3;
  const finalCodeUnit = normalized.charCodeAt(prefixLength - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) prefixLength -= 1;
  return `${normalized.slice(0, prefixLength)}...`;
}

function boundedMatrixErrorMessageV1(message: string): string {
  return boundedMatrixTextV1(message, MAX_MATRIX_ERROR_MESSAGE_LENGTH_V1);
}

function matrixErrorContextV1(
  stderr: readonly string[],
  detailLabel: string,
  detail?: string,
): string {
  const lastDiagnostic = stderr.at(-1);
  return [
    detail
      ? `${detailLabel}: ${boundedMatrixTextV1(detail, MAX_MATRIX_ERROR_CONTEXT_LENGTH_V1)}`
      : null,
    lastDiagnostic
      ? `stderr: ${boundedMatrixTextV1(lastDiagnostic, MAX_MATRIX_ERROR_CONTEXT_LENGTH_V1)}`
      : null,
  ]
    .filter((value): value is string => value !== null)
    .join("; ");
}

function reviewIncompleteErrorV1(
  cliExitCode: number,
  stderr: readonly string[],
  detail?: string,
): NonNullable<MatrixCaseResultV1["error"]> {
  const context = matrixErrorContextV1(stderr, "validation", detail);
  return {
    name: "ReviewIncomplete",
    message: boundedMatrixErrorMessageV1(
      `Review command exited ${cliExitCode} without a validated final report${context ? `: ${context}` : "."}`,
    ),
  };
}

function matrixAccountingErrorV1(
  cliExitCode: number,
  actualVerdict: EvaluationVerdictV1,
  stderr: readonly string[],
  detail: string,
): NonNullable<MatrixCaseResultV1["error"]> {
  const context = matrixErrorContextV1(stderr, "accounting", detail);
  return {
    name: "MatrixAccountingError",
    message: boundedMatrixErrorMessageV1(
      `Review command exited ${cliExitCode} with validated verdict ${actualVerdict}, but matrix accounting failed${context ? `: ${context}` : "."}`,
    ),
  };
}

function matrixExecutionErrorV1(
  cliExitCode: number,
  stderr: readonly string[],
  detail: string,
): NonNullable<MatrixCaseResultV1["error"]> {
  const context = matrixErrorContextV1(stderr, "execution", detail);
  return {
    name: "MatrixExecutionError",
    message: boundedMatrixErrorMessageV1(
      `Review command exited ${cliExitCode} without a successful matrix case${context ? `: ${context}` : "."}`,
    ),
  };
}

function finiteNonnegativeV1(value: number | null): number {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function summarizeRunRecordV1(events: readonly RunRecordEventV1[]): RunRecordSummaryV1 {
  let reportedPromptTokens = 0;
  let reportedCompletionTokens = 0;
  let reportedTotalTokens = 0;
  let reportedCostUsd = 0;
  let unknownCostAttempts = 0;
  let conservativeRetryTokens = 0;
  let conservativeRetryCostUsd = 0;
  let terminalState: RunRecordSummaryV1["terminalState"] = null;
  const providers = new Set<string>();

  for (const event of events) {
    if (event.type === "CALL_SUCCEEDED" || event.type === "CALL_FAILED") {
      const usage = event.type === "CALL_SUCCEEDED" ? event.usage : event.responseMetadata?.usage;
      if (usage) {
        reportedPromptTokens += finiteNonnegativeV1(usage.promptTokens);
        reportedCompletionTokens += finiteNonnegativeV1(usage.completionTokens);
        reportedTotalTokens += finiteNonnegativeV1(usage.totalTokens);
      }
      if (usage?.cost !== null && usage?.cost !== undefined && Number.isFinite(usage.cost)) {
        reportedCostUsd += Math.max(0, usage.cost);
      } else {
        unknownCostAttempts += 1;
      }
      const provider =
        event.type === "CALL_SUCCEEDED" ? event.returnedProvider : event.responseMetadata?.provider;
      if (provider) providers.add(provider);
    }
    if (event.type === "PROVIDER_RETRY_REQUESTED") {
      conservativeRetryTokens += event.chargedFailedTokens;
      conservativeRetryCostUsd += event.chargedFailedCostUsd;
    }
    if (event.type === "RUN_COMPLETED" || event.type === "RUN_FAILED") {
      terminalState = event.terminalState;
    }
  }

  return {
    callsStarted: events.filter(({ type }) => type === "CALL_STARTED").length,
    callsSucceeded: events.filter(({ type }) => type === "CALL_SUCCEEDED").length,
    callsFailed: events.filter(({ type }) => type === "CALL_FAILED").length,
    reportedPromptTokens,
    reportedCompletionTokens,
    reportedTotalTokens,
    reportedCostUsd,
    unknownCostAttempts,
    conservativeRetryTokens,
    conservativeRetryCostUsd,
    providers: [...providers].sort(),
    terminalState,
  };
}

export function evaluateCaseCompletionV1(input: {
  execution: EvaluationExecutionV1;
  cliExitCode: number;
  actualVerdict: EvaluationVerdictV1 | null;
  expectedVerdict: EvaluationVerdictV1;
}): { complete: boolean; verdictMatched: boolean | null } {
  if (input.execution === "dry") {
    return { complete: input.cliExitCode === 0, verdictMatched: null };
  }
  const complete = [0, 2, 3].includes(input.cliExitCode) && input.actualVerdict !== null;
  return {
    complete,
    verdictMatched: complete && input.actualVerdict === input.expectedVerdict,
  };
}

export function validateLiveEngineStateV1(
  execution: EvaluationExecutionV1,
  engineDirty: boolean,
): void {
  if (execution === "live" && engineDirty) {
    throw new Error("Live evaluation requires a clean committed checkout.");
  }
}

async function writeJsonV1(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function readConfigV1(path: string): Promise<{ config: ReviewRunConfigV3; digest: string }> {
  const [config, bytes] = await Promise.all([
    readStrictJsonFileV1(path, { maxBytes: MAX_CONFIG_BYTES_V1, source: "evaluation config" }).then(
      (value) => ReviewRunConfigV3Schema.parse(value),
    ),
    readFile(path),
  ]);
  return { config, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

async function readVerdictV1(
  testCase: EvaluationCaseV1,
  finalPath: string,
): Promise<EvaluationVerdictV1 | null> {
  try {
    const value = await readStrictJsonFileV1(finalPath, {
      maxBytes: MAX_REPORT_BYTES_V1,
      source: `evaluation report ${testCase.id}`,
    });
    return testCase.reviewMode === "standards"
      ? StandardsReportV3Schema.parse(value).verdict
      : FinalReviewReportV1Schema.parse(value).verdict;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readRunRecordV1(path: string): Promise<readonly RunRecordEventV1[]> {
  try {
    const record = await readRunRecordEventsV1(path, {
      maxTotalBytes: MAX_RUN_RECORD_BYTES_V1,
      maxLineBytes: MAX_RUN_RECORD_LINE_BYTES_V1,
    });
    if (record.tailBytes !== 0) {
      throw new Error(`Evaluation run record has an incomplete ${record.tailBytes}-byte tail.`);
    }
    return record.events;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function emptyRunRecordSummaryV1(): RunRecordSummaryV1 {
  return summarizeRunRecordV1([]);
}

interface ExecuteEvaluationCaseInputV1 {
  testCase: EvaluationCaseV1;
  execution: EvaluationExecutionV1;
  runRoot: string;
  configPath: string;
  configId: string;
  io: MatrixIoV1;
}

interface ExecuteEvaluationCaseDependenciesV1 {
  prepareCase?: typeof prepareEvaluationCaseV1;
  runCli?: typeof runCliV1;
  readVerdict?: typeof readVerdictV1;
  readRunRecord?: typeof readRunRecordV1;
}

export async function executeEvaluationCaseV1(
  input: ExecuteEvaluationCaseInputV1,
  dependencies: ExecuteEvaluationCaseDependenciesV1 = {},
): Promise<MatrixCaseResultV1> {
  const prepareCase = dependencies.prepareCase ?? prepareEvaluationCaseV1;
  const runCli = dependencies.runCli ?? runCliV1;
  const readVerdict = dependencies.readVerdict ?? readVerdictV1;
  const readRunRecord = dependencies.readRunRecord ?? readRunRecordV1;
  const caseRoot = join(input.runRoot, input.testCase.id);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const startedAtMs = Date.now();
  let accounting = emptyRunRecordSummaryV1();
  let outputPath: string | undefined;
  let cliExitCode: number | null = null;
  let actualVerdict: EvaluationVerdictV1 | null = null;

  input.io.stdout(`START ${input.execution} ${input.testCase.id} ${input.testCase.title}`);
  try {
    const prepared = await prepareCase(input.testCase, caseRoot, input.configId);
    outputPath = prepared.outputPath;
    cliExitCode = await runCli(
      [
        "review",
        ...prepared.cliArguments,
        "--config",
        input.configPath,
        "--output",
        prepared.outputPath,
        ...(input.execution === "dry" ? ["--dry-run"] : []),
      ],
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
    );
    actualVerdict =
      input.execution === "live"
        ? await readVerdict(input.testCase, join(prepared.outputPath, "review", "final.json"))
        : null;
    const events =
      input.execution === "live"
        ? await readRunRecord(join(prepared.outputPath, "review", "run-record.jsonl"))
        : [];
    accounting = summarizeRunRecordV1(events);
    const completion = evaluateCaseCompletionV1({
      execution: input.execution,
      cliExitCode,
      actualVerdict,
      expectedVerdict: input.testCase.oracle.expectedVerdict,
    });
    const ledgerMatches = input.execution === "dry" || accounting.terminalState === actualVerdict;
    const complete = completion.complete && ledgerMatches;
    let incompleteError: MatrixCaseResultV1["error"] = null;
    if (!complete) {
      if (input.execution === "dry") {
        incompleteError = matrixExecutionErrorV1(
          cliExitCode,
          stderr,
          "provider-free admission did not complete",
        );
      } else if (actualVerdict === null) {
        incompleteError = reviewIncompleteErrorV1(cliExitCode, stderr);
      } else if (!ledgerMatches) {
        incompleteError = matrixAccountingErrorV1(
          cliExitCode,
          actualVerdict,
          stderr,
          `run ledger terminal state ${accounting.terminalState ?? "missing"} does not match validated verdict`,
        );
      } else {
        incompleteError = matrixExecutionErrorV1(
          cliExitCode,
          stderr,
          `validated verdict ${actualVerdict} is incompatible with the CLI exit status`,
        );
      }
    }
    const result: MatrixCaseResultV1 = {
      schemaVersion: 1,
      caseId: input.testCase.id,
      reviewMode: input.testCase.reviewMode,
      expectedVerdict: input.testCase.oracle.expectedVerdict,
      actualVerdict,
      cliExitCode,
      elapsedMs: Date.now() - startedAtMs,
      complete,
      verdictMatched: completion.verdictMatched,
      ledgerTerminalStateMatched: ledgerMatches,
      accounting,
      stdout,
      stderr,
      error: incompleteError,
    };
    await writeJsonV1(join(caseRoot, "matrix-result.json"), result);
    input.io.stdout(
      `END ${input.testCase.id} exit=${cliExitCode} verdict=${actualVerdict ?? "-"} matched=${completion.verdictMatched ?? "dry"} calls=${accounting.callsStarted}`,
    );
    return result;
  } catch (error) {
    if (input.execution === "live" && outputPath) {
      try {
        accounting = summarizeRunRecordV1(
          await readRunRecord(join(outputPath, "review", "run-record.jsonl")),
        );
      } catch {
        /* The original malformed-ledger error remains the case failure reason. */
      }
    }
    const normalizedCause =
      error instanceof Error
        ? { name: error.name, message: boundedMatrixErrorMessageV1(error.message) }
        : { name: "Error", message: "Unknown evaluation case failure." };
    const normalized =
      input.execution !== "live" || cliExitCode === null
        ? normalizedCause
        : actualVerdict === null
          ? reviewIncompleteErrorV1(cliExitCode, stderr, normalizedCause.message)
          : matrixAccountingErrorV1(cliExitCode, actualVerdict, stderr, normalizedCause.message);
    const result: MatrixCaseResultV1 = {
      schemaVersion: 1,
      caseId: input.testCase.id,
      reviewMode: input.testCase.reviewMode,
      expectedVerdict: input.testCase.oracle.expectedVerdict,
      actualVerdict,
      cliExitCode,
      elapsedMs: Date.now() - startedAtMs,
      complete: false,
      verdictMatched: input.execution === "dry" ? null : false,
      ledgerTerminalStateMatched: false,
      accounting,
      stdout,
      stderr,
      error: normalized,
    };
    await mkdir(caseRoot, { recursive: true });
    await writeJsonV1(join(caseRoot, "matrix-result.json"), result);
    input.io.stderr(`END ${input.testCase.id} incomplete: ${normalized.message}`);
    return result;
  }
}

function hasExplicitSelectorV1(selection: {
  suite?: string;
  groups?: readonly string[];
  cases?: readonly string[];
}): boolean {
  return (
    selection.suite !== undefined || selection.groups !== undefined || selection.cases !== undefined
  );
}

function listCasesV1(selected: readonly EvaluationCaseV1[], io: MatrixIoV1): void {
  for (const testCase of selected) {
    io.stdout(
      [
        testCase.id,
        testCase.reviewMode,
        `suites=${testCase.suites.join(",") || "-"}`,
        `groups=${testCase.groups.join(",")}`,
        testCase.title,
      ].join("\t"),
    );
  }
  io.stdout(`Selected ${selected.length} of ${EVALUATION_CASES_V1.length} cases.`);
}

export async function runEvaluationMatrixV1(
  args: readonly string[],
  io: MatrixIoV1 = processIoV1,
): Promise<number> {
  try {
    const command = parseEvaluationMatrixCommandV1(args);
    const listSelection =
      command.command === "list" && !hasExplicitSelectorV1(command.selection)
        ? { suite: "full" }
        : command.selection;
    const selected = selectEvaluationCasesV1(listSelection);
    if (command.command === "list") {
      listCasesV1(selected, io);
      return 0;
    }

    const configPath = resolve(command.configPath ?? DEFAULT_CONFIG_PATH_V1);
    const { config, digest: configDigest } = await readConfigV1(configPath);
    const admission =
      command.command === "live"
        ? validatePaidMatrixAdmissionV1({
            selected,
            perCaseMaxCostUsd: config.budgets.maxTotalCostUsd,
            confirmed: command.confirmPaid,
            operatorMaxTotalCostUsd: command.maxTotalCostUsd,
          })
        : null;

    const runLabel = command.runLabel;
    if (!runLabel) throw new Error("Execution requires --run-label.");
    const [{ stdout: commitStdout }, { stdout: statusStdout }] = await Promise.all([
      exec("git", ["rev-parse", "HEAD"]),
      exec("git", ["status", "--porcelain"]),
    ]);
    const engineDirty = statusStdout.length > 0;
    validateLiveEngineStateV1(command.command, engineDirty);

    const runRoot = join(RUN_ROOT_V1, runLabel);
    await mkdir(dirname(runRoot), { recursive: true });
    try {
      await mkdir(runRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Evaluation run ${runLabel} already exists; refusing to overwrite it.`);
      }
      throw error;
    }

    const manifest = {
      schemaVersion: 1,
      corpusVersion: 1,
      runLabel,
      execution: command.command,
      selector: command.selection,
      selectedCaseIds: selected.map(({ id }) => id),
      engineCommit: commitStdout.trim(),
      engineDirty,
      configPath: relative(process.cwd(), configPath),
      configDigest,
      perCaseMaxCostUsd: config.budgets.maxTotalCostUsd,
      operatorMaxTotalCostUsd: command.maxTotalCostUsd ?? null,
      admittedMaxTotalCostUsd: admission?.admittedMaxTotalCostUsd ?? null,
      startedAt: new Date().toISOString(),
    };
    await writeJsonV1(join(runRoot, "manifest.json"), manifest);

    const results: MatrixCaseResultV1[] = [];
    for (const testCase of selected) {
      results.push(
        await executeEvaluationCaseV1({
          testCase,
          execution: command.command,
          runRoot,
          configPath,
          configId: config.configId,
          io,
        }),
      );
    }

    const successful = results.filter(
      ({ complete, verdictMatched }) => complete && verdictMatched !== false,
    ).length;
    const summary = {
      schemaVersion: 1,
      runLabel,
      execution: command.command,
      selectedCaseCount: results.length,
      successfulCaseCount: successful,
      failedCaseCount: results.length - successful,
      callsStarted: results.reduce((sum, result) => sum + result.accounting.callsStarted, 0),
      callsSucceeded: results.reduce((sum, result) => sum + result.accounting.callsSucceeded, 0),
      callsFailed: results.reduce((sum, result) => sum + result.accounting.callsFailed, 0),
      reportedPromptTokens: results.reduce(
        (sum, result) => sum + result.accounting.reportedPromptTokens,
        0,
      ),
      reportedCompletionTokens: results.reduce(
        (sum, result) => sum + result.accounting.reportedCompletionTokens,
        0,
      ),
      reportedTotalTokens: results.reduce(
        (sum, result) => sum + result.accounting.reportedTotalTokens,
        0,
      ),
      reportedCostUsd: results.reduce((sum, result) => sum + result.accounting.reportedCostUsd, 0),
      unknownCostAttempts: results.reduce(
        (sum, result) => sum + result.accounting.unknownCostAttempts,
        0,
      ),
      conservativeRetryTokens: results.reduce(
        (sum, result) => sum + result.accounting.conservativeRetryTokens,
        0,
      ),
      conservativeRetryCostUsd: results.reduce(
        (sum, result) => sum + result.accounting.conservativeRetryCostUsd,
        0,
      ),
      completedAt: new Date().toISOString(),
      caseResults: results.map(
        ({ caseId, complete, verdictMatched, actualVerdict, expectedVerdict, error }) => ({
          caseId,
          complete,
          verdictMatched,
          actualVerdict,
          expectedVerdict,
          error,
        }),
      ),
    };
    await writeJsonV1(join(runRoot, "summary.json"), summary);
    io.stdout(
      `Matrix ${runLabel}: ${successful}/${results.length} successful; provider-reported cost $${summary.reportedCostUsd.toFixed(6)}; ${summary.unknownCostAttempts} attempt(s) with unknown cost.`,
    );
    return successful === results.length ? 0 : 1;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "Unknown evaluation matrix failure.");
    return 1;
  }
}

const executablePath = process.argv[1];
if (executablePath && import.meta.url === pathToFileURL(resolve(executablePath)).href) {
  process.exitCode = await runEvaluationMatrixV1(process.argv.slice(2));
}
