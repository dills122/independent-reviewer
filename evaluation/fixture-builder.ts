import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { jsonDocument } from "../src/contracts/json-document.js";
import { ReviewRequestV1Schema } from "../src/contracts/review-request.js";
import { ReviewAuthorSchema, StandardsProfileSchema } from "../src/contracts/standards-review.js";
import type {
  EvaluationCaseV1,
  EvaluationRepositoryFileV1,
  PreparedEvaluationCaseV1,
  RequirementsReviewerInputV1,
} from "./matrix-types.js";

const exec = promisify(execFile);
const FIXTURE_GIT_ENV = {
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_NAME: "Evaluation Fixture",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Evaluation Fixture",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
} as const;

export interface PreparedEvaluationReviewerInputV1 {
  role: "REQUIREMENTS" | "IMPLEMENTATION_PLAN" | "PROJECT_GUIDANCE" | "AUTHOR_PACKET";
  reference: string;
  content: string;
}

export interface PreparedEvaluationFixtureV1 extends PreparedEvaluationCaseV1 {
  reviewerInputArtifacts: readonly PreparedEvaluationReviewerInputV1[];
}

function assertRepositoryPath(path: string): void {
  const normalized = normalize(path);
  if (
    path.length === 0 ||
    path.includes("\0") ||
    isAbsolute(path) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error(`Invalid evaluation repository path: ${path}.`);
  }
}

async function materializeFile(
  repositoryPath: string,
  file: EvaluationRepositoryFileV1,
  content: string | undefined,
): Promise<void> {
  assertRepositoryPath(file.path);
  const destination = resolve(repositoryPath, file.path);
  if (relative(repositoryPath, destination).startsWith("..")) {
    throw new Error(`Evaluation repository path escapes fixture root: ${file.path}.`);
  }
  if (content === undefined) {
    await rm(destination, { force: true });
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
}

export async function runEvaluationFixtureGitV1(
  repositoryPath: string,
  ...arguments_: string[]
): Promise<string> {
  const { stdout } = await exec(
    "git",
    [
      "-c",
      `core.hooksPath=${devNull}`,
      "-c",
      "commit.gpgsign=false",
      "-C",
      repositoryPath,
      ...arguments_,
    ],
    {
      env: FIXTURE_GIT_ENV,
      encoding: "utf8",
    },
  );
  return stdout;
}

function assertOracleSeparated(testCase: EvaluationCaseV1): void {
  const reviewerData = JSON.stringify({
    repository: testCase.repository,
    reviewer: testCase.reviewer,
  });
  const oracleIds = [
    ...testCase.oracle.expectedRootIds,
    ...testCase.oracle.expectedUncertaintyIds,
    ...testCase.oracle.expectedRecommendationIds,
  ];
  for (const oracleId of oracleIds) {
    if (reviewerData.includes(oracleId)) {
      throw new Error(`Evaluator oracle identifier leaked into reviewer data for ${testCase.id}.`);
    }
  }
}

function requirementsRequest(
  testCase: EvaluationCaseV1,
  reviewer: RequirementsReviewerInputV1,
  repositoryPath: string,
  configId: string,
) {
  return ReviewRequestV1Schema.parse({
    schemaVersion: 1,
    flowId: `flow_evaluation_${testCase.id}`,
    reviewInstance: { number: 1, maximum: 3 },
    repository: {
      path: repositoryPath,
      base: "main",
      workingTree: { mode: "CUMULATIVE", includeUntracked: true },
    },
    canonicalInputs: {
      requirements: [
        {
          id: `input_${testCase.id}_requirements`,
          kind: "REQUIREMENTS",
          title: "Evaluation requirements",
          content: reviewer.requirements,
          provenance: { type: "INLINE", label: "Synthetic evaluation specification" },
        },
      ],
      implementationPlan: {
        id: `input_${testCase.id}_plan`,
        kind: "IMPLEMENTATION_PLAN",
        title: "Evaluation implementation plan",
        content: reviewer.implementationPlan,
        provenance: { type: "INLINE", label: "Synthetic evaluation specification" },
      },
      projectGuidance: [],
    },
    authorPacket: {
      schemaVersion: 1,
      intent: reviewer.authorIntent,
      successCriteria: [reviewer.requirements],
      planTraceability: [
        { planItem: reviewer.implementationPlan, implementation: reviewer.authorApproach },
      ],
      technicalApproach: reviewer.authorApproach,
      componentWalkthrough: reviewer.componentPaths.map((component) => ({
        component,
        changes: "Updated implementation for the declared plan.",
      })),
      decisions: [],
      invariants: ["Preserve all declared behavior unless the requirements say otherwise."],
      claimedVerification: [
        {
          command: "fixture verification not supplied",
          outcome: "NOT_RUN",
          summary: "No runner-observed verification accompanies this synthetic case.",
        },
      ],
      risks: [],
      knownGaps: [],
      challengePoints: [...reviewer.challengePoints],
    },
    reviewConfigRef: configId,
  });
}

export async function prepareEvaluationCorpusCaseV1(
  testCase: EvaluationCaseV1,
  caseRoot: string,
  configId = "config_evaluation_placeholder",
): Promise<PreparedEvaluationFixtureV1> {
  assertOracleSeparated(testCase);
  try {
    await mkdir(caseRoot, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Evaluation case directory already exists: ${caseRoot}.`);
    }
    throw error;
  }

  const repositoryPath = join(caseRoot, "repo");
  const outputPath = join(caseRoot, "packet");
  await mkdir(repositoryPath);

  const paths = testCase.repository.files.map(({ path }) => path);
  if (new Set(paths).size !== paths.length) {
    throw new Error(`Evaluation case ${testCase.id} contains duplicate repository paths.`);
  }
  if (!testCase.repository.files.some(({ base }) => base !== undefined)) {
    throw new Error(`Evaluation case ${testCase.id} must contain baseline content.`);
  }

  await runEvaluationFixtureGitV1(repositoryPath, "init", "--initial-branch=main");
  await runEvaluationFixtureGitV1(repositoryPath, "config", "user.name", "Evaluation Fixture");
  await runEvaluationFixtureGitV1(
    repositoryPath,
    "config",
    "user.email",
    "fixture@example.invalid",
  );
  await runEvaluationFixtureGitV1(repositoryPath, "config", "commit.gpgsign", "false");
  for (const file of testCase.repository.files) {
    await materializeFile(repositoryPath, file, file.base);
  }
  await runEvaluationFixtureGitV1(repositoryPath, "add", ".");
  await runEvaluationFixtureGitV1(repositoryPath, "commit", "-m", "Fixture baseline");
  for (const file of testCase.repository.files) {
    await materializeFile(repositoryPath, file, file.head);
  }

  let controlPath: string;
  let cliArguments: readonly string[];
  let reviewerInputArtifacts: readonly PreparedEvaluationReviewerInputV1[];
  if (testCase.reviewer.kind === "requirements") {
    controlPath = join(caseRoot, "control.json");
    const request = requirementsRequest(testCase, testCase.reviewer, repositoryPath, configId);
    await writeFile(controlPath, jsonDocument(request), { flag: "wx", mode: 0o600 });
    cliArguments = ["--request", controlPath];
    if (!request.authorPacket)
      throw new Error("Evaluation requirements request has no author packet.");
    reviewerInputArtifacts = [
      {
        role: "REQUIREMENTS",
        reference: "inputs/requirements",
        content: request.canonicalInputs.requirements[0]?.content ?? "",
      },
      {
        role: "IMPLEMENTATION_PLAN",
        reference: "inputs/implementation-plan",
        content: request.canonicalInputs.implementationPlan.content,
      },
      {
        role: "AUTHOR_PACKET",
        reference: "inputs/author-packet",
        content: jsonDocument(request.authorPacket),
      },
    ];
  } else {
    controlPath = join(caseRoot, "control.json");
    const authorPath = join(caseRoot, "author.md");
    const profile = StandardsProfileSchema.parse(testCase.reviewer.profile);
    const profileText = jsonDocument(profile);
    const authorText = `${testCase.reviewer.authorOverview.trim()}\n`;
    const authorPacket = ReviewAuthorSchema.parse({
      schemaVersion: 2,
      overview: authorText,
      claimedVerification: [],
    });
    await writeFile(controlPath, profileText, { flag: "wx", mode: 0o600 });
    await writeFile(authorPath, authorText, {
      flag: "wx",
      mode: 0o600,
    });
    cliArguments = [
      "--repo",
      repositoryPath,
      "--base",
      "main",
      "--standards",
      controlPath,
      "--author",
      authorPath,
      "--new-flow",
    ];
    reviewerInputArtifacts = [
      {
        role: "PROJECT_GUIDANCE",
        reference: "inputs/standards-profile",
        content: profileText,
      },
      {
        role: "AUTHOR_PACKET",
        reference: "inputs/author-overview",
        content: jsonDocument(authorPacket),
      },
    ];
  }

  return { repositoryPath, controlPath, outputPath, cliArguments, reviewerInputArtifacts };
}

export async function prepareEvaluationCaseV1(
  testCase: EvaluationCaseV1,
  caseRoot: string,
  configId = "config_evaluation_placeholder",
): Promise<PreparedEvaluationCaseV1> {
  return prepareEvaluationCorpusCaseV1(testCase, caseRoot, configId);
}
