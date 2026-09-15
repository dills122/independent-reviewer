import { EVALUATION_CASES_V1 as CASE_CATALOG_V1 } from "./case-catalog.js";
import {
  EVALUATION_GROUPS_V1,
  type EvaluationCaseV1,
  type EvaluationExecutionV1,
  type EvaluationSuiteV1,
} from "./matrix-types.js";

export const EVALUATION_CASES_V1: readonly EvaluationCaseV1[] = CASE_CATALOG_V1;

export interface EvaluationSelectionV1 {
  execution?: EvaluationExecutionV1;
  suite?: string;
  groups?: readonly string[];
  cases?: readonly string[];
}

function assertUniqueSelectorsV1(kind: "group" | "case", values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Duplicate ${kind} selector.`);
  }
}

function selectedBySuiteV1(suite: string): readonly EvaluationCaseV1[] {
  if (suite !== "smoke" && suite !== "standard" && suite !== "full") {
    throw new Error(`Unknown suite: ${suite}.`);
  }
  return EVALUATION_CASES_V1.filter(({ suites }) => suites.includes(suite));
}

export function selectEvaluationCasesV1(
  selection: EvaluationSelectionV1,
): readonly EvaluationCaseV1[] {
  const hasSuite = selection.suite !== undefined;
  const hasGroups = selection.groups !== undefined;
  const hasCases = selection.cases !== undefined;
  if ([hasSuite, hasGroups, hasCases].filter(Boolean).length > 1) {
    throw new Error("Choose only one selector kind: suite, group, or case.");
  }

  let selected: readonly EvaluationCaseV1[];
  if (hasSuite) {
    selected = selectedBySuiteV1(selection.suite ?? "");
  } else if (hasGroups) {
    const groups = selection.groups ?? [];
    if (groups.length === 0) throw new Error("Evaluation selection is empty.");
    assertUniqueSelectorsV1("group", groups);
    for (const group of groups) {
      if (!(EVALUATION_GROUPS_V1 as readonly string[]).includes(group)) {
        throw new Error(`Unknown group: ${group}.`);
      }
    }
    const selectedGroups = new Set(groups);
    selected = EVALUATION_CASES_V1.filter(({ groups: caseGroups }) =>
      caseGroups.some((group) => selectedGroups.has(group)),
    );
  } else if (hasCases) {
    const cases = selection.cases ?? [];
    if (cases.length === 0) throw new Error("Evaluation selection is empty.");
    assertUniqueSelectorsV1("case", cases);
    const selectedIds = new Set(cases);
    for (const id of cases) {
      if (!EVALUATION_CASES_V1.some((testCase) => testCase.id === id)) {
        throw new Error(`Unknown case: ${id}.`);
      }
    }
    selected = EVALUATION_CASES_V1.filter(({ id }) => selectedIds.has(id));
  } else if (selection.execution === "live") {
    throw new Error("Live runs require an explicit suite, group, or case selector.");
  } else {
    selected = selectedBySuiteV1("standard");
  }

  if (selected.length === 0) throw new Error("Evaluation selection is empty.");
  return selected;
}

export interface PaidMatrixAdmissionInputV1 {
  selected: readonly EvaluationCaseV1[];
  perCaseMaxCostUsd: number;
  confirmed: boolean;
  operatorMaxTotalCostUsd: number | undefined;
}

export interface PaidMatrixAdmissionV1 {
  selectedCaseCount: number;
  admittedMaxTotalCostUsd: number;
}

export function validatePaidMatrixAdmissionV1(
  input: PaidMatrixAdmissionInputV1,
): PaidMatrixAdmissionV1 {
  if (!input.confirmed) throw new Error("Live evaluation requires --confirm-paid.");
  if (
    input.operatorMaxTotalCostUsd === undefined ||
    !Number.isFinite(input.operatorMaxTotalCostUsd) ||
    input.operatorMaxTotalCostUsd <= 0
  ) {
    throw new Error("Live evaluation requires a positive --max-total-cost-usd.");
  }
  if (!Number.isFinite(input.perCaseMaxCostUsd) || input.perCaseMaxCostUsd <= 0) {
    throw new Error("Per-case review cost ceiling must be positive.");
  }

  const admittedMaxTotalCostUsd = input.selected.length * input.perCaseMaxCostUsd;
  if (!Number.isFinite(admittedMaxTotalCostUsd)) {
    throw new Error("Admitted matrix cost ceiling must be finite.");
  }
  if (input.operatorMaxTotalCostUsd + Number.EPSILON < admittedMaxTotalCostUsd) {
    throw new Error(
      `Operator ceiling $${input.operatorMaxTotalCostUsd.toFixed(9)} is below admitted matrix ceiling $${admittedMaxTotalCostUsd.toFixed(9)}.`,
    );
  }
  return { selectedCaseCount: input.selected.length, admittedMaxTotalCostUsd };
}

export function isEvaluationSuiteV1(value: string): value is EvaluationSuiteV1 {
  return value === "smoke" || value === "standard" || value === "full";
}
