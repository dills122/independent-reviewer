import * as z from "zod";
import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import { NonEmptyTextSchema, prefixedIdentifier } from "./primitives.js";
import {
  AuthorPacketV1Schema,
  type CanonicalInputV1,
  PersistedCanonicalInputsV1Schema,
  ProjectGuidanceInputV1Schema,
  ReviewRequestV1Schema,
} from "./review-request.js";

export const StandardsRuleV1Schema = z.strictObject({
  id: prefixedIdentifier("rule"),
  text: NonEmptyTextSchema,
  enforcement: z.enum(["REQUIRED", "RECOMMENDED"]),
  paths: z.array(NonEmptyTextSchema).min(1),
  exceptions: NonEmptyTextSchema.nullable(),
});
export const StandardsProfileV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    name: NonEmptyTextSchema,
    source: NonEmptyTextSchema,
    rules: z.array(StandardsRuleV1Schema).min(1),
  })
  .superRefine((profile, context) => {
    if (new Set(profile.rules.map((rule) => rule.id)).size !== profile.rules.length)
      context.addIssue({ code: "custom", message: "Standard rule identifiers must be unique." });
  });
export type StandardsProfileV1 = z.infer<typeof StandardsProfileV1Schema>;

/** Standards are genuine project-guidance documents, bound by the existing input digest. */
export const StandardsCanonicalInputsV2Schema = z
  .strictObject({
    standards: z.array(ProjectGuidanceInputV1Schema).min(1),
  })
  .superRefine((inputs, context) => {
    const ids = new Set<string>();
    const ruleIds = new Set<string>();
    for (const [index, input] of inputs.standards.entries()) {
      if (ids.has(input.id))
        context.addIssue({ code: "custom", message: "Standard input identifiers must be unique." });
      ids.add(input.id);
      try {
        const profile = StandardsProfileV1Schema.parse(JSON.parse(input.content));
        for (const rule of profile.rules) {
          if (ruleIds.has(rule.id))
            throw new Error(
              `Conflicting standard rule ${rule.id}; select one definition explicitly.`,
            );
          ruleIds.add(rule.id);
        }
      } catch {
        context.addIssue({
          code: "custom",
          path: ["standards", index, "content"],
          message:
            "Standard content must be a valid profile with globally unique rule identifiers.",
        });
      }
    }
  });
export const AuthorOverviewV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  overview: NonEmptyTextSchema,
  claimedVerification: AuthorPacketV1Schema.shape.claimedVerification,
});
export const ReviewAuthorSchema = z.union([AuthorPacketV1Schema, AuthorOverviewV2Schema]);
export type ReviewAuthor = z.infer<typeof ReviewAuthorSchema>;
export const StandardsReviewRequestV2Schema = z.strictObject({
  ...ReviewRequestV1Schema.shape,
  schemaVersion: z.literal(2),
  mode: z.literal("STANDARDS"),
  canonicalInputs: StandardsCanonicalInputsV2Schema,
  authorPacket: ReviewAuthorSchema,
});
export const ReviewRequestSchema = z.union([ReviewRequestV1Schema, StandardsReviewRequestV2Schema]);
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;
export const ReviewCanonicalInputsSchema = z.union([
  PersistedCanonicalInputsV1Schema,
  StandardsCanonicalInputsV2Schema,
]);
export type ReviewCanonicalInputs = z.infer<typeof ReviewCanonicalInputsSchema>;
export function canonicalInputList(inputs: ReviewCanonicalInputs): CanonicalInputV1[] {
  return "standards" in inputs
    ? inputs.standards
    : [...inputs.requirements, inputs.implementationPlan, ...inputs.projectGuidance];
}
export function selectedRules(inputs: z.infer<typeof StandardsCanonicalInputsV2Schema>) {
  return inputs.standards.flatMap((input) => {
    const profile = StandardsProfileV1Schema.parse(JSON.parse(input.content));
    return profile.rules.map((rule) => ({
      ...rule,
      source: profile.source,
      canonicalInputId: input.id,
    }));
  });
}
export function contractJsonSchema(schema: z.ZodType, name: string) {
  return {
    $id: `urn:independent-reviewer:schema:${name}`,
    $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
    ...z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" }),
  };
}
export const STANDARDS_PROFILE_V1_JSON_SCHEMA = contractJsonSchema(
  StandardsProfileV1Schema,
  "standards-profile:v1",
);
export const STANDARDS_REVIEW_REQUEST_V2_JSON_SCHEMA = contractJsonSchema(
  StandardsReviewRequestV2Schema,
  "standards-review-request:v2",
);
