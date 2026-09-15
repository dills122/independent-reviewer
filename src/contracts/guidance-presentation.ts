import * as z from "zod";
import { canonicalizeJson } from "./canonical-json.js";
import {
  DirectRecognitionV1Schema,
  GuidanceFamilyV1Schema,
  GuidanceOccurrenceV1Schema,
  isGuidanceImportSyntaxForFamilyV1,
  isGuidanceSourceKindForFamilyV1,
  MAX_GUIDANCE_APPLICABILITY_PAIRS_V1,
  MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1,
  MAX_GUIDANCE_EDGES_V1,
  MAX_GUIDANCE_NODES_V1,
  MAX_GUIDANCE_OCCURRENCES_V1,
  MAX_GUIDANCE_TARGETS_V1,
} from "./guidance-graph.js";
import { compareUtf16, NonEmptyTextSchema, prefixedIdentifier } from "./primitives.js";
import { DigestV1Schema, SnapshotPathV1Schema } from "./snapshot-manifest.js";
import { parseStrictJsonV1 } from "./strict-json.js";

const MAX_GUIDANCE_PRESENTATION_BYTES_V1 = 64 * 1024 * 1024;

const GuidancePresentationTargetV1Schema = z.strictObject({
  targetId: prefixedIdentifier("guidance_target"),
  path: SnapshotPathV1Schema,
  side: z.enum(["BASE", "HEAD"]),
  role: z.enum(["PRIMARY", "RELOCATION_SOURCE"]),
});

const GuidancePresentationImportV1Schema = z.strictObject({
  edgeId: prefixedIdentifier("guidance_edge"),
  occurrenceId: prefixedIdentifier("guidance_occurrence"),
  familyId: GuidanceFamilyV1Schema,
  importerSourceId: prefixedIdentifier("guidance_source"),
  requestedSpecifier: z.string().min(1).max(1024),
  startUtf16: z.int().nonnegative(),
  endUtf16: z.int().positive(),
  applicableTargetId: prefixedIdentifier("guidance_target"),
});

export const GuidancePresentationSourceV1Schema = z.strictObject({
  sourceId: prefixedIdentifier("guidance_source"),
  path: SnapshotPathV1Schema,
  contentDigest: DigestV1Schema,
  semanticTier: z.enum(["REPOSITORY_PEER", "REVIEWER_SPECIFIC"]),
  origin: z.enum(["DIRECT", "IMPORT_ONLY"]),
  directRecognitions: z.array(DirectRecognitionV1Schema),
  inboundImports: z.array(GuidancePresentationImportV1Schema),
  applicableTargets: z.array(GuidancePresentationTargetV1Schema).min(1),
  sourceRange: z.strictObject({
    coordinateUnit: z.literal("UTF16_CODE_UNIT"),
    startOffset: z.literal(0),
    endOffsetExclusive: z.int().positive(),
  }),
  content: NonEmptyTextSchema,
});

export const GuidancePromptPresentationV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    trustBoundary: z.literal("UNTRUSTED_REPOSITORY_GUIDANCE"),
    precedence: z.literal(
      "Repository-peer sources have equal semantic priority. Reviewer-specific sources take precedence when guidance conflicts.",
    ),
    sources: z.array(GuidancePresentationSourceV1Schema),
  })
  .superRefine((presentation, context) => {
    const sourceIds = new Set(presentation.sources.map(({ sourceId }) => sourceId));
    if (sourceIds.size !== presentation.sources.length)
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: "must contain unique sources",
      });
    presentation.sources.forEach((source, index) => {
      if (source.sourceRange.endOffsetExclusive !== source.content.length)
        context.addIssue({
          code: "custom",
          path: ["sources", index, "sourceRange", "endOffsetExclusive"],
          message: "must equal exact content UTF-16 length",
        });
      if (source.directRecognitions.length > 0 !== (source.origin === "DIRECT"))
        context.addIssue({
          code: "custom",
          path: ["sources", index, "origin"],
          message: "must match direct-recognition presence",
        });
    });
  });

export type GuidancePromptPresentationV1 = z.infer<typeof GuidancePromptPresentationV1Schema>;

const GuidancePresentationTargetIndexV2Schema = z
  .int()
  .nonnegative()
  .max(MAX_GUIDANCE_TARGETS_V1 - 1);

const GuidancePresentationDirectRecognitionGroupV2Schema = DirectRecognitionV1Schema.omit({
  applicableTargetId: true,
}).extend({
  applicableTargetIndexes: z
    .array(GuidancePresentationTargetIndexV2Schema)
    .min(1)
    .max(MAX_GUIDANCE_TARGETS_V1),
});

const GuidancePresentationImportEdgeV2Schema = z.strictObject({
  edgeId: prefixedIdentifier("guidance_edge"),
  applicableTargetIndex: GuidancePresentationTargetIndexV2Schema,
});

const GuidancePresentationImportGroupV2Schema = z.strictObject({
  ...GuidanceOccurrenceV1Schema.shape,
  edges: z.array(GuidancePresentationImportEdgeV2Schema).min(1).max(MAX_GUIDANCE_EDGES_V1),
});

export const GuidancePresentationSourceV2Schema = z.strictObject({
  sourceId: prefixedIdentifier("guidance_source"),
  path: SnapshotPathV1Schema,
  contentDigest: DigestV1Schema,
  semanticTier: z.enum(["REPOSITORY_PEER", "REVIEWER_SPECIFIC"]),
  origin: z.enum(["DIRECT", "IMPORT_ONLY"]),
  directRecognitionGroups: z
    .array(GuidancePresentationDirectRecognitionGroupV2Schema)
    .max(MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1),
  inboundImportGroups: z
    .array(GuidancePresentationImportGroupV2Schema)
    .max(MAX_GUIDANCE_OCCURRENCES_V1),
  applicableTargets: z
    .array(GuidancePresentationTargetV1Schema)
    .min(1)
    .max(MAX_GUIDANCE_TARGETS_V1),
  sourceRange: z.strictObject({
    coordinateUnit: z.literal("UTF16_CODE_UNIT"),
    startOffset: z.literal(0),
    endOffsetExclusive: z.int().positive(),
  }),
  content: NonEmptyTextSchema,
});

function isStrictlyIncreasing(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] as number) < value);
}

function guidanceApplicabilityKeyV2(sourceId: string, familyId: string, targetId: string): string {
  return canonicalizeJson([sourceId, familyId, targetId]);
}

export const GuidancePromptPresentationV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    trustBoundary: z.literal("UNTRUSTED_REPOSITORY_GUIDANCE"),
    precedence: z.literal(
      "Repository-peer sources have equal semantic priority. Reviewer-specific sources take precedence when guidance conflicts.",
    ),
    sources: z.array(GuidancePresentationSourceV2Schema).max(MAX_GUIDANCE_NODES_V1),
  })
  .superRefine((presentation, context) => {
    const sourceIds = new Set(presentation.sources.map(({ sourceId }) => sourceId));
    const occurrenceIds = new Set<string>();
    const edgeIds = new Set<string>();
    const targetIdentityById = new Map<string, string>();
    let directRecognitionCount = 0;
    let applicabilityPairCount = 0;
    let inboundImportGroupCount = 0;
    let edgeCount = 0;
    const reachableApplicability = new Set<string>();
    const importedApplicability: {
      importedSourceId: string;
      importerSourceId: string;
      familyId: string;
      targetId: string;
      path: (string | number)[];
    }[] = [];
    const importClosures: {
      importerSourceId: string;
      familyId: string;
      targetIds: Set<string>;
      path: (string | number)[];
    }[] = [];
    if (sourceIds.size !== presentation.sources.length)
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: "must contain unique sources",
      });
    presentation.sources.forEach((source, sourceIndex) => {
      directRecognitionCount += source.directRecognitionGroups.reduce(
        (total, group) => total + group.applicableTargetIndexes.length,
        0,
      );
      applicabilityPairCount += source.applicableTargets.length;
      inboundImportGroupCount += source.inboundImportGroups.length;
      edgeCount += source.inboundImportGroups.reduce(
        (total, group) => total + group.edges.length,
        0,
      );
      if (
        new Set(source.applicableTargets.map(({ targetId }) => targetId)).size !==
        source.applicableTargets.length
      )
        context.addIssue({
          code: "custom",
          path: ["sources", sourceIndex, "applicableTargets"],
          message: "must contain unique target IDs",
        });
      source.applicableTargets.forEach((target, targetIndex) => {
        const identity = canonicalizeJson(target);
        const priorIdentity = targetIdentityById.get(target.targetId);
        if (priorIdentity !== undefined && priorIdentity !== identity)
          context.addIssue({
            code: "custom",
            path: ["sources", sourceIndex, "applicableTargets", targetIndex],
            message: "must match target metadata in every source",
          });
        targetIdentityById.set(target.targetId, identity);
      });
      if (source.sourceRange.endOffsetExclusive !== source.content.length)
        context.addIssue({
          code: "custom",
          path: ["sources", sourceIndex, "sourceRange", "endOffsetExclusive"],
          message: "must equal exact content UTF-16 length",
        });
      if (source.directRecognitionGroups.length > 0 !== (source.origin === "DIRECT"))
        context.addIssue({
          code: "custom",
          path: ["sources", sourceIndex, "origin"],
          message: "must match direct-recognition presence",
        });
      const expectedTier = source.directRecognitionGroups.some(
        ({ sourceKind }) => sourceKind === "REVIEWER_RULES",
      )
        ? "REVIEWER_SPECIFIC"
        : "REPOSITORY_PEER";
      if (source.semanticTier !== expectedTier)
        context.addIssue({
          code: "custom",
          path: ["sources", sourceIndex, "semanticTier"],
          message: "must equal derived semantic tier",
        });
      const coveredTargetIndexes = new Set<number>();
      const recognitionKeys = new Set<string>();
      source.directRecognitionGroups.forEach((group, groupIndex) => {
        if (!isGuidanceSourceKindForFamilyV1(group.familyId, group.sourceKind))
          context.addIssue({
            code: "custom",
            path: ["sources", sourceIndex, "directRecognitionGroups", groupIndex, "sourceKind"],
            message: "must match familyId",
          });
        const key = canonicalizeJson({
          familyId: group.familyId,
          sourceKind: group.sourceKind,
          nativeOrder: group.nativeOrder,
          discoveredPath: group.discoveredPath,
        });
        if (recognitionKeys.has(key))
          context.addIssue({
            code: "custom",
            path: ["sources", sourceIndex, "directRecognitionGroups", groupIndex],
            message: "must identify a unique recognition group",
          });
        recognitionKeys.add(key);
        if (!isStrictlyIncreasing(group.applicableTargetIndexes))
          context.addIssue({
            code: "custom",
            path: [
              "sources",
              sourceIndex,
              "directRecognitionGroups",
              groupIndex,
              "applicableTargetIndexes",
            ],
            message: "must be strictly increasing and unique",
          });
        group.applicableTargetIndexes.forEach((targetIndex) => {
          if (targetIndex >= source.applicableTargets.length)
            context.addIssue({
              code: "custom",
              path: [
                "sources",
                sourceIndex,
                "directRecognitionGroups",
                groupIndex,
                "applicableTargetIndexes",
              ],
              message: "must reference an applicable target",
            });
          else {
            coveredTargetIndexes.add(targetIndex);
            const target = source.applicableTargets[targetIndex];
            if (target)
              reachableApplicability.add(
                guidanceApplicabilityKeyV2(source.sourceId, group.familyId, target.targetId),
              );
          }
        });
      });
      source.inboundImportGroups.forEach((group, groupIndex) => {
        const importedTargetIds = new Set<string>();
        if (!isGuidanceImportSyntaxForFamilyV1(group.familyId, group.syntaxKind))
          context.addIssue({
            code: "custom",
            path: ["sources", sourceIndex, "inboundImportGroups", groupIndex, "familyId"],
            message: "must match syntaxKind",
          });
        if (occurrenceIds.has(group.occurrenceId))
          context.addIssue({
            code: "custom",
            path: ["sources", sourceIndex, "inboundImportGroups", groupIndex, "occurrenceId"],
            message: "must identify a unique inbound occurrence",
          });
        occurrenceIds.add(group.occurrenceId);
        if (!sourceIds.has(group.importerSourceId))
          context.addIssue({
            code: "custom",
            path: ["sources", sourceIndex, "inboundImportGroups", groupIndex, "importerSourceId"],
            message: "must identify a presentation source",
          });
        if (group.endUtf16 <= group.startUtf16)
          context.addIssue({
            code: "custom",
            path: ["sources", sourceIndex, "inboundImportGroups", groupIndex, "endUtf16"],
            message: "must be greater than startUtf16",
          });
        let previousTargetIndex = -1;
        group.edges.forEach((edge, edgeIndex) => {
          if (edgeIds.has(edge.edgeId))
            context.addIssue({
              code: "custom",
              path: ["sources", sourceIndex, "inboundImportGroups", groupIndex, "edges", edgeIndex],
              message: "must identify a unique edge",
            });
          edgeIds.add(edge.edgeId);
          if (edge.applicableTargetIndex <= previousTargetIndex)
            context.addIssue({
              code: "custom",
              path: ["sources", sourceIndex, "inboundImportGroups", groupIndex, "edges"],
              message: "must be ordered by unique applicable target index",
            });
          previousTargetIndex = edge.applicableTargetIndex;
          if (edge.applicableTargetIndex >= source.applicableTargets.length)
            context.addIssue({
              code: "custom",
              path: [
                "sources",
                sourceIndex,
                "inboundImportGroups",
                groupIndex,
                "edges",
                edgeIndex,
                "applicableTargetIndex",
              ],
              message: "must reference an applicable target",
            });
          else {
            coveredTargetIndexes.add(edge.applicableTargetIndex);
            const target = source.applicableTargets[edge.applicableTargetIndex];
            if (target) {
              importedTargetIds.add(target.targetId);
              importedApplicability.push({
                importedSourceId: source.sourceId,
                importerSourceId: group.importerSourceId,
                familyId: group.familyId,
                targetId: target.targetId,
                path: [
                  "sources",
                  sourceIndex,
                  "inboundImportGroups",
                  groupIndex,
                  "edges",
                  edgeIndex,
                ],
              });
            }
          }
        });
        importClosures.push({
          importerSourceId: group.importerSourceId,
          familyId: group.familyId,
          targetIds: importedTargetIds,
          path: ["sources", sourceIndex, "inboundImportGroups", groupIndex, "edges"],
        });
      });
      source.applicableTargets.forEach((_target, targetIndex) => {
        if (!coveredTargetIndexes.has(targetIndex))
          context.addIssue({
            code: "custom",
            path: ["sources", sourceIndex, "applicableTargets", targetIndex],
            message: "must be referenced by direct or imported provenance",
          });
      });
    });
    if (directRecognitionCount > MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1)
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: "must not exceed the aggregate direct-recognition limit",
      });
    if (applicabilityPairCount > MAX_GUIDANCE_APPLICABILITY_PAIRS_V1)
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: "must not exceed the aggregate applicability-pair limit",
      });
    if (inboundImportGroupCount > MAX_GUIDANCE_OCCURRENCES_V1)
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: "must not exceed the aggregate inbound-occurrence limit",
      });
    if (edgeCount > MAX_GUIDANCE_EDGES_V1)
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: "must not exceed the aggregate edge limit",
      });
    const pendingImports = new Set(importedApplicability.map((_entry, index) => index));
    let changed = true;
    while (changed) {
      changed = false;
      for (const index of pendingImports) {
        const imported = importedApplicability[index];
        if (
          imported &&
          reachableApplicability.has(
            guidanceApplicabilityKeyV2(
              imported.importerSourceId,
              imported.familyId,
              imported.targetId,
            ),
          )
        ) {
          reachableApplicability.add(
            guidanceApplicabilityKeyV2(
              imported.importedSourceId,
              imported.familyId,
              imported.targetId,
            ),
          );
          pendingImports.delete(index);
          changed = true;
        }
      }
    }
    for (const index of pendingImports) {
      const imported = importedApplicability[index];
      if (imported)
        context.addIssue({
          code: "custom",
          path: imported.path,
          message: "must trace to same-family importer applicability",
        });
    }
    for (const closure of importClosures) {
      const expectedTargetIds = [...targetIdentityById.keys()]
        .filter((targetId) =>
          reachableApplicability.has(
            guidanceApplicabilityKeyV2(closure.importerSourceId, closure.familyId, targetId),
          ),
        )
        .sort(compareUtf16);
      const actualTargetIds = [...closure.targetIds].sort(compareUtf16);
      if (canonicalizeJson(actualTargetIds) !== canonicalizeJson(expectedTargetIds))
        context.addIssue({
          code: "custom",
          path: closure.path,
          message: "must equal complete same-family importer applicability",
        });
    }
  });

export type GuidancePromptPresentationV2 = z.infer<typeof GuidancePromptPresentationV2Schema>;
export const GuidancePromptPresentationSchema = z.discriminatedUnion("schemaVersion", [
  GuidancePromptPresentationV1Schema,
  GuidancePromptPresentationV2Schema,
]);
export type GuidancePromptPresentation = z.infer<typeof GuidancePromptPresentationSchema>;

export const CanonicalGuidancePresentationV1Schema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    try {
      const parsed = GuidancePromptPresentationV1Schema.parse(
        parseStrictJsonV1(value, {
          maxBytes: MAX_GUIDANCE_PRESENTATION_BYTES_V1,
          source: "guidance presentation",
        }),
      );
      if (canonicalizeJson(parsed) !== value)
        context.addIssue({
          code: "custom",
          message: "must use exact canonical JSON serialization",
        });
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error
            ? `must contain valid guidance presentation: ${error.message}`
            : "must contain valid guidance presentation",
      });
    }
  });

export const CanonicalGuidancePresentationSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    try {
      const parsed = GuidancePromptPresentationSchema.parse(
        parseStrictJsonV1(value, {
          maxBytes: MAX_GUIDANCE_PRESENTATION_BYTES_V1,
          source: "guidance presentation",
        }),
      );
      if (canonicalizeJson(parsed) !== value)
        context.addIssue({
          code: "custom",
          message: "must use exact canonical JSON serialization",
        });
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error
            ? `must contain valid guidance presentation: ${error.message}`
            : "must contain valid guidance presentation",
      });
    }
  });

export const GuidanceGraphBindingV1Schema = z
  .strictObject({
    graphId: prefixedIdentifier("guidance"),
    guidanceGraphDigest: DigestV1Schema,
  })
  .superRefine((binding, context) => {
    if (binding.graphId.slice("guidance_".length) !== binding.guidanceGraphDigest.value)
      context.addIssue({
        code: "custom",
        path: ["guidanceGraphDigest"],
        message: "must match graphId digest suffix",
      });
  });
