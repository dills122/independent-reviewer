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
const EvaluationComparisonIdV1Schema = prefixedIdentifier("comparison");
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

export const EvaluationSourceIdentityV1Schema = z.discriminatedUnion("kind", [
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
  pair: z
    .strictObject({
      pairId: EvaluationPairIdV1Schema,
      role: z.enum(["DEFECT", "CLEAN"]),
    })
    .nullable(),
  controlRole: z
    .enum([
      "MISSING_REQUIRED_CONTEXT",
      "IRRELEVANT_MISSING_CONTEXT",
      "MISLEADING_AUTHOR_CONCERN",
      "UNSUPPORTED_AUTHOR_DEFENSE",
      "CONFLICTING_APPLICABLE_STANDARDS",
      "POST_AUTHOR_CLAIM_CHANGE",
    ])
    .nullable(),
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
        sourceOracleId: prefixedIdentifier("root"),
        obligationId: prefixedIdentifier("obligation"),
        description: NonEmptyTextSchema,
      }),
    ),
    expectedRecommendations: z.array(
      z.strictObject({
        recommendationId: z.string().regex(/^recommendation_[A-Za-z0-9][A-Za-z0-9_-]*$/),
        sourceOracleId: prefixedIdentifier("root"),
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
    if ((manifest.pair === null) === (manifest.controlRole === null)) {
      context.addIssue({
        code: "custom",
        message: "case manifest must declare exactly one pair or control role",
        path: ["controlRole"],
      });
    }
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
    reportDuplicate(
      manifest.oracleInventory.expectedRecommendations.map(
        ({ recommendationId }) => recommendationId,
      ),
      context,
      ["oracleInventory", "expectedRecommendations"],
      "recommendation ID",
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
    for (const [
      index,
      recommendation,
    ] of manifest.oracleInventory.expectedRecommendations.entries()) {
      if (!obligationIds.has(recommendation.obligationId)) {
        context.addIssue({
          code: "custom",
          message: `unknown obligation ID ${recommendation.obligationId}`,
          path: ["oracleInventory", "expectedRecommendations", index, "obligationId"],
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
    expectedRecommendations: [...manifest.oracleInventory.expectedRecommendations].sort(
      (left, right) => compareUtf16(left.recommendationId, right.recommendationId),
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
  const pairMembers = new Map<
    string,
    { splits: Set<"DEVELOPMENT" | "HOLDOUT">; roles: ("DEFECT" | "CLEAN")[] }
  >();
  for (const caseManifest of cases) {
    if (caseManifest.pair === null) continue;
    const assignment = assignmentByCaseId.get(caseManifest.caseId);
    if (!assignment) throw new TypeError(`family split omits case ${caseManifest.caseId}`);
    const pair = pairMembers.get(caseManifest.pair.pairId) ?? { splits: new Set(), roles: [] };
    pair.splits.add(assignment.split);
    pair.roles.push(caseManifest.pair.role);
    pairMembers.set(caseManifest.pair.pairId, pair);
  }
  for (const [pairId, pair] of pairMembers) {
    if (pair.splits.size !== 1) throw new TypeError(`${pairId} cannot belong to both splits`);
    if (pair.roles.length !== 2) {
      throw new TypeError(`${pairId} must contain exactly two cases`);
    }
    if (
      pair.roles.filter((role) => role === "DEFECT").length !== 1 ||
      pair.roles.filter((role) => role === "CLEAN").length !== 1
    ) {
      throw new TypeError(`${pairId} must contain one DEFECT and one CLEAN case`);
    }
  }
  return split;
}

export const EvaluationEngineIdentityV1Schema = z.strictObject({
  commit: GitObjectIdV1Schema,
  sourceTreeDigest: DigestV1Schema,
  dirtyStateDigest: DigestV1Schema.nullable(),
});

export const EvaluationMetricNameV1Schema = z.enum([
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

export const EvaluationExperimentManifestV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    experimentId: EvaluationExperimentIdV1Schema,
    corpusVersion: NonEmptyTextSchema,
    splitManifestDigest: DigestV1Schema,
    scorerVersion: NonEmptyTextSchema,
    scorerPolicyDigest: DigestV1Schema,
    engine: EvaluationEngineIdentityV1Schema,
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
    metricSet: z.array(EvaluationMetricNameV1Schema).min(1),
    comparisons: z
      .array(
        z.strictObject({
          comparisonId: EvaluationComparisonIdV1Schema,
          baselineVariantId: EvaluationVariantIdV1Schema,
          candidateVariantId: EvaluationVariantIdV1Schema,
          pairIds: z.array(EvaluationPairIdV1Schema).min(1),
          metrics: z.array(EvaluationMetricNameV1Schema).min(1),
        }),
      )
      .min(1),
  })
  .superRefine((manifest, context) => {
    reportDuplicate(manifest.caseIds, context, ["caseIds"], "case ID");
    reportDuplicate(
      manifest.variants.map(({ variantId }) => variantId),
      context,
      ["variants"],
      "variant ID",
    );
    reportDuplicate(manifest.metricSet, context, ["metricSet"], "metric");
    reportDuplicate(
      manifest.comparisons.map(({ comparisonId }) => comparisonId),
      context,
      ["comparisons"],
      "comparison ID",
    );
    const variantIds = new Set(manifest.variants.map(({ variantId }) => variantId));
    const declaredMetrics = new Set(manifest.metricSet);
    for (const [index, comparison] of manifest.comparisons.entries()) {
      if (comparison.baselineVariantId === comparison.candidateVariantId) {
        context.addIssue({
          code: "custom",
          message: "comparison variants must differ",
          path: ["comparisons", index],
        });
      }
      if (
        !variantIds.has(comparison.baselineVariantId) ||
        !variantIds.has(comparison.candidateVariantId)
      ) {
        context.addIssue({
          code: "custom",
          message: "comparison contains undeclared variant",
          path: ["comparisons", index],
        });
      }
      reportDuplicate(comparison.pairIds, context, ["comparisons", index, "pairIds"], "pair ID");
      reportDuplicate(comparison.metrics, context, ["comparisons", index, "metrics"], "metric");
      if (comparison.metrics.some((metric) => !declaredMetrics.has(metric))) {
        context.addIssue({
          code: "custom",
          message: "comparison contains undeclared metric",
          path: ["comparisons", index, "metrics"],
        });
      }
    }
    if (manifest.metricSet.length !== EvaluationMetricNameV1Schema.options.length) {
      context.addIssue({
        code: "custom",
        message: "experiment must freeze every protocol metric",
        path: ["metricSet"],
      });
    }
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
    metricSet: [...manifest.metricSet].sort(compareUtf16),
    comparisons: manifest.comparisons
      .map((comparison) => ({
        ...comparison,
        pairIds: [...comparison.pairIds].sort(compareUtf16),
        metrics: [...comparison.metrics].sort(compareUtf16),
      }))
      .sort((left, right) => compareUtf16(left.comparisonId, right.comparisonId)),
  }));

const EvaluationStageNameV1Schema = z.enum(["PRELIMINARY", "FINDING_VERIFICATION", "FINAL"]);
const STAGE_ORDER = ["PRELIMINARY", "FINDING_VERIFICATION", "FINAL"] as const;

const EvaluationStageOutcomeV1Schema = z
  .strictObject({
    stage: z.enum(["PRELIMINARY", "FINDING_VERIFICATION", "FINAL"]),
    state: z.enum(["SUCCEEDED", "FAILED"]),
    artifactDigest: DigestV1Schema.nullable(),
    elapsedMs: SafeNonnegativeIntegerSchema,
    providerCall: z.boolean(),
  })
  .superRefine((outcome, context) => {
    if (outcome.state === "SUCCEEDED" && outcome.artifactDigest === null) {
      context.addIssue({
        code: "custom",
        message: "succeeded stage requires artifact digest",
        path: ["artifactDigest"],
      });
    }
    if (outcome.state === "FAILED" && outcome.artifactDigest !== null) {
      context.addIssue({
        code: "custom",
        message: "failed stage cannot have artifact digest",
        path: ["artifactDigest"],
      });
    }
  });

const EvaluationTerminalOutcomeV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("DELIVERED"),
    reportReference: NonEmptyTextSchema,
    reportDigest: DigestV1Schema,
    verdict: z.enum(["READY", "READY_WITH_FOLLOW_UPS", "NOT_READY"]),
  }),
  z.strictObject({
    kind: z.literal("SEMANTIC_ABSTENTION"),
    reportReference: NonEmptyTextSchema,
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
    experimentManifestDigest: DigestV1Schema,
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
    findingClaims: z.array(
      z.strictObject({
        findingReference: NonEmptyTextSchema,
        claimDigest: DigestV1Schema,
        emittedAtStage: EvaluationStageNameV1Schema,
        claimKind: z.enum(["DEFECT", "UNCERTAINTY", "RECOMMENDATION"]),
      }),
    ),
    terminalOutcome: EvaluationTerminalOutcomeV1Schema,
    usage: z.strictObject({
      promptTokens: SafeNonnegativeIntegerSchema.nullable(),
      completionTokens: SafeNonnegativeIntegerSchema.nullable(),
      totalTokens: SafeNonnegativeIntegerSchema.nullable(),
      knownCostUsd: NonnegativeFiniteNumberSchema.nullable(),
      providerAttempts: SafeNonnegativeIntegerSchema,
      knownCostAttempts: SafeNonnegativeIntegerSchema,
      unknownCostAttempts: SafeNonnegativeIntegerSchema,
      conservativeChargeUsd: NonnegativeFiniteNumberSchema,
      admittedCeilingUsd: NonnegativeFiniteNumberSchema,
      evidenceBytes: SafeNonnegativeIntegerSchema,
      outputBytes: SafeNonnegativeIntegerSchema,
    }),
  })
  .superRefine((record, context) => {
    reportDuplicate(
      record.stageOutcomes.map(({ stage }) => stage),
      context,
      ["stageOutcomes"],
      "stage outcome",
    );
    reportDuplicate(
      record.findingClaims.map(({ findingReference }) => findingReference),
      context,
      ["findingClaims"],
      "finding reference",
    );
    const measuredElapsedMs = Date.parse(record.completedAt) - Date.parse(record.startedAt);
    if (measuredElapsedMs < 0) {
      context.addIssue({
        code: "custom",
        message: "completedAt must not precede startedAt",
        path: ["completedAt"],
      });
    } else if (measuredElapsedMs !== record.elapsedMs) {
      context.addIssue({
        code: "custom",
        message: "elapsedMs must equal timestamp difference",
        path: ["elapsedMs"],
      });
    }
    const stages = record.stageOutcomes.map(({ stage }) => stage);
    if (stages.some((stage, index) => stage !== STAGE_ORDER[index])) {
      context.addIssue({
        code: "custom",
        message: "stage outcomes must be an ordered execution prefix",
        path: ["stageOutcomes"],
      });
    }
    const failedIndex = record.stageOutcomes.findIndex(({ state }) => state === "FAILED");
    if (failedIndex >= 0 && failedIndex !== record.stageOutcomes.length - 1) {
      context.addIssue({
        code: "custom",
        message: "no stage may run after a failed stage",
        path: ["stageOutcomes"],
      });
    }
    const succeededStages = new Set(
      record.stageOutcomes.filter(({ state }) => state === "SUCCEEDED").map(({ stage }) => stage),
    );
    for (const [index, claim] of record.findingClaims.entries()) {
      if (!succeededStages.has(claim.emittedAtStage)) {
        context.addIssue({
          code: "custom",
          message: "finding claim requires its stage to succeed",
          path: ["findingClaims", index, "emittedAtStage"],
        });
      }
    }
    for (const [index, outcome] of record.stageOutcomes.entries()) {
      if ((outcome.stage === "PRELIMINARY" || outcome.stage === "FINAL") && !outcome.providerCall) {
        context.addIssue({
          code: "custom",
          message: `${outcome.stage.toLowerCase()} stage must be provider-backed`,
          path: ["stageOutcomes", index, "providerCall"],
        });
      }
      if (outcome.stage === "FINDING_VERIFICATION") {
        const hasPreliminaryAdverseClaim = record.findingClaims.some(
          ({ emittedAtStage }) => emittedAtStage === "PRELIMINARY",
        );
        if (outcome.providerCall !== hasPreliminaryAdverseClaim) {
          context.addIssue({
            code: "custom",
            message: hasPreliminaryAdverseClaim
              ? "finding verification must be provider-backed when preliminary adverse claims exist"
              : "finding verification must be local when no preliminary adverse claims exist",
            path: ["stageOutcomes", index, "providerCall"],
          });
        }
      }
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
    if (
      record.terminalOutcome.kind === "DELIVERED" ||
      record.terminalOutcome.kind === "SEMANTIC_ABSTENTION"
    ) {
      const finalStage = record.stageOutcomes[2];
      if (record.stageOutcomes.length !== 3 || finalStage?.state !== "SUCCEEDED") {
        context.addIssue({
          code: "custom",
          message: `${record.terminalOutcome.kind} requires every stage to succeed`,
          path: ["stageOutcomes"],
        });
      } else if (finalStage.artifactDigest?.value !== record.terminalOutcome.reportDigest.value) {
        context.addIssue({
          code: "custom",
          message: "final stage artifact digest must equal terminal report digest",
          path: ["terminalOutcome", "reportDigest"],
        });
      }
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
      const failedOutcome = record.stageOutcomes.find(({ stage }) => stage === failureStage);
      if (failedOutcome?.providerCall !== true) {
        context.addIssue({
          code: "custom",
          message: "provider failure stage must represent a provider call",
          path: ["stageOutcomes"],
        });
      }
    }
    if (record.terminalOutcome.kind === "RUNNER_FAILURE") {
      const failed = record.stageOutcomes.find(({ state }) => state === "FAILED");
      if (record.terminalOutcome.stage === "PREPARATION" && record.stageOutcomes.length > 0) {
        context.addIssue({
          code: "custom",
          message: "preparation failure cannot have stage outcomes",
          path: ["stageOutcomes"],
        });
      } else if (
        EvaluationStageNameV1Schema.safeParse(record.terminalOutcome.stage).success &&
        failed?.stage !== record.terminalOutcome.stage
      ) {
        context.addIssue({
          code: "custom",
          message: "runner stage failure requires matching failed stage outcome",
          path: ["stageOutcomes"],
        });
      } else if (
        record.terminalOutcome.stage === "REPORT" &&
        (record.stageOutcomes.length !== 3 ||
          record.stageOutcomes.some(({ state }) => state !== "SUCCEEDED"))
      ) {
        context.addIssue({
          code: "custom",
          message: "report failure requires every reviewer stage to succeed",
          path: ["stageOutcomes"],
        });
      }
    }
    if (
      record.terminalOutcome.kind === "CANCELLED" &&
      record.stageOutcomes.some(({ state }) => state === "FAILED")
    ) {
      context.addIssue({
        code: "custom",
        message: "cancelled attempt cannot disguise a stage failure",
        path: ["terminalOutcome"],
      });
    }
    if (record.terminalOutcome.kind === "CANCELLED" && record.stageOutcomes.length === 3) {
      context.addIssue({
        code: "custom",
        message: "cancelled attempt cannot follow a completed final stage",
        path: ["terminalOutcome"],
      });
    }
    const tokenValues = [
      record.usage.promptTokens,
      record.usage.completionTokens,
      record.usage.totalTokens,
    ];
    const knownTokenCount = tokenValues.filter((value) => value !== null).length;
    if (knownTokenCount !== 0 && knownTokenCount !== tokenValues.length) {
      context.addIssue({
        code: "custom",
        message: "token counts must be wholly known or wholly unavailable",
        path: ["usage"],
      });
    } else if (
      knownTokenCount === 3 &&
      record.usage.totalTokens !==
        (record.usage.promptTokens as number) + (record.usage.completionTokens as number)
    ) {
      context.addIssue({
        code: "custom",
        message: "total tokens must equal prompt plus completion tokens",
        path: ["usage", "totalTokens"],
      });
    }
    if (
      record.usage.knownCostAttempts + record.usage.unknownCostAttempts !==
      record.usage.providerAttempts
    ) {
      context.addIssue({
        code: "custom",
        message: "known and unknown cost attempts must equal provider attempts",
        path: ["usage"],
      });
    }
    if (record.usage.knownCostAttempts > 0 && record.usage.knownCostUsd === null) {
      context.addIssue({
        code: "custom",
        message: "known-cost attempts require reported cost",
        path: ["usage", "knownCostUsd"],
      });
    }
    if (record.usage.knownCostAttempts === 0 && record.usage.knownCostUsd !== null) {
      context.addIssue({
        code: "custom",
        message: "reported cost requires at least one known-cost attempt",
        path: ["usage", "knownCostUsd"],
      });
    }
    const minimumProviderAttempts = record.stageOutcomes.filter(
      ({ providerCall }) => providerCall,
    ).length;
    if (record.usage.providerAttempts < minimumProviderAttempts) {
      context.addIssue({
        code: "custom",
        message: "provider attempt count cannot be lower than executed provider stages",
        path: ["usage", "providerAttempts"],
      });
    }
    if (record.usage.conservativeChargeUsd > record.usage.admittedCeilingUsd) {
      context.addIssue({
        code: "custom",
        message: "conservative charge cannot exceed admitted ceiling",
        path: ["usage", "conservativeChargeUsd"],
      });
    }
    const stageElapsedMs = record.stageOutcomes.reduce((sum, { elapsedMs }) => sum + elapsedMs, 0);
    if (stageElapsedMs > record.elapsedMs) {
      context.addIssue({
        code: "custom",
        message: "stage elapsed time cannot exceed attempt elapsed time",
        path: ["stageOutcomes"],
      });
    }
  })
  .transform((record) => ({
    ...record,
    findingClaims: [...record.findingClaims].sort((left, right) =>
      compareUtf16(left.findingReference, right.findingReference),
    ),
  }));

const AdjudicationLabelV1Schema = z.enum([
  "MATCHED_DEFECT",
  "NOVEL_VALID_DEFECT",
  "INVALID_DEFECT",
  "UNRESOLVED",
  "USEFUL_RECOMMENDATION",
  "INVALID_RECOMMENDATION",
  "DUPLICATE",
  "SUPPORTED_UNCERTAINTY",
]);

export const EvaluationAdjudicationRecordV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    adjudicationId: EvaluationAdjudicationIdV1Schema,
    experimentId: EvaluationExperimentIdV1Schema,
    experimentManifestDigest: DigestV1Schema,
    attemptId: EvaluationAttemptIdV1Schema,
    caseId: EvaluationCaseIdV1Schema,
    findingReference: NonEmptyTextSchema,
    claimDigest: DigestV1Schema,
    label: AdjudicationLabelV1Schema,
    matchedRootId: prefixedIdentifier("root").nullable(),
    causalEvidence: z.array(
      z.discriminatedUnion("source", [
        z.strictObject({
          source: z.literal("CASE_INPUT"),
          reference: NonEmptyTextSchema,
          digest: DigestV1Schema,
        }),
        z.strictObject({
          source: z.literal("REPORT"),
          reference: NonEmptyTextSchema,
          digest: DigestV1Schema,
        }),
      ]),
    ),
    matchedUncertaintyId: prefixedIdentifier("uncertainty").nullable(),
    severityCalibration: z
      .strictObject({
        expected: z.enum(["BLOCKING", "NON_BLOCKING", "NOT_APPLICABLE"]),
        observed: z.enum(["BLOCKING", "NON_BLOCKING", "NOT_APPLICABLE"]),
      })
      .nullable(),
    enforcementClassification: z
      .strictObject({
        expected: z.enum(["REQUIRED", "RECOMMENDED", "NOT_APPLICABLE", "UNAVAILABLE"]),
        observed: z.enum(["REQUIRED", "RECOMMENDED", "NOT_APPLICABLE", "UNAVAILABLE"]),
      })
      .nullable(),
    adjudicator: z.strictObject({
      type: z.enum(["HUMAN", "MODEL_ASSISTED"]),
      identity: NonEmptyTextSchema,
    }),
    promotionAuthority: z
      .strictObject({ type: z.literal("HUMAN"), identity: NonEmptyTextSchema })
      .nullable(),
    rationale: NonEmptyTextSchema,
    unresolvedDisagreement: NonEmptyTextSchema.nullable(),
    adjudicatedAt: z.iso.datetime(),
  })
  .superRefine((record, context) => {
    const requiresRoot = record.label === "MATCHED_DEFECT" || record.label === "DUPLICATE";
    const supported =
      requiresRoot ||
      record.label === "NOVEL_VALID_DEFECT" ||
      record.label === "SUPPORTED_UNCERTAINTY" ||
      record.label === "USEFUL_RECOMMENDATION";
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
    if (record.label === "SUPPORTED_UNCERTAINTY" && record.matchedUncertaintyId === null) {
      context.addIssue({
        code: "custom",
        message: "supported uncertainty requires matched uncertainty ID",
        path: ["matchedUncertaintyId"],
      });
    }
    if (record.label !== "SUPPORTED_UNCERTAINTY" && record.matchedUncertaintyId !== null) {
      context.addIssue({
        code: "custom",
        message: "only supported uncertainty may match uncertainty ID",
        path: ["matchedUncertaintyId"],
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
    if (supported && record.causalEvidence.length === 0) {
      context.addIssue({
        code: "custom",
        message: `${record.label} requires causal evidence`,
        path: ["causalEvidence"],
      });
    }
    if (supported && record.promotionAuthority === null) {
      context.addIssue({
        code: "custom",
        message: `${record.label} requires explicit human promotion authority`,
        path: ["promotionAuthority"],
      });
    }
    reportDuplicate(
      record.causalEvidence.map(({ reference }) => reference),
      context,
      ["causalEvidence"],
      "causal evidence reference",
    );
  })
  .transform((record) => ({
    ...record,
    causalEvidence: [...record.causalEvidence].sort((left, right) =>
      compareUtf16(left.reference, right.reference),
    ),
  }));

const EvaluationMetricV1Schema = z
  .strictObject({
    metric: EvaluationMetricNameV1Schema,
    numerator: SafeNonnegativeIntegerSchema,
    denominator: SafeNonnegativeIntegerSchema,
    value: z.number().finite().min(0).max(1).nullable(),
    interval: z
      .strictObject({
        method: NonEmptyTextSchema,
        confidenceLevel: z.number().finite().positive().max(1),
        lower: z.number().finite().min(0).max(1),
        upper: z.number().finite().min(0).max(1),
        independentUnit: z.enum(["CASE", "FAMILY"]),
      })
      .nullable(),
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
    if (metric.denominator === 0 && metric.interval !== null) {
      context.addIssue({
        code: "custom",
        message: "zero denominator interval must remain unavailable",
        path: ["interval"],
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
      if (metric.interval === null) {
        context.addIssue({
          code: "custom",
          message: "available metric requires uncertainty interval",
          path: ["interval"],
        });
      } else if (
        metric.interval.lower > metric.interval.upper ||
        (metric.value as number) < metric.interval.lower ||
        (metric.value as number) > metric.interval.upper
      ) {
        context.addIssue({
          code: "custom",
          message: "metric interval must contain value",
          path: ["interval"],
        });
      }
    }
  });

const ScoreMetricsV1Schema = z
  .array(EvaluationMetricV1Schema)
  .min(1)
  .superRefine((metrics, context) => {
    reportDuplicate(
      metrics.map(({ metric }) => metric),
      context,
      [],
      "metric",
    );
  });

const AttemptScoreResourcesV1Schema = z.strictObject({
  providerAttempts: SafeNonnegativeIntegerSchema,
  knownCostAttempts: SafeNonnegativeIntegerSchema,
  evidenceBytes: SafeNonnegativeIntegerSchema,
  outputBytes: SafeNonnegativeIntegerSchema,
  reportedCostUsd: NonnegativeFiniteNumberSchema,
  unknownCostAttempts: SafeNonnegativeIntegerSchema,
  conservativeChargeUsd: NonnegativeFiniteNumberSchema,
  admittedCeilingUsd: NonnegativeFiniteNumberSchema,
});

const AttemptMetricContributionV1Schema = z.strictObject({
  metric: EvaluationMetricNameV1Schema,
  numerator: SafeNonnegativeIntegerSchema,
  denominator: SafeNonnegativeIntegerSchema,
});

const DistributionV1Schema = z
  .strictObject({
    count: SafeNonnegativeIntegerSchema,
    minimum: NonnegativeFiniteNumberSchema.nullable(),
    median: NonnegativeFiniteNumberSchema.nullable(),
    p95: NonnegativeFiniteNumberSchema.nullable(),
    maximum: NonnegativeFiniteNumberSchema.nullable(),
  })
  .superRefine((distribution, context) => {
    const values = [
      distribution.minimum,
      distribution.median,
      distribution.p95,
      distribution.maximum,
    ];
    if (distribution.count === 0 && values.some((value) => value !== null)) {
      context.addIssue({
        code: "custom",
        message: "empty distribution values must remain unavailable",
      });
    }
    if (distribution.count > 0 && values.some((value) => value === null)) {
      context.addIssue({
        code: "custom",
        message: "nonempty distribution requires every summary value",
      });
    }
    if (distribution.count > 0) {
      const [minimum, median, p95, maximum] = values as [number, number, number, number];
      if (minimum > median || median > p95 || p95 > maximum) {
        context.addIssue({ code: "custom", message: "distribution summaries must be ordered" });
      }
    }
  });

export const EvaluationScoreReportV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    scoreId: EvaluationScoreIdV1Schema,
    experimentId: EvaluationExperimentIdV1Schema,
    experimentManifestDigest: DigestV1Schema,
    scorerVersion: NonEmptyTextSchema,
    scorerPolicyDigest: DigestV1Schema,
    generatedAt: z.iso.datetime(),
    metrics: ScoreMetricsV1Schema,
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
    caseBreakdowns: z
      .array(
        z.strictObject({
          caseId: EvaluationCaseIdV1Schema,
          familyId: EvaluationFamilyIdV1Schema,
          split: z.enum(["DEVELOPMENT", "HOLDOUT"]),
          metrics: ScoreMetricsV1Schema,
        }),
      )
      .min(1),
    familyBreakdowns: z
      .array(
        z.strictObject({
          familyId: EvaluationFamilyIdV1Schema,
          split: z.enum(["DEVELOPMENT", "HOLDOUT"]),
          metrics: ScoreMetricsV1Schema,
        }),
      )
      .min(1),
    attemptEvidence: z
      .array(
        z.strictObject({
          attemptId: EvaluationAttemptIdV1Schema,
          attemptDigest: DigestV1Schema,
          adjudicationIds: z.array(EvaluationAdjudicationIdV1Schema),
          metrics: z.array(AttemptMetricContributionV1Schema).min(1),
          resources: AttemptScoreResourcesV1Schema,
        }),
      )
      .min(1),
    severityCalibration: z.strictObject({
      eligibleAdjudications: SafeNonnegativeIntegerSchema,
      classifiedAdjudications: SafeNonnegativeIntegerSchema,
      exact: SafeNonnegativeIntegerSchema,
      underclassified: SafeNonnegativeIntegerSchema,
      overclassified: SafeNonnegativeIntegerSchema,
      unavailableAdjudicationIds: z.array(EvaluationAdjudicationIdV1Schema),
    }),
    enforcementConfusion: z.strictObject({
      eligibleAdjudications: SafeNonnegativeIntegerSchema,
      classifiedAdjudications: SafeNonnegativeIntegerSchema,
      cells: z.array(
        z.strictObject({
          expected: z.enum(["REQUIRED", "RECOMMENDED", "NOT_APPLICABLE", "UNAVAILABLE"]),
          observed: z.enum(["REQUIRED", "RECOMMENDED", "NOT_APPLICABLE", "UNAVAILABLE"]),
          count: SafeNonnegativeIntegerSchema,
        }),
      ),
      unavailableAdjudicationIds: z.array(EvaluationAdjudicationIdV1Schema),
    }),
    pairedDeltas: z.array(
      z.strictObject({
        comparisonId: EvaluationComparisonIdV1Schema,
        pairId: EvaluationPairIdV1Schema,
        baselineVariantId: EvaluationVariantIdV1Schema,
        candidateVariantId: EvaluationVariantIdV1Schema,
        metric: EvaluationMetricNameV1Schema,
        baselineValue: z.number().finite().min(0).max(1).nullable(),
        candidateValue: z.number().finite().min(0).max(1).nullable(),
        delta: z.number().finite().min(-1).max(1).nullable(),
      }),
    ),
    latency: z.strictObject({
      perReviewMs: DistributionV1Schema,
      perStageMs: z.strictObject({
        preliminary: DistributionV1Schema,
        findingVerification: DistributionV1Schema,
        final: DistributionV1Schema,
      }),
    }),
    resources: z.strictObject({
      providerAttempts: SafeNonnegativeIntegerSchema,
      evidenceBytes: SafeNonnegativeIntegerSchema,
      outputBytes: SafeNonnegativeIntegerSchema,
      execution: z
        .array(
          z.strictObject({
            name: NonEmptyTextSchema,
            unit: NonEmptyTextSchema,
            value: NonnegativeFiniteNumberSchema,
          }),
        )
        .length(0, "execution resources remain unavailable without digest-bound evidence"),
    }),
    cost: z.strictObject({
      reportedCostUsd: NonnegativeFiniteNumberSchema,
      knownCostAttempts: SafeNonnegativeIntegerSchema,
      unknownCostAttempts: SafeNonnegativeIntegerSchema,
      conservativeChargeUsd: NonnegativeFiniteNumberSchema,
      admittedCeilingUsd: NonnegativeFiniteNumberSchema,
    }),
    rawArtifactReferences: z
      .array(
        z.discriminatedUnion("type", [
          z.strictObject({
            type: z.literal("CASE"),
            id: EvaluationCaseIdV1Schema,
            reference: NonEmptyTextSchema,
            digest: DigestV1Schema,
          }),
          z.strictObject({
            type: z.literal("SPLIT"),
            id: NonEmptyTextSchema,
            reference: NonEmptyTextSchema,
            digest: DigestV1Schema,
          }),
          z.strictObject({
            type: z.literal("EXPERIMENT"),
            id: EvaluationExperimentIdV1Schema,
            reference: NonEmptyTextSchema,
            digest: DigestV1Schema,
          }),
          z.strictObject({
            type: z.literal("ATTEMPT"),
            id: EvaluationAttemptIdV1Schema,
            reference: NonEmptyTextSchema,
            digest: DigestV1Schema,
          }),
          z.strictObject({
            type: z.literal("ADJUDICATION"),
            id: EvaluationAdjudicationIdV1Schema,
            reference: NonEmptyTextSchema,
            digest: DigestV1Schema,
          }),
        ]),
      )
      .min(1),
  })
  .superRefine((report, context) => {
    const requiredMetrics = EvaluationMetricNameV1Schema.options;
    reportDuplicate(
      report.metrics.map(({ metric }) => metric),
      context,
      ["metrics"],
      "metric",
    );
    reportDuplicate(
      report.attemptEvidence.map(({ attemptId }) => attemptId),
      context,
      ["attemptEvidence"],
      "attempt evidence",
    );
    for (const [index, evidence] of report.attemptEvidence.entries()) {
      reportDuplicate(
        evidence.adjudicationIds,
        context,
        ["attemptEvidence", index, "adjudicationIds"],
        "adjudication ID",
      );
    }
    const checkCompleteMetrics = (
      metrics: readonly { metric: string }[],
      path: readonly PropertyKey[],
    ) => {
      if (
        metrics.length !== requiredMetrics.length ||
        requiredMetrics.some((metric) => !metrics.some((entry) => entry.metric === metric))
      ) {
        context.addIssue({
          code: "custom",
          message: "breakdown requires every protocol metric",
          path: [...path],
        });
      }
    };
    for (const [index, breakdown] of report.caseBreakdowns.entries())
      checkCompleteMetrics(breakdown.metrics, ["caseBreakdowns", index, "metrics"]);
    for (const [index, breakdown] of report.familyBreakdowns.entries())
      checkCompleteMetrics(breakdown.metrics, ["familyBreakdowns", index, "metrics"]);
    for (const [index, evidence] of report.attemptEvidence.entries())
      checkCompleteMetrics(evidence.metrics, ["attemptEvidence", index, "metrics"]);
    const severity = report.severityCalibration;
    if (
      severity.classifiedAdjudications + severity.unavailableAdjudicationIds.length !==
        severity.eligibleAdjudications ||
      severity.exact + severity.underclassified + severity.overclassified !==
        severity.classifiedAdjudications
    ) {
      context.addIssue({
        code: "custom",
        message: "severity calibration counts must reconcile",
        path: ["severityCalibration"],
      });
    }
    reportDuplicate(
      severity.unavailableAdjudicationIds,
      context,
      ["severityCalibration", "unavailableAdjudicationIds"],
      "unavailable severity adjudication ID",
    );
    const enforcement = report.enforcementConfusion;
    if (
      enforcement.classifiedAdjudications + enforcement.unavailableAdjudicationIds.length !==
        enforcement.eligibleAdjudications ||
      enforcement.cells.reduce((sum, cell) => sum + cell.count, 0) !==
        enforcement.classifiedAdjudications
    ) {
      context.addIssue({
        code: "custom",
        message: "enforcement confusion counts must reconcile",
        path: ["enforcementConfusion"],
      });
    }
    reportDuplicate(
      enforcement.cells.map(({ expected, observed }) => `${expected}:${observed}`),
      context,
      ["enforcementConfusion", "cells"],
      "enforcement confusion cell",
    );
    if (enforcement.cells.length !== 16)
      context.addIssue({
        code: "custom",
        message: "enforcement confusion must include every expected/observed cell",
        path: ["enforcementConfusion", "cells"],
      });
    reportDuplicate(
      enforcement.unavailableAdjudicationIds,
      context,
      ["enforcementConfusion", "unavailableAdjudicationIds"],
      "unavailable enforcement adjudication ID",
    );
    if (
      report.metrics.length !== requiredMetrics.length ||
      requiredMetrics.some((metric) => !report.metrics.some((entry) => entry.metric === metric))
    ) {
      context.addIssue({
        code: "custom",
        message: "score report requires every protocol metric",
        path: ["metrics"],
      });
    }
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
    reportDuplicate(
      report.caseBreakdowns.map(({ caseId }) => caseId),
      context,
      ["caseBreakdowns"],
      "case breakdown",
    );
    reportDuplicate(
      report.familyBreakdowns.map(({ familyId }) => familyId),
      context,
      ["familyBreakdowns"],
      "family breakdown",
    );
    reportDuplicate(
      report.rawArtifactReferences.map(({ type, id }) => `${type}:${id}`),
      context,
      ["rawArtifactReferences"],
      "raw artifact reference",
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
      if (delta.baselineVariantId === delta.candidateVariantId) {
        context.addIssue({
          code: "custom",
          message: "paired delta variants must differ",
          path: ["pairedDeltas", index],
        });
      }
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
    if (
      report.cost.knownCostAttempts + report.cost.unknownCostAttempts !==
      report.resources.providerAttempts
    ) {
      context.addIssue({
        code: "custom",
        message: "known and unknown cost attempts must equal provider attempts",
        path: ["cost"],
      });
    }
    if (report.cost.conservativeChargeUsd > report.cost.admittedCeilingUsd) {
      context.addIssue({
        code: "custom",
        message: "conservative charge cannot exceed admitted ceiling",
        path: ["cost", "conservativeChargeUsd"],
      });
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
      compareUtf16(left.caseId, right.caseId),
    ),
    familyBreakdowns: [...report.familyBreakdowns].sort((left, right) =>
      compareUtf16(left.familyId, right.familyId),
    ),
    attemptEvidence: [...report.attemptEvidence]
      .map((evidence) => ({
        ...evidence,
        adjudicationIds: [...evidence.adjudicationIds].sort(compareUtf16),
        metrics: [...evidence.metrics].sort((left, right) =>
          compareUtf16(left.metric, right.metric),
        ),
      }))
      .sort((left, right) => compareUtf16(left.attemptId, right.attemptId)),
    severityCalibration: {
      ...report.severityCalibration,
      unavailableAdjudicationIds: [...report.severityCalibration.unavailableAdjudicationIds].sort(
        compareUtf16,
      ),
    },
    enforcementConfusion: {
      ...report.enforcementConfusion,
      cells: [...report.enforcementConfusion.cells].sort((left, right) =>
        compareByFields(left, right, ["expected", "observed"]),
      ),
      unavailableAdjudicationIds: [...report.enforcementConfusion.unavailableAdjudicationIds].sort(
        compareUtf16,
      ),
    },
    pairedDeltas: [...report.pairedDeltas].sort((left, right) =>
      compareByFields(left, right, [
        "comparisonId",
        "pairId",
        "baselineVariantId",
        "candidateVariantId",
        "metric",
      ]),
    ),
    rawArtifactReferences: [...report.rawArtifactReferences].sort((left, right) =>
      compareByFields(left, right, ["type", "id", "reference"]),
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
