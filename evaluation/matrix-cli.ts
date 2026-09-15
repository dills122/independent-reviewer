import type { EvaluationSelectionV1 } from "./matrix-selection.js";

export interface EvaluationMatrixCommandV1 {
  command: "list" | "dry" | "live";
  selection: EvaluationSelectionV1;
  runLabel: string | undefined;
  configPath: string | undefined;
  confirmPaid: boolean;
  maxTotalCostUsd: number | undefined;
}

function optionValueV1(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

export function parseEvaluationMatrixCommandV1(args: readonly string[]): EvaluationMatrixCommandV1 {
  const command = args[0];
  if (command !== "list" && command !== "dry" && command !== "live") {
    throw new Error("Usage: evaluation matrix <list|dry|live> [options].");
  }

  let suite: string | undefined;
  const groups: string[] = [];
  const cases: string[] = [];
  let runLabel: string | undefined;
  let configPath: string | undefined;
  let confirmPaid = false;
  let maxTotalCostUsd: number | undefined;

  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    switch (option) {
      case "--suite":
        if (suite !== undefined) throw new Error("--suite may be supplied once.");
        suite = optionValueV1(args, index, option);
        index += 1;
        break;
      case "--group":
        groups.push(optionValueV1(args, index, option));
        index += 1;
        break;
      case "--case":
        cases.push(optionValueV1(args, index, option));
        index += 1;
        break;
      case "--run-label":
        runLabel = optionValueV1(args, index, option);
        index += 1;
        break;
      case "--config":
        configPath = optionValueV1(args, index, option);
        index += 1;
        break;
      case "--confirm-paid":
        confirmPaid = true;
        break;
      case "--max-total-cost-usd": {
        const raw = optionValueV1(args, index, option);
        maxTotalCostUsd = Number(raw);
        if (!Number.isFinite(maxTotalCostUsd) || maxTotalCostUsd <= 0) {
          throw new Error("--max-total-cost-usd must be a positive number.");
        }
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown evaluation matrix option: ${option ?? ""}.`);
    }
  }

  if (command !== "list") {
    if (runLabel === undefined) throw new Error("Execution requires --run-label.");
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(runLabel)) {
      throw new Error("--run-label must be a safe lowercase label without path separators.");
    }
  }
  if (command === "list" && (runLabel !== undefined || configPath !== undefined)) {
    throw new Error("list does not accept --run-label or --config.");
  }
  if (command !== "live" && (confirmPaid || maxTotalCostUsd !== undefined)) {
    throw new Error("--confirm-paid and --max-total-cost-usd are live only.");
  }

  const selection: EvaluationSelectionV1 = {};
  if (command !== "list") selection.execution = command;
  if (suite !== undefined) selection.suite = suite;
  if (groups.length > 0) selection.groups = groups;
  if (cases.length > 0) selection.cases = cases;

  return {
    command,
    selection,
    runLabel,
    configPath,
    confirmPaid,
    maxTotalCostUsd,
  };
}
