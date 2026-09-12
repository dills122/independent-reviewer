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
import { SnapshotPathV1Schema } from "./snapshot-manifest.js";
import { parseStrictJsonV1, StrictJsonErrorV1 } from "./strict-json.js";

export const MAX_EXTERNAL_JSON_BYTES_V1 = 8 * 1024 * 1024;

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

export const StandardsReferenceV2Schema = z.strictObject({
  id: prefixedIdentifier("reference"),
  path: SnapshotPathV1Schema,
  purpose: NonEmptyTextSchema,
  /** Patched reference text cannot authorize itself. */
  authority: z.literal("BASE"),
});

export const StandardsReferenceBindingV2Schema = z.strictObject({
  ruleId: prefixedIdentifier("rule"),
  referenceId: prefixedIdentifier("reference"),
  required: z.boolean(),
});

export const StandardsProfileV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    name: NonEmptyTextSchema,
    source: NonEmptyTextSchema,
    rules: z.array(StandardsRuleV1Schema).min(1),
    references: z.array(StandardsReferenceV2Schema),
    referenceBindings: z.array(StandardsReferenceBindingV2Schema),
  })
  .superRefine((profile, context) => {
    const ruleIds = new Set(profile.rules.map((rule) => rule.id));
    const referenceIds = new Set(profile.references.map((reference) => reference.id));
    if (ruleIds.size !== profile.rules.length)
      context.addIssue({ code: "custom", message: "Standard rule identifiers must be unique." });
    if (referenceIds.size !== profile.references.length)
      context.addIssue({
        code: "custom",
        message: "Standard reference identifiers must be unique.",
      });
    const bindings = new Set<string>();
    profile.referenceBindings.forEach((binding, index) => {
      if (!ruleIds.has(binding.ruleId))
        context.addIssue({
          code: "custom",
          path: ["referenceBindings", index, "ruleId"],
          message: "Binding must identify a rule in this profile.",
        });
      if (!referenceIds.has(binding.referenceId))
        context.addIssue({
          code: "custom",
          path: ["referenceBindings", index, "referenceId"],
          message: "Binding must identify a reference in this profile.",
        });
      const identity = `${binding.ruleId}\0${binding.referenceId}`;
      if (bindings.has(identity))
        context.addIssue({
          code: "custom",
          path: ["referenceBindings", index],
          message: "Rule/reference bindings must be unique.",
        });
      bindings.add(identity);
    });
    profile.references.forEach((reference, index) => {
      if (!profile.referenceBindings.some(({ referenceId }) => referenceId === reference.id))
        context.addIssue({
          code: "custom",
          path: ["references", index, "id"],
          message: "Every reference must be bound to at least one rule.",
        });
    });
  });
export const StandardsProfileSchema = z.union([StandardsProfileV1Schema, StandardsProfileV2Schema]);
export type StandardsProfile = z.infer<typeof StandardsProfileSchema>;

/** Standards are genuine project-guidance documents, bound by the existing input digest. */
export const StandardsCanonicalInputsV2Schema = z
  .strictObject({
    standards: z.array(ProjectGuidanceInputV1Schema).min(1),
  })
  .superRefine((inputs, context) => {
    const ids = new Set<string>();
    const parsedProfiles: Array<{
      index: number;
      inputId: string;
      profile: StandardsProfile;
    }> = [];
    for (const [index, input] of inputs.standards.entries()) {
      if (ids.has(input.id))
        context.addIssue({ code: "custom", message: "Standard input identifiers must be unique." });
      ids.add(input.id);

      let decoded: unknown;
      try {
        decoded = parseStrictJsonV1(input.content, {
          maxBytes: MAX_EXTERNAL_JSON_BYTES_V1,
          source: `standards profile input ${index}`,
        });
      } catch (error) {
        if (!(error instanceof StrictJsonErrorV1)) throw error;
        context.addIssue({
          code: "custom",
          path: ["standards", index, "content"],
          message: `Standard content is invalid JSON: ${error.message}.`,
        });
        continue;
      }

      const schemaVersion =
        typeof decoded === "object" && decoded !== null && "schemaVersion" in decoded
          ? decoded.schemaVersion
          : undefined;
      const parsed =
        schemaVersion === 1
          ? StandardsProfileV1Schema.safeParse(decoded)
          : schemaVersion === 2
            ? StandardsProfileV2Schema.safeParse(decoded)
            : StandardsProfileSchema.safeParse(decoded);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({
            code: "custom",
            path: ["standards", index, "content", ...issue.path],
            message: `Standard profile is invalid: ${issue.message}`,
          });
        }
        continue;
      }
      parsedProfiles.push({ index, inputId: input.id, profile: parsed.data });
    }

    const ruleDefinitions = new Map<string, { inputId: string; index: number }>();
    const referenceDefinitions = new Map<string, { inputId: string; index: number }>();
    for (const entry of parsedProfiles) {
      const conflicts: Array<{
        kind: "rule" | "reference";
        id: string;
        first: {
          inputId: string;
          index: number;
        };
      }> = [];
      for (const rule of entry.profile.rules) {
        const first = ruleDefinitions.get(rule.id);
        if (first) conflicts.push({ kind: "rule", id: rule.id, first });
      }
      if (entry.profile.schemaVersion === 2) {
        for (const reference of entry.profile.references) {
          const first = referenceDefinitions.get(reference.id);
          if (first) conflicts.push({ kind: "reference", id: reference.id, first });
        }
      }
      if (conflicts.length > 0) {
        for (const conflict of conflicts) {
          context.addIssue({
            code: "custom",
            path: ["standards", entry.index, "content"],
            message: `Standard ${conflict.kind} ${conflict.id} is already defined by input ${conflict.first.inputId} at index ${conflict.first.index}; select one definition explicitly.`,
          });
        }
        continue;
      }
      for (const rule of entry.profile.rules) {
        ruleDefinitions.set(rule.id, { inputId: entry.inputId, index: entry.index });
      }
      if (entry.profile.schemaVersion === 2) {
        for (const reference of entry.profile.references) {
          referenceDefinitions.set(reference.id, { inputId: entry.inputId, index: entry.index });
        }
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
    // Request validation already strictly parsed and validated this digest-bound content.
    const profile = StandardsProfileSchema.parse(JSON.parse(input.content));
    return profile.rules.map((rule) => ({
      ...rule,
      source: profile.source,
      canonicalInputId: input.id,
    }));
  });
}

export function selectedReferences(inputs: z.infer<typeof StandardsCanonicalInputsV2Schema>) {
  return inputs.standards.flatMap((input) => {
    // Request validation already strictly parsed and validated this digest-bound content.
    const profile = StandardsProfileSchema.parse(JSON.parse(input.content));
    if (profile.schemaVersion === 1) return [];
    const rules = new Map(profile.rules.map((rule) => [rule.id, rule]));
    const bindingsByReference = new Map<
      string,
      Array<{ ruleId: string; required: boolean; paths: string[] }>
    >();
    for (const binding of profile.referenceBindings) {
      const rule = rules.get(binding.ruleId);
      if (!rule) throw new Error(`Validated standards binding lost rule ${binding.ruleId}.`);
      const bindings = bindingsByReference.get(binding.referenceId) ?? [];
      bindings.push({ ruleId: binding.ruleId, required: binding.required, paths: rule.paths });
      bindingsByReference.set(binding.referenceId, bindings);
    }
    return profile.references.map((reference) => ({
      ...reference,
      canonicalInputId: input.id,
      bindings: bindingsByReference.get(reference.id) ?? [],
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
export const STANDARDS_PROFILE_V2_JSON_SCHEMA = contractJsonSchema(
  StandardsProfileV2Schema,
  "standards-profile:v2",
);
export const STANDARDS_REVIEW_REQUEST_V2_JSON_SCHEMA = contractJsonSchema(
  StandardsReviewRequestV2Schema,
  "standards-review-request:v2",
);
