export type EvaluationExecutionV1 = "dry" | "live";
export type EvaluationReviewModeV1 = "requirements" | "standards";
export type EvaluationVerdictV1 =
  | "READY"
  | "READY_WITH_FOLLOW_UPS"
  | "NOT_READY"
  | "UNABLE_TO_VERIFY";
export type EvaluationSuiteV1 = "smoke" | "standard" | "full";

export const EVALUATION_GROUPS_V1 = [
  "requirements",
  "standards",
  "multilingual",
  "cross-file",
  "adversarial",
] as const;
export type EvaluationGroupV1 = (typeof EVALUATION_GROUPS_V1)[number];

export interface EvaluationRepositoryFileV1 {
  path: string;
  base?: string;
  head?: string;
}

export interface RequirementsReviewerInputV1 {
  kind: "requirements";
  requirements: string;
  implementationPlan: string;
  authorIntent: string;
  authorApproach: string;
  componentPaths: readonly string[];
  challengePoints: readonly string[];
}

export interface StandardsReviewerInputV1 {
  kind: "standards";
  profile: Readonly<Record<string, unknown>>;
  authorOverview: string;
}

export interface EvaluationOracleV1 {
  expectedVerdict: EvaluationVerdictV1;
  expectedRootIds: readonly string[];
  expectedUncertaintyIds: readonly string[];
  expectedRecommendationIds: readonly string[];
  labelsExhaustive: boolean;
}

export interface EvaluationCaseV1 {
  id: `case_${number}`;
  title: string;
  family: string;
  reviewMode: EvaluationReviewModeV1;
  groups: readonly EvaluationGroupV1[];
  suites: readonly EvaluationSuiteV1[];
  repository: {
    files: readonly EvaluationRepositoryFileV1[];
  };
  reviewer: RequirementsReviewerInputV1 | StandardsReviewerInputV1;
  oracle: EvaluationOracleV1;
}

export interface PreparedEvaluationCaseV1 {
  repositoryPath: string;
  controlPath: string;
  outputPath: string;
  cliArguments: readonly string[];
}
