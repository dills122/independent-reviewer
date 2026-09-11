import * as z from "zod";

import { canonicalizeJson, cloneCanonicalJson, digestCanonicalJson } from "./canonical-json.js";
import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import { NonEmptyTextSchema, prefixedIdentifier } from "./primitives.js";
import {
  type DigestV1,
  DigestV1Schema,
  PathRoleV1Schema,
  SnapshotPathV1Schema,
} from "./snapshot-manifest.js";

const PLACEHOLDER_DIGEST: DigestV1 = {
  algorithm: "SHA256",
  value: "0".repeat(64),
};

const SourceRangeV1Schema = z
  .strictObject({
    coordinateUnit: z.enum(["UTF16_CODE_UNIT", "UTF8_BYTE"]),
    startOffset: z.int().nonnegative(),
    endOffsetExclusive: z.int().nonnegative(),
    contentByteLength: z.int().min(1),
    startLine: z.int().min(1),
    startColumn: z.int().nonnegative(),
    endLine: z.int().min(1),
    endColumn: z.int().nonnegative(),
  })
  .superRefine((range, context) => {
    if (range.endOffsetExclusive <= range.startOffset) {
      context.addIssue({
        code: "custom",
        message: "must end after startOffset",
        path: ["endOffsetExclusive"],
      });
    }
    if (
      range.endLine < range.startLine ||
      (range.endLine === range.startLine && range.endColumn < range.startColumn)
    ) {
      context.addIssue({
        code: "custom",
        message: "must not end before the start position",
        path: ["endLine"],
      });
    }
  });

const ContextProducerV1Schema = z.strictObject({
  producerId: prefixedIdentifier("producer"),
  producerVersion: NonEmptyTextSchema,
  status: z.enum(["COMPLETE", "PARTIAL", "UNSUPPORTED", "FAILED"]),
  diagnostics: z.array(NonEmptyTextSchema),
});

const SourceRegionV1Schema = z
  .strictObject({
    regionId: prefixedIdentifier("region"),
    origin: z.enum(["CHANGED_PATH", "SUPPORTING_CONTEXT"]),
    path: SnapshotPathV1Schema,
    side: z.enum(["BASE", "HEAD"]),
    fileDigest: DigestV1Schema,
    byteLength: z.int().nonnegative(),
    role: PathRoleV1Schema.optional(),
    languageId: NonEmptyTextSchema,
    kind: z.enum(["FILE", "DECLARATION", "BLOCK", "LINE_WINDOW"]),
    range: SourceRangeV1Schema.optional(),
    producerId: prefixedIdentifier("producer"),
    producerKind: NonEmptyTextSchema.optional(),
    displayName: NonEmptyTextSchema.optional(),
  })
  .superRefine((region, context) => {
    if (region.kind !== "FILE" && region.range === undefined) {
      context.addIssue({
        code: "custom",
        message: "non-file regions require a source range",
        path: ["range"],
      });
    }
    if (
      region.range?.coordinateUnit === "UTF8_BYTE" &&
      region.range.endOffsetExclusive > region.byteLength
    ) {
      context.addIssue({
        code: "custom",
        message: "UTF-8 byte range must fit inside the captured file",
        path: ["range", "endOffsetExclusive"],
      });
    }
  });

const ContextRelationV1Schema = z.strictObject({
  relationId: prefixedIdentifier("relation"),
  sourceRegionId: prefixedIdentifier("region"),
  targetRegionId: prefixedIdentifier("region"),
  kind: z.enum(["ENCLOSES", "DEPENDS_ON", "REFERENCES", "VERIFIES", "CONFIGURES", "RELATED"]),
  certainty: z.enum(["SEMANTIC", "SYNTACTIC", "HEURISTIC"]),
  producerId: prefixedIdentifier("producer"),
  producerKind: NonEmptyTextSchema.optional(),
  sourceRange: SourceRangeV1Schema.optional(),
});

const ReviewContextMapBaseV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  contextMapId: prefixedIdentifier("context"),
  contextMapDigest: DigestV1Schema,
  snapshotDigest: DigestV1Schema,
  producers: z.array(ContextProducerV1Schema).min(1),
  regions: z.array(SourceRegionV1Schema),
  relations: z.array(ContextRelationV1Schema),
});

export const ReviewContextMapV1Schema = ReviewContextMapBaseV1Schema.superRefine((map, context) => {
  const producerIds = map.producers.map((producer) => producer.producerId);
  if (new Set(producerIds).size !== producerIds.length) {
    context.addIssue({
      code: "custom",
      message: "producer IDs must be unique",
      path: ["producers"],
    });
  }
  const producerIdSet = new Set(producerIds);
  const regionIds = map.regions.map((region) => region.regionId);
  if (new Set(regionIds).size !== regionIds.length) {
    context.addIssue({ code: "custom", message: "region IDs must be unique", path: ["regions"] });
  }
  const regionIdSet = new Set(regionIds);
  map.regions.forEach((region, index) => {
    if (!producerIdSet.has(region.producerId)) {
      context.addIssue({
        code: "custom",
        message: "must identify a declared producer",
        path: ["regions", index, "producerId"],
      });
    }
  });
  const relationIds = map.relations.map((relation) => relation.relationId);
  if (new Set(relationIds).size !== relationIds.length) {
    context.addIssue({
      code: "custom",
      message: "relation IDs must be unique",
      path: ["relations"],
    });
  }
  map.relations.forEach((relation, index) => {
    if (!producerIdSet.has(relation.producerId)) {
      context.addIssue({
        code: "custom",
        message: "must identify a declared producer",
        path: ["relations", index, "producerId"],
      });
    }
    for (const field of ["sourceRegionId", "targetRegionId"] as const) {
      if (!regionIdSet.has(relation[field])) {
        context.addIssue({
          code: "custom",
          message: "must identify a declared region",
          path: ["relations", index, field],
        });
      }
    }
  });
});

export type ReviewContextMapV1 = z.infer<typeof ReviewContextMapV1Schema>;
export type ReviewContextMapIdentityInputV1 = Omit<ReviewContextMapV1, "contextMapDigest">;

function addDigest(value: object, digest: DigestV1): Record<string, unknown> {
  return { ...value, contextMapDigest: digest };
}

function parseIdentityInput(value: unknown): ReviewContextMapIdentityInputV1 {
  const cloned = cloneCanonicalJson(value);
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) {
    throw new TypeError("review context map identity input must be an object");
  }
  if (Object.hasOwn(cloned, "contextMapDigest")) {
    throw new TypeError("review context map identity input must not contain contextMapDigest");
  }
  const parsed = ReviewContextMapV1Schema.parse(addDigest(cloned, PLACEHOLDER_DIGEST));
  const { contextMapDigest: _digest, ...identityInput } = parsed;
  return identityInput;
}

function identityPayload(input: ReviewContextMapIdentityInputV1): unknown {
  const { contextMapId: _contextMapId, producers, regions, relations, ...content } = input;
  const sortCanonical = <T>(values: readonly T[]): T[] =>
    [...values].sort((left, right) => {
      const a = canonicalizeJson(left);
      const b = canonicalizeJson(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  return {
    identityProfile: "urn:independent-reviewer:identity:review-context-map:v1",
    contextMap: {
      ...content,
      producers: sortCanonical(producers),
      regions: sortCanonical(regions),
      relations: sortCanonical(relations),
    },
  };
}

/** Strictly validates a draft, binds it to canonical identity, and returns a persisted map. */
export function finalizeReviewContextMapV1(value: unknown): ReviewContextMapV1 {
  const input = parseIdentityInput(value);
  return ReviewContextMapV1Schema.parse(
    addDigest(input, digestCanonicalJson(identityPayload(input))),
  );
}

/** Returns true only for a schema-valid map whose logical digest matches. */
export function verifyReviewContextMapIdentityV1(value: unknown): value is ReviewContextMapV1 {
  let cloned: unknown;
  try {
    cloned = cloneCanonicalJson(value);
  } catch {
    return false;
  }
  const parsed = ReviewContextMapV1Schema.safeParse(cloned);
  if (!parsed.success) return false;
  const { contextMapDigest, ...input } = parsed.data;
  return contextMapDigest.value === digestCanonicalJson(identityPayload(input)).value;
}

export const REVIEW_CONTEXT_MAP_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:review-context-map:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(ReviewContextMapV1Schema, { target: "draft-2020-12", io: "output" }),
};
