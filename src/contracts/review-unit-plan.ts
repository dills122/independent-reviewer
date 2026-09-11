import * as z from "zod";

import { canonicalizeJson, cloneCanonicalJson, digestCanonicalJson } from "./canonical-json.js";
import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import { CanonicalInputIdSchema, NonEmptyTextSchema, prefixedIdentifier } from "./primitives.js";
import { type DigestV1, DigestV1Schema, SnapshotPathV1Schema } from "./snapshot-manifest.js";

const PLACEHOLDER_DIGEST: DigestV1 = {
  algorithm: "SHA256",
  value: "0".repeat(64),
};

const ReviewUnitV1Schema = z.strictObject({
  unitId: prefixedIdentifier("unit"),
  targetPaths: z.array(SnapshotPathV1Schema).min(1),
  primaryEvidenceIds: z.array(prefixedIdentifier("evidence")).min(1),
  primaryRegionIds: z.array(prefixedIdentifier("region")).min(1),
  supportingRegionIds: z.array(prefixedIdentifier("region")),
  relationIds: z.array(prefixedIdentifier("relation")),
  canonicalInputIds: z.array(CanonicalInputIdSchema).min(1),
  estimatedInputBytes: z.int().nonnegative(),
  limitations: z.array(NonEmptyTextSchema),
});

const ReviewUnitPlanBaseV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  planId: prefixedIdentifier("plan"),
  planDigest: DigestV1Schema,
  snapshotDigest: DigestV1Schema,
  briefDigest: DigestV1Schema,
  contextMapDigest: DigestV1Schema,
  plannerPolicyVersion: NonEmptyTextSchema,
  units: z.array(ReviewUnitV1Schema),
  exclusions: z.array(
    z.strictObject({
      evidenceId: prefixedIdentifier("evidence"),
      reason: NonEmptyTextSchema,
    }),
  ),
});

export const ReviewUnitPlanV1Schema = ReviewUnitPlanBaseV1Schema.superRefine((plan, context) => {
  const unitIds = plan.units.map((unit) => unit.unitId);
  if (new Set(unitIds).size !== unitIds.length) {
    context.addIssue({ code: "custom", message: "unit IDs must be unique", path: ["units"] });
  }
  const evidenceIds = plan.units.flatMap((unit) => unit.primaryEvidenceIds);
  const excludedIds = plan.exclusions.map((exclusion) => exclusion.evidenceId);
  const allEvidenceIds = [...evidenceIds, ...excludedIds];
  if (new Set(allEvidenceIds).size !== allEvidenceIds.length) {
    context.addIssue({
      code: "custom",
      message: "primary and excluded evidence IDs must be assigned exactly once",
      path: ["units"],
    });
  }
});

export type ReviewUnitPlanV1 = z.infer<typeof ReviewUnitPlanV1Schema>;
export type ReviewUnitPlanIdentityInputV1 = Omit<ReviewUnitPlanV1, "planDigest">;

function addDigest(value: object, digest: DigestV1): Record<string, unknown> {
  return { ...value, planDigest: digest };
}

function parseIdentityInput(value: unknown): ReviewUnitPlanIdentityInputV1 {
  const cloned = cloneCanonicalJson(value);
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) {
    throw new TypeError("review unit plan identity input must be an object");
  }
  if (Object.hasOwn(cloned, "planDigest")) {
    throw new TypeError("review unit plan identity input must not contain planDigest");
  }
  const parsed = ReviewUnitPlanV1Schema.parse(addDigest(cloned, PLACEHOLDER_DIGEST));
  const { planDigest: _digest, ...identityInput } = parsed;
  return identityInput;
}

function identityPayload(input: ReviewUnitPlanIdentityInputV1): unknown {
  const { planId: _planId, units, exclusions, ...content } = input;
  const sortCanonical = <T>(values: readonly T[]): T[] =>
    [...values].sort((left, right) => {
      const a = canonicalizeJson(left);
      const b = canonicalizeJson(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  return {
    identityProfile: "urn:independent-reviewer:identity:review-unit-plan:v1",
    plan: {
      ...content,
      units: sortCanonical(units),
      exclusions: sortCanonical(exclusions),
    },
  };
}

export function finalizeReviewUnitPlanV1(value: unknown): ReviewUnitPlanV1 {
  const input = parseIdentityInput(value);
  return ReviewUnitPlanV1Schema.parse(
    addDigest(input, digestCanonicalJson(identityPayload(input))),
  );
}

export function verifyReviewUnitPlanIdentityV1(value: unknown): value is ReviewUnitPlanV1 {
  let cloned: unknown;
  try {
    cloned = cloneCanonicalJson(value);
  } catch {
    return false;
  }
  const parsed = ReviewUnitPlanV1Schema.safeParse(cloned);
  if (!parsed.success) return false;
  const { planDigest, ...input } = parsed.data;
  return planDigest.value === digestCanonicalJson(identityPayload(input)).value;
}

export const REVIEW_UNIT_PLAN_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:review-unit-plan:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(ReviewUnitPlanV1Schema, { target: "draft-2020-12", io: "output" }),
};
