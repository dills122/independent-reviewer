import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { jsonDocument, sha256BytesDigestV1 } from "../src/contracts/json-document.js";
import { compareUtf16 } from "../src/contracts/primitives.js";
import {
  digestEvaluationArtifactV1,
  type EvaluationCaseManifestV1,
  EvaluationCaseManifestV1Schema,
  type EvaluationFamilySplitManifestV1,
  EvaluationFamilySplitManifestV1Schema,
  serializeEvaluationArtifactV1,
  validateEvaluationFamilySplitV1,
} from "./artifact-contracts.js";
import {
  EVALUATION_CORPUS_V1,
  type EvaluationCorpusCaseDefinitionV1,
  validateEvaluationCorpusDefinitionV1,
} from "./corpus.js";
import { prepareEvaluationCaseV1, runEvaluationFixtureGitV1 } from "./fixture-builder.js";
import { EVALUATION_CASES_V1 } from "./matrix-selection.js";
import type { EvaluationCaseV1, PreparedEvaluationCaseV1 } from "./matrix-types.js";

function digestText(content: string) {
  return sha256BytesDigestV1(Buffer.from(content, "utf8"));
}

function repositoryStateDigest(testCase: EvaluationCaseV1, side: "base" | "head") {
  const files = testCase.repository.files
    .flatMap((file) => {
      const content = file[side];
      return content === undefined ? [] : [{ path: file.path, content }];
    })
    .sort((left, right) => compareUtf16(left.path, right.path));
  return digestText(jsonDocument({ files }));
}

function reviewerInputInventory(testCase: EvaluationCaseV1) {
  const canonicalInputs =
    testCase.reviewer.kind === "requirements"
      ? [
          {
            role: "REQUIREMENTS" as const,
            reference: "inputs/requirements",
            digest: digestText(testCase.reviewer.requirements),
          },
          {
            role: "IMPLEMENTATION_PLAN" as const,
            reference: "inputs/implementation-plan",
            digest: digestText(testCase.reviewer.implementationPlan),
          },
          {
            role: "AUTHOR_PACKET" as const,
            reference: "inputs/author-packet",
            digest: digestText(jsonDocument(testCase.reviewer)),
          },
        ]
      : [
          {
            role: "PROJECT_GUIDANCE" as const,
            reference: "inputs/standards-profile",
            digest: digestText(jsonDocument(testCase.reviewer.profile)),
          },
          {
            role: "AUTHOR_PACKET" as const,
            reference: "inputs/author-overview",
            digest: digestText(testCase.reviewer.authorOverview),
          },
        ];
  const sourceInputs = testCase.repository.files.map((file) => ({
    role: (file.base === file.head ? "SUPPORTING_SOURCE" : "SOURCE_CHANGE") as
      | "SUPPORTING_SOURCE"
      | "SOURCE_CHANGE",
    reference: `source/${file.path}`,
    digest: digestText(
      jsonDocument({ path: file.path, base: file.base ?? null, head: file.head ?? null }),
    ),
  }));
  return [...canonicalInputs, ...sourceInputs];
}

async function writePrivateArtifact(
  evaluatorRoot: string,
  artifact: { reference: string; content: string },
): Promise<{ reference: string; digest: ReturnType<typeof digestText> }> {
  const content = `${artifact.content.trimEnd()}\n`;
  const path = join(evaluatorRoot, artifact.reference);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { flag: "wx", mode: 0o600 });
  return { reference: artifact.reference, digest: digestText(content) };
}

export interface ReconstructedEvaluationCorpusCaseV1 {
  prepared: PreparedEvaluationCaseV1;
  manifest: EvaluationCaseManifestV1;
  manifestPath: string;
  oracleDirectory: string;
}

export async function reconstructEvaluationCorpusCaseV1(
  testCase: EvaluationCaseV1,
  rawDefinition: EvaluationCorpusCaseDefinitionV1,
  caseRoot: string,
): Promise<ReconstructedEvaluationCorpusCaseV1> {
  const corpus = validateEvaluationCorpusDefinitionV1(EVALUATION_CORPUS_V1);
  const canonicalCase = EVALUATION_CASES_V1.find(({ id }) => id === testCase.id);
  if (!canonicalCase || jsonDocument(canonicalCase) !== jsonDocument(testCase)) {
    throw new Error(`Supplied case does not match catalog case ${testCase.id}.`);
  }
  const definition = corpus.cases.find(({ caseId }) => caseId === rawDefinition.caseId);
  if (
    !definition ||
    definition.caseId !== testCase.id ||
    jsonDocument(definition) !== jsonDocument(rawDefinition)
  ) {
    throw new Error(`Corpus definition does not match reconstructable case ${testCase.id}.`);
  }

  const prepared = await prepareEvaluationCaseV1(testCase, caseRoot);
  const baseCommit = await runEvaluationFixtureGitV1(prepared.repositoryPath, "rev-parse", "main");
  const evaluatorRoot = join(caseRoot, "evaluator");
  const oracleDirectory = join(evaluatorRoot, "oracles", "v1", testCase.id);
  const hiddenTest = await writePrivateArtifact(evaluatorRoot, definition.evaluatorOnly.hiddenTest);
  const fixingPatch =
    definition.evaluatorOnly.fixingPatch === null
      ? null
      : await writePrivateArtifact(evaluatorRoot, definition.evaluatorOnly.fixingPatch);

  const manifest = EvaluationCaseManifestV1Schema.parse({
    schemaVersion: 1,
    corpusVersion: corpus.corpusVersion,
    caseId: definition.caseId,
    familyId: definition.familyId,
    pair: definition.pair,
    controlRole: definition.controlRole,
    reviewMode: testCase.reviewMode === "requirements" ? "REQUIREMENTS" : "STANDARDS",
    source: {
      identityVersion: 1,
      kind: "CUMULATIVE_SNAPSHOT",
      repository: `synthetic://${testCase.id}`,
      baseCommit: baseCommit.trim(),
      baseTreeDigest: repositoryStateDigest(testCase, "base"),
      snapshotDigest: repositoryStateDigest(testCase, "head"),
      provenance: jsonDocument({
        ...definition.provenance,
        runtime: definition.runtime,
      }).trim(),
    },
    obligations: definition.obligations,
    reviewerInputInventory: reviewerInputInventory(testCase),
    oracleInventory: {
      expectedVerdict: testCase.oracle.expectedVerdict,
      expectedRoots: definition.expectedRoots,
      expectedUncertainties: definition.expectedUncertainties,
      expectedRecommendations: definition.expectedRecommendations,
      labelsExhaustive: definition.labelsExhaustive,
      artifacts: [
        { role: "HIDDEN_TEST", ...hiddenTest },
        ...(fixingPatch === null ? [] : [{ role: "GOLD_FIX" as const, ...fixingPatch }]),
      ],
    },
  });
  const manifestPath = join(evaluatorRoot, "case-manifest.json");
  await writeFile(
    manifestPath,
    serializeEvaluationArtifactV1(EvaluationCaseManifestV1Schema, manifest),
    { flag: "wx", mode: 0o600 },
  );
  return { prepared, manifest, manifestPath, oracleDirectory };
}

export interface ReconstructedEvaluationCorpusV1 {
  cases: readonly ReconstructedEvaluationCorpusCaseV1[];
  split: EvaluationFamilySplitManifestV1;
  splitPath: string;
}

export async function reconstructEvaluationCorpusV1(
  outputRoot: string,
): Promise<ReconstructedEvaluationCorpusV1> {
  await mkdir(outputRoot, { recursive: false });
  const corpus = validateEvaluationCorpusDefinitionV1(EVALUATION_CORPUS_V1);
  const caseById = new Map(EVALUATION_CASES_V1.map((testCase) => [testCase.id, testCase]));
  const cases: ReconstructedEvaluationCorpusCaseV1[] = [];
  for (const definition of corpus.cases) {
    const testCase = caseById.get(definition.caseId as EvaluationCaseV1["id"]);
    if (!testCase) throw new Error(`Missing reconstructable case ${definition.caseId}.`);
    cases.push(
      await reconstructEvaluationCorpusCaseV1(
        testCase,
        definition,
        join(outputRoot, definition.caseId),
      ),
    );
  }
  const manifestByCaseId = new Map(cases.map(({ manifest }) => [manifest.caseId, manifest]));

  const split = validateEvaluationFamilySplitV1(
    {
      schemaVersion: 1,
      corpusVersion: corpus.corpusVersion,
      splitVersion: corpus.splitVersion,
      assignments: corpus.cases.map((definition) => ({
        caseId: definition.caseId,
        caseManifestDigest: digestEvaluationArtifactV1(
          EvaluationCaseManifestV1Schema,
          manifestByCaseId.get(definition.caseId),
        ),
        familyId: definition.familyId,
        split: definition.split,
      })),
    },
    cases.map(({ manifest }) => manifest),
  );
  const splitPath = join(outputRoot, "evaluator", "family-split-manifest.json");
  await mkdir(dirname(splitPath), { recursive: true });
  await writeFile(
    splitPath,
    serializeEvaluationArtifactV1(EvaluationFamilySplitManifestV1Schema, split),
    { flag: "wx", mode: 0o600 },
  );
  return { cases, split, splitPath };
}
