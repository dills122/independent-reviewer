import * as z from "zod";
import { canonicalizeJson } from "./canonical-json.js";
import { DirectRecognitionV1Schema, GuidanceFamilyV1Schema } from "./guidance-graph.js";
import { DigestV1Schema, SnapshotPathV1Schema } from "./snapshot-manifest.js";
import { NonEmptyTextSchema, prefixedIdentifier } from "./primitives.js";

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
    if (
      new Set(presentation.sources.map(({ sourceId }) => sourceId)).size !==
      presentation.sources.length
    )
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

export const CanonicalGuidancePresentationV1Schema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    try {
      const parsed = GuidancePromptPresentationV1Schema.parse(JSON.parse(value));
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
