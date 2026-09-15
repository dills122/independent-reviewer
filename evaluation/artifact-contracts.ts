import * as z from "zod";

import { cloneCanonicalJson } from "../src/contracts/canonical-json.js";
import { jsonDocument, sha256BytesDigestV1 } from "../src/contracts/json-document.js";
import {
  compareUtf16,
  NonEmptyTextSchema,
  prefixedIdentifier,
} from "../src/contracts/primitives.js";
import { type DigestV1, DigestV1Schema } from "../src/contracts/snapshot-manifest.js";

const EvaluationCaseIdV1Schema = prefixedIdentifier("case");
const EvaluationFamilyIdV1Schema = prefixedIdentifier("family");
const EvaluationPairIdV1Schema = prefixedIdentifier("pair");
const EvaluationExperimentIdV1Schema = prefixedIdentifier("experiment");
const EvaluationVariantIdV1Schema = prefixedIdentifier("variant");
const EvaluationAttemptIdV1Schema = prefixedIdentifier("attempt");
const EvaluationAdjudicationIdV1Schema = prefixedIdentifier("adjudication");
const EvaluationScoreIdV1Schema = prefixedIdentifier("score");
const GitObjectIdV1Schema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const SafeNonnegativeIntegerSchema = z.number().int().nonnegative().safe();
const PositiveSafeIntegerSchema = z.number().int().positive().safe();
const NonnegativeFiniteNumberSchema = z.number().finite().nonnegative();

function compareByFields<T extends Readonly<Record<string, unknown>>>(
  left: T,
  right: T,
  fields: readonly (keyof T)[],
): number {
  for (const field of fields) {
    const compared = compareUtf16(String(left[field]), String(right[field]));
    if (compared !== 0) return compared;
  }
  return 0;
}

function reportDuplicate(
  values: readonly string[],
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        message: `duplicate ${label} ${value}`,
        path: [...path, index],
      });
    }
    seen.add(value);
  }
}

const ReviewerInputInventoryEntryV1Schema = z.strictObject({
  role: z.enum([
    "REQUIREMENTS",
    "IMPLEMENTATION_PLAN",
    "PROJECT_GUIDANCE",
    "AUTHOR_PACKET",
    "SOURCE_CHANGE",
    "SUPPORTING_SOURCE",
    "TEST_EVIDENCE",
  ]),
  reference: NonEmptyTextSchema,
  digest: DigestV1Schema,
});

const OracleArtifactInventoryEntryV1Schema = z.strictObject({
  role: z.enum([
    "BUG_DESCRIPTION",
    "EXPECTED_VERDICT",
    "GOLD_FIX",
    "HIDDEN_TEST",
    "ISSUE_DISCUSSION",
  ]),
  reference: NonEmptyTextSchema,
  digest: DigestV1Schema,
});

const EvaluationSourceIdentityV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    identityVersion: z.literal(1),
    kind: z.literal("COMMIT_RANGE"),
    repository: NonEmptyTextSchema,
    baseCommit: GitObjectIdV1Schema,
    headCommit: GitObjectIdV1Schema,
    baseTreeDigest: DigestV1Schema,
    headTreeDigest: DigestV1Schema,
    provenance: NonEmptyTextSchema,
  }),
  z.strictObject({
    identityVersion: z.literal(1),
    kind: z.literal("CUMULATIVE_SNAPSHOT"),
    repository: NonEmptyTextSchema,
    baseCommit: GitObjectIdV1Schema,
    baseTreeDigest: DigestV1Schema,
    snapshotDigest: DigestV1Schema,
    provenance: NonEmptyTextSchema,
  }),
]);

const EvaluationCaseManifestBaseV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  corpusVersion: NonEmptyTextSchema,
  caseId: EvaluationCaseIdV1Schema,
  familyId: EvaluationFamilyIdV1Schema,
  pairId: EvaluationPairIdV1Schema.nullable(),
  reviewMode: z.enum(["REQUIREMENTS", "STANDARDS"]),
  source: EvaluationSourceIdentityV1Schema,
  obligations: z
    .array(
      z.strictObject({
        obligationId: prefixedIdentifier("obligation"),
        text: NonEmptyTextSchema,
      }),
    )
    .min(1),
  reviewerInputInventory: z.array(ReviewerInputInventoryEntryV1Schema).min(1),
  oracleInventory: z.strictObject({
    expectedVerdict: z.enum(["READY", "READY_WITH_FOLLOW_UPS", "NOT_READY", "UNABLE_TO_VERIFY"]),
    expectedRoots: z.array(
      z.strictObject({
        rootId: prefixedIdentifier("root"),
        obligationId: prefixedIdentifier("obligation"),
        description: NonEmptyTextSchema,
      }),
    ),
    expectedUncertainties: z.array(
      z.strictObject({
        uncertaintyId: prefixedIdentifier("uncertainty"),
        obligationId: prefixedIdentifier("obligation"),
        description: NonEmptyTextSchema,
      }),
    ),
    labelsExhaustive: z.boolean(),
    artifacts: z.array(OracleArtifactInventoryEntryV1Schema),
  }),
});

export const EvaluationCaseManifestV1Schema = EvaluationCaseManifestBaseV1Schema.superRefine(
  (manifest, context) => {
    reportDuplicate(
      manifest.obligations.map(({ obligationId }) => obligationId),
      context,
      ["obligations"],
      "obligation ID",
    );
    reportDuplicate(
      manifest.reviewerInputInventory.map(({ reference }) => reference),
      context,
      ["reviewerInputInventory"],
      "reviewer input reference",
    );
    reportDuplicate(
      manifest.oracleInventory.expectedRoots.map(({ rootId }) => rootId),
      context,
      ["oracleInventory", "expectedRoots"],
      "root ID",
    );
    reportDuplicate(
      manifest.oracleInventory.expectedUncertainties.map(({ uncertaintyId }) => uncertaintyId),
      context,
      ["oracleInventory", "expectedUncertainties"],
      "uncertainty ID",
    );
    const obligationIds = new Set(manifest.obligations.map(({ obligationId }) => obligationId));
    for (const [index, root] of manifest.oracleInventory.expectedRoots.entries()) {
      if (!obligationIds.has(root.obligationId)) {
        context.addIssue({
          code: "custom",
          message: `unknown obligation ID ${root.obligationId}`,
          path: ["oracleInventory", "expectedRoots", index, "obligationId"],
        });
      }
    }
    for (const [index, uncertainty] of manifest.oracleInventory.expectedUncertainties.entries()) {
      if (!obligationIds.has(uncertainty.obligationId)) {
        context.addIssue({
          code: "custom",
          message: `unknown obligation ID ${uncertainty.obligationId}`,
          path: ["oracleInventory", "expectedUncertainties", index, "obligationId"],
        });
      }
    }
    const reviewerReferences = new Set(
      manifest.reviewerInputInventory.map(({ reference }) => reference),
    );
    const reviewerDigests = new Set(
      manifest.reviewerInputInventory.map(({ digest }) => digest.value),
    );
    for (const [index, artifact] of manifest.oracleInventory.artifacts.entries()) {
      if (
        reviewerReferences.has(artifact.reference) ||
        reviewerDigests.has(artifact.digest.value)
      ) {
        context.addIssue({
          code: "custom",
          message: "oracle artifact must not also be a permitted reviewer input",
          path: ["oracleInventory", "artifacts", index],
        });
      }
    }
  },
).transform((manifest) => ({
  ...manifest,
  obligations: [...manifest.obligations].sort((left, right) =>
    compareUtf16(left.obligationId, right.obligationId),
  ),
  reviewerInputInventory: [...manifest.reviewerInputInventory].sort((left, right) =>
    compareByFields(left, right, ["role", "reference"]),
  ),
  oracleInventory: {
    ...manifest.oracleInventory,
    expectedRoots: [...manifest.oracleInventory.expectedRoots].sort((left, right) =>
      compareUtf16(left.rootId, right.rootId),
    ),
    expectedUncertainties: [...manifest.oracleInventory.expectedUncertainties].sort((left, right) =>
      compareUtf16(left.uncertaintyId, right.uncertaintyId),
    ),
    artifacts: [...manifest.oracleInventory.artifacts].sort((left, right) =>
      compareByFields(left, right, ["role", "reference"]),
    ),
  },
}));

const EvaluationSplitAssignmentV1Schema = z.strictObject({
  caseId: EvaluationCaseIdV1Schema,
  caseManifestDigest: DigestV1Schema,
  familyId: EvaluationFamilyIdV1Schema,
  split: z.enum(["DEVELOPMENT", "HOLDOUT"]),
});

export const EvaluationFamilySplitManifestV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    corpusVersion: NonEmptyTextSchema,
    splitVersion: NonEmptyTextSchema,
    assignments: z.array(EvaluationSplitAssignmentV1Schema).min(1),
  })
  .superRefine((manifest, context) => {
    reportDuplicate(
      manifest.assignments.map(({ caseId }) => caseId),
      context,
      ["assignments"],
      "case ID",
    );
    const splitByFamily = new Map<string, "DEVELOPMENT" | "HOLDOUT">();
    for (const [index, assignment] of manifest.assignments.entries()) {
      const previous = splitByFamily.get(assignment.familyId);
      if (previous !== undefined && previous !== assignment.split) {
        context.addIssue({
          code: "custom",
          message: `${assignment.familyId} cannot belong to both ${previous} and ${assignment.split}`,
          path: ["assignments", index, "split"],
        });
      }
      splitByFamily.set(assignment.familyId, assignment.split);
    }
  })
  .transform((manifest) => ({
    ...manifest,
    assignments: [...manifest.assignments].sort((left, right) =>
      compareUtf16(left.caseId, right.caseId),
    ),
  }));

export function validateEvaluationFamilySplitV1(
  value: unknown,
  caseValues: readonly unknown[],
): z.output<typeof EvaluationFamilySplitManifestV1Schema> {
  const split = EvaluationFamilySplitManifestV1Schema.parse(value);
  const cases = caseValues.map((caseValue) => EvaluationCaseManifestV1Schema.parse(caseValue));
  const caseById = new Map(cases.map((caseManifest) => [caseManifest.caseId, caseManifest]));
  const assignmentByCaseId = new Map(
    split.assignments.map((assignment) => [assignment.caseId, assignment]),
  );

  if (split.assignments.length !== cases.length) {
    throw new TypeError("family split must assign every case exactly once");
  }
  for (const assignment of split.assignments) {
    const caseManifest = caseById.get(assignment.caseId);
    if (!caseManifest)
      throw new TypeError(`family split contains unknown case ${assignment.caseId}`);
    if (caseManifest.corpusVersion !== split.corpusVersion) {
      throw new TypeError(`case ${assignment.caseId} has a different corpus identity`);
    }
    if (caseManifest.familyId !== assignment.familyId) {
      throw new TypeError(`case ${assignment.caseId} has a different family identity`);
    }
    const caseManifestDigest = digestEvaluationArtifactV1(
      EvaluationCaseManifestV1Schema,
      caseManifest,
    );
    if (caseManifestDigest.value !== assignment.caseManifestDigest.value) {
      throw new TypeError(`case ${assignment.caseId} has a different case manifest identity`);
    }
    caseById.delete(assignment.caseId);
  }
  if (caseById.size > 0) throw new TypeError("family split omits one or more cases");
  const splitByPair = new Map<string, "DEVELOPMENT" | "HOLDOUT">();
  for (const caseManifest of cases) {
    if (caseManifest.pairId === null) continue;
    const assignment = assignmentByCaseId.get(caseManifest.caseId);
    if (!assignment) throw new TypeError(`family split omits case ${caseManifest.caseId}`);
    const previous = splitByPair.get(caseManifest.pairId);
    if (previous !== undefined && previous !== assignment.split) {
      throw new TypeError(
        `${caseManifest.pairId} cannot belong to both ${previous} and ${assignment.split}`,
      );
    }
    splitByPair.set(caseManifest.pairId, assignment.split);
  }
  return split;
}

const EngineIdentityV1Schema = z.strictObject({
  commit: GitObjectIdV1Schema,
  sourceTreeDigest: DigestV1Schema,
  dirtyStateDigest: DigestV1Schema.nullable(),
});

export const EvaluationExperimentManifestV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    experimentId: EvaluationExperimentIdV1Schema,
    corpusVersion: NonEmptyTextSchema,
    splitManifestDigest: DigestV1Schema,
    scorerVersion: NonEmptyTextSchema,
    scorerPolicyDigest: DigestV1Schema,
    engine: EngineIdentityV1Schema,
    caseIds: z.array(EvaluationCaseIdV1Schema).min(1),
    variants: z
      .array(
        z.strictObject({
          variantId: EvaluationVariantIdV1Schema,
          modelId: NonEmptyTextSchema,
          providerPolicyDigest: DigestV1Schema,
          promptVersions: z.array(NonEmptyTextSchema).min(1),
          schemaVersions: z.array(NonEmptyTextSchema).min(1),
        }),
      )
      .min(1),
    environment: z.strictObject({
      nodeVersion: NonEmptyTextSchema,
      platform: NonEmptyTextSchema,
      architecture: NonEmptyTextSchema,
    }),
    repetitionCount: PositiveSafeIntegerSchema,
    seed: SafeNonnegativeIntegerSchema.nullable(),
    budgets: z.strictObject({
      maxTotalCostUsd: NonnegativeFiniteNumberSchema,
      maxElapsedMs: PositiveSafeIntegerSchema,
    }),
    stopRules: z.array(NonEmptyTextSchema).min(1),
  })
  .superRefine((manifest, context) => {
    reportDuplicate(manifest.caseIds, context, ["caseIds"], "case ID");
    reportDuplicate(
      manifest.variants.map(({ variantId }) => variantId),
      context,
      ["variants"],
      "variant ID",
    );
    for (const [index, variant] of manifest.variants.entries()) {
      reportDuplicate(
        variant.promptVersions,
        context,
        ["variants", index, "promptVersions"],
        "prompt version",
      );
      reportDuplicate(
        variant.schemaVersions,
        context,
        ["variants", index, "schemaVersions"],
        "schema version",
      );
    }
  })
  .transform((manifest) => ({
    ...manifest,
    caseIds: [...manifest.caseIds].sort(compareUtf16),
    variants: manifest.variants
      .map((variant) => ({
        ...variant,
        promptVersions: [...variant.promptVersions].sort(compareUtf16),
        schemaVersions: [...variant.schemaVersions].sort(compareUtf16),
      }))
      .sort((left, right) => compareUtf16(left.variantId, right.variantId)),
    stopRules: [...manifest.stopRules].sort(compareUtf16),
  }));

const EvaluationStageOutcomeV1Schema = z.strictObject({
  stage: z.enum(["PRELIMINARY", "FINDING_VERIFICATION", "FINAL"]),
  state: z.enum(["NOT_RUN", "SUCCEEDED", "FAILED"]),
  artifactDigest: DigestV1Schema.nullable(),
});

const EvaluationTerminalOutcomeV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("DELIVERED"),
    reportDigest: DigestV1Schema,
    verdict: z.enum(["READY", "READY_WITH_FOLLOW_UPS", "NOT_READY"]),
  }),
  z.strictObject({
    kind: z.literal("SEMANTIC_ABSTENTION"),
    reportDigest: DigestV1Schema,
    reason: NonEmptyTextSchema,
  }),
  z.strictObject({
    kind: z.literal("PROVIDER_FAILURE"),
    stage: z.enum(["PRELIMINARY", "FINDING_VERIFICATION", "FINAL"]),
    failureCode: NonEmptyTextSchema,
    transportUncertain: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("RUNNER_FAILURE"),
    stage: z.enum(["PREPARATION", "PRELIMINARY", "FINDING_VERIFICATION", "FINAL", "REPORT"]),
    failureCode: NonEmptyTextSchema,
  }),
  z.strictObject({ kind: z.literal("CANCELLED"), reason: NonEmptyTextSchema }),
]);

export const EvaluationAttemptRecordV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    attemptId: EvaluationAttemptIdV1Schema,
    experimentId: EvaluationExperimentIdV1Schema,
    caseId: EvaluationCaseIdV1Schema,
    familyId: EvaluationFamilyIdV1Schema,
    split: z.enum(["DEVELOPMENT", "HOLDOUT"]),
    variantId: EvaluationVariantIdV1Schema,
    repetition: PositiveSafeIntegerSchema,
    sourceIdentityDigest: DigestV1Schema,
    engineIdentityDigest: DigestV1Schema,
    runtimeRunReference: NonEmptyTextSchema.nullable(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    elapsedMs: SafeNonnegativeIntegerSchema,
    stageOutcomes: z.array(EvaluationStageOutcomeV1Schema),
    terminalOutcome: EvaluationTerminalOutcomeV1Schema,
    usage: z.strictObject({
      promptTokens: SafeNonnegativeIntegerSchema.nullable(),
      completionTokens: SafeNonnegativeIntegerSchema.nullable(),
      totalTokens: SafeNonnegativeIntegerSchema.nullable(),
      knownCostUsd: NonnegativeFiniteNumberSchema.nullable(),
      unknownCostReservationUsd: NonnegativeFiniteNumberSchema,
    }),
  })
  .superRefine((record, context) => {
    reportDuplicate(
      record.stageOutcomes.map(({ stage }) => stage),
      context,
      ["stageOutcomes"],
      "stage outcome",
    );
    if (Date.parse(record.completedAt) < Date.parse(record.startedAt)) {
      context.addIssue({
        code: "custom",
        message: "completedAt must not precede startedAt",
        path: ["completedAt"],
      });
    }
    if (
      (record.terminalOutcome.kind === "DELIVERED" ||
        record.terminalOutcome.kind === "SEMANTIC_ABSTENTION") &&
      record.runtimeRunReference === null
    ) {
      context.addIssue({
        code: "custom",
        message: `${record.terminalOutcome.kind} requires a runtime run reference`,
        path: ["runtimeRunReference"],
      });
    }
    if (record.terminalOutcome.kind === "PROVIDER_FAILURE") {
      const failureStage = record.terminalOutcome.stage;
      const failedStage = record.stageOutcomes.some(
        ({ stage, state }) => stage === failureStage && state === "FAILED",
      );
      if (!failedStage) {
        context.addIssue({
          code: "custom",
          message: "provider failure requires a matching failed stage outcome",
          path: ["stageOutcomes"],
        });
      }
    }
  })
  .transform((record) => ({
    ...record,
    stageOutcomes: [...record.stageOutcomes].sort((left, right) =>
      compareUtf16(left.stage, right.stage),
    ),
  }));

const AdjudicationLabelV1Schema = z.enum([
  "MATCHED_DEFECT",
  "NOVEL_VALID_DEFECT",
  "INVALID_DEFECT",
  "UNRESOLVED",
  "RECOMMENDATION",
  "DUPLICATE",
]);

export const EvaluationAdjudicationRecordV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    adjudicationId: EvaluationAdjudicationIdV1Schema,
    attemptId: EvaluationAttemptIdV1Schema,
    findingReference: NonEmptyTextSchema,
    claimDigest: DigestV1Schema,
    label: AdjudicationLabelV1Schema,
    matchedRootId: prefixedIdentifier("root").nullable(),
    causalEvidence: z.array(
      z.strictObject({ reference: NonEmptyTextSchema, digest: DigestV1Schema }),
    ),
    adjudicator: z.strictObject({
      type: z.enum(["HUMAN", "MODEL_ASSISTED"]),
      identity: NonEmptyTextSchema,
    }),
    rationale: NonEmptyTextSchema,
    unresolvedDisagreement: NonEmptyTextSchema.nullable(),
    adjudicatedAt: z.iso.datetime(),
  })
  .superRefine((record, context) => {
    const requiresRoot = record.label === "MATCHED_DEFECT" || record.label === "DUPLICATE";
    if (requiresRoot && record.matchedRootId === null) {
      context.addIssue({
        code: "custom",
        message: `${record.label} requires matched root ID`,
        path: ["matchedRootId"],
      });
    }
    if (!requiresRoot && record.matchedRootId !== null) {
      context.addIssue({
        code: "custom",
        message: `${record.label} cannot claim a matched root ID`,
        path: ["matchedRootId"],
      });
    }
    if (record.label === "UNRESOLVED" && record.unresolvedDisagreement === null) {
      context.addIssue({
        code: "custom",
        message: "UNRESOLVED adjudication requires unresolved disagreement",
        path: ["unresolvedDisagreement"],
      });
    }
    if (record.label !== "UNRESOLVED" && record.unresolvedDisagreement !== null) {
      context.addIssue({
        code: "custom",
        message: "resolved adjudication cannot retain unresolved disagreement",
        path: ["unresolvedDisagreement"],
      });
    }
  })
  .transform((record) => ({
    ...record,
    causalEvidence: [...record.causalEvidence].sort((left, right) =>
      compareUtf16(left.reference, right.reference),
    ),
  }));

const EvaluationMetricNameV1Schema = z.enum([
  "KNOWN_DEFECT_RECALL_COMPLETED",
  "KNOWN_DEFECT_RECALL_ALL_STARTS",
  "ADJUDICATED_DEFECT_PRECISION",
  "CONSERVATIVE_PRECISION_BOUND",
  "UNIQUE_ACTION_YIELD",
  "CLEAN_FALSE_POSITIVE_RATE",
  "FALSE_ABSTENTION_RATE",
  "CORRECT_UNCERTAINTY_RATE",
  "DUPLICATE_RATE",
  "DELIVERY_RATE",
  "STAGE_RETENTION_RATE",
]);

const EvaluationMetricV1Schema = z
  .strictObject({
    metric: EvaluationMetricNameV1Schema,
    numerator: SafeNonnegativeIntegerSchema,
    denominator: SafeNonnegativeIntegerSchema,
    value: z.number().finite().min(0).max(1).nullable(),
  })
  .superRefine((metric, context) => {
    if (metric.numerator > metric.denominator) {
      context.addIssue({
        code: "custom",
        message: "metric numerator cannot exceed denominator",
        path: ["numerator"],
      });
    }
    if (metric.denominator === 0 && metric.value !== null) {
      context.addIssue({
        code: "custom",
        message: "zero denominator must remain unavailable",
        path: ["value"],
      });
    }
    if (metric.denominator > 0) {
      const expected = metric.numerator / metric.denominator;
      if (metric.value === null || Math.abs(metric.value - expected) > Number.EPSILON * 4) {
        context.addIssue({
          code: "custom",
          message: "metric value must equal numerator divided by denominator",
          path: ["value"],
        });
      }
    }
  });

const ScoreBreakdownV1Schema = z.strictObject({
  identity: NonEmptyTextSchema,
  metrics: z.array(EvaluationMetricV1Schema),
});

export const EvaluationScoreReportV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    scoreId: EvaluationScoreIdV1Schema,
    experimentId: EvaluationExperimentIdV1Schema,
    scorerVersion: NonEmptyTextSchema,
    scorerPolicyDigest: DigestV1Schema,
    generatedAt: z.iso.datetime(),
    metrics: z.array(EvaluationMetricV1Schema),
    adjudicationCoverage: z.strictObject({
      totalClaims: SafeNonnegativeIntegerSchema,
      resolvedClaims: SafeNonnegativeIntegerSchema,
      unresolvedClaims: SafeNonnegativeIntegerSchema,
      unresolvedAdjudicationIds: z.array(EvaluationAdjudicationIdV1Schema),
    }),
    missingness: z.strictObject({
      startedAttempts: SafeNonnegativeIntegerSchema,
      deliveredReports: SafeNonnegativeIntegerSchema,
      missingReports: SafeNonnegativeIntegerSchema,
    }),
    caseBreakdowns: z.array(ScoreBreakdownV1Schema),
    familyBreakdowns: z.array(ScoreBreakdownV1Schema),
    pairedDeltas: z.array(
      z.strictObject({
        pairId: EvaluationPairIdV1Schema,
        metric: EvaluationMetricNameV1Schema,
        baselineValue: z.number().finite().min(0).max(1).nullable(),
        candidateValue: z.number().finite().min(0).max(1).nullable(),
        delta: z.number().finite().min(-1).max(1).nullable(),
      }),
    ),
    rawArtifactDigests: z.array(DigestV1Schema),
  })
  .superRefine((report, context) => {
    reportDuplicate(
      report.metrics.map(({ metric }) => metric),
      context,
      ["metrics"],
      "metric",
    );
    const coverage = report.adjudicationCoverage;
    if (coverage.resolvedClaims + coverage.unresolvedClaims !== coverage.totalClaims) {
      context.addIssue({
        code: "custom",
        message: "resolved and unresolved claim counts must equal total claims",
        path: ["adjudicationCoverage"],
      });
    }
    if (coverage.unresolvedClaims !== coverage.unresolvedAdjudicationIds.length) {
      context.addIssue({
        code: "custom",
        message: "unresolved claim count must match unresolved adjudication IDs",
        path: ["adjudicationCoverage", "unresolvedAdjudicationIds"],
      });
    }
    reportDuplicate(
      coverage.unresolvedAdjudicationIds,
      context,
      ["adjudicationCoverage", "unresolvedAdjudicationIds"],
      "unresolved adjudication ID",
    );
    if (
      report.missingness.deliveredReports + report.missingness.missingReports !==
      report.missingness.startedAttempts
    ) {
      context.addIssue({
        code: "custom",
        message: "delivered and missing report counts must equal started attempts",
        path: ["missingness"],
      });
    }
    for (const [index, delta] of report.pairedDeltas.entries()) {
      const unavailable = delta.baselineValue === null || delta.candidateValue === null;
      if (unavailable && delta.delta !== null) {
        context.addIssue({
          code: "custom",
          message: "paired delta must be unavailable when either value is unavailable",
          path: ["pairedDeltas", index, "delta"],
        });
      } else if (!unavailable) {
        const expected = (delta.candidateValue as number) - (delta.baselineValue as number);
        if (delta.delta === null || Math.abs(delta.delta - expected) > Number.EPSILON * 4) {
          context.addIssue({
            code: "custom",
            message: "paired delta must equal candidate minus baseline",
            path: ["pairedDeltas", index, "delta"],
          });
        }
      }
    }
  })
  .transform((report) => ({
    ...report,
    metrics: [...report.metrics].sort((left, right) => compareUtf16(left.metric, right.metric)),
    adjudicationCoverage: {
      ...report.adjudicationCoverage,
      unresolvedAdjudicationIds: [...report.adjudicationCoverage.unresolvedAdjudicationIds].sort(
        compareUtf16,
      ),
    },
    caseBreakdowns: [...report.caseBreakdowns].sort((left, right) =>
      compareUtf16(left.identity, right.identity),
    ),
    familyBreakdowns: [...report.familyBreakdowns].sort((left, right) =>
      compareUtf16(left.identity, right.identity),
    ),
    pairedDeltas: [...report.pairedDeltas].sort((left, right) =>
      compareByFields(left, right, ["pairId", "metric"]),
    ),
    rawArtifactDigests: [...report.rawArtifactDigests].sort((left, right) =>
      compareUtf16(left.value, right.value),
    ),
  }));

export type EvaluationCaseManifestV1 = z.output<typeof EvaluationCaseManifestV1Schema>;
export type EvaluationFamilySplitManifestV1 = z.output<
  typeof EvaluationFamilySplitManifestV1Schema
>;
export type EvaluationExperimentManifestV1 = z.output<typeof EvaluationExperimentManifestV1Schema>;
export type EvaluationAttemptRecordV1 = z.output<typeof EvaluationAttemptRecordV1Schema>;
export type EvaluationAdjudicationRecordV1 = z.output<typeof EvaluationAdjudicationRecordV1Schema>;
export type EvaluationScoreReportV1 = z.output<typeof EvaluationScoreReportV1Schema>;

export function serializeEvaluationArtifactV1<Output>(
  schema: z.ZodType<Output>,
  value: unknown,
): string {
  return jsonDocument(schema.parse(cloneCanonicalJson(value)));
}

export function digestEvaluationArtifactV1<Output>(
  schema: z.ZodType<Output>,
  value: unknown,
): DigestV1 {
  return sha256BytesDigestV1(Buffer.from(serializeEvaluationArtifactV1(schema, value), "utf8"));
}
