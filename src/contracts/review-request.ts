import * as z from "zod";

import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";

function prefixedIdentifier(prefix: "config" | "flow" | "input"): z.ZodString {
  return z
    .string()
    .min(prefix.length + 2)
    .max(128)
    .regex(
      new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]*$`),
      `must use the ${prefix}_ identifier prefix`,
    );
}

const ConfigReferenceSchema = prefixedIdentifier("config");
export const FlowIdSchema = prefixedIdentifier("flow");
const InputIdSchema = prefixedIdentifier("input");

const NonEmptyTextSchema = z.string().min(1);
const LocalPathSchema = NonEmptyTextSchema.refine(
  (value) => !value.includes("\0"),
  "must not contain a NUL byte",
);
const GitRefSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.includes("\0") && !value.includes("\n"), {
    message: "must not contain NUL or newline characters",
  });

export const CanonicalInputProvenanceV1Schema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("REPOSITORY_FILE"),
    path: LocalPathSchema,
    revision: NonEmptyTextSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("INLINE"),
    label: NonEmptyTextSchema,
  }),
]);

const CanonicalInputBaseShape = {
  id: InputIdSchema,
  title: NonEmptyTextSchema,
  content: NonEmptyTextSchema,
  provenance: CanonicalInputProvenanceV1Schema,
};

export const RequirementsInputV1Schema = z.strictObject({
  ...CanonicalInputBaseShape,
  kind: z.literal("REQUIREMENTS"),
});

export const ImplementationPlanInputV1Schema = z.strictObject({
  ...CanonicalInputBaseShape,
  kind: z.literal("IMPLEMENTATION_PLAN"),
});

export const ProjectGuidanceInputV1Schema = z.strictObject({
  ...CanonicalInputBaseShape,
  kind: z.literal("PROJECT_GUIDANCE"),
});

export const CanonicalInputV1Schema = z.discriminatedUnion("kind", [
  RequirementsInputV1Schema,
  ImplementationPlanInputV1Schema,
  ProjectGuidanceInputV1Schema,
]);

const CanonicalInputsBaseV1Schema = z.strictObject({
  requirements: z.array(RequirementsInputV1Schema).min(1),
  implementationPlan: ImplementationPlanInputV1Schema,
  projectGuidance: z.array(ProjectGuidanceInputV1Schema),
});

function requireUniqueCanonicalInputIds(
  inputs: z.infer<typeof CanonicalInputsBaseV1Schema>,
  context: z.RefinementCtx,
): void {
  const ids = [
    ...inputs.requirements.map((input) => input.id),
    inputs.implementationPlan.id,
    ...inputs.projectGuidance.map((input) => input.id),
  ];
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: "custom",
      message: "canonical input identifiers must be unique",
    });
  }
}

/** Caller-input contract: omitted project guidance materializes as an empty ledger. */
export const CanonicalInputsV1Schema = CanonicalInputsBaseV1Schema.extend({
  projectGuidance: z.array(ProjectGuidanceInputV1Schema).default([]),
}).superRefine(requireUniqueCanonicalInputIds);

/** Persisted-artifact contract: every identity-bound ledger must be explicit. */
export const PersistedCanonicalInputsV1Schema = CanonicalInputsBaseV1Schema.superRefine(
  requireUniqueCanonicalInputIds,
);

export const AuthorPacketV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  intent: NonEmptyTextSchema,
  successCriteria: z.array(NonEmptyTextSchema).min(1),
  planTraceability: z.array(
    z.strictObject({
      planItem: NonEmptyTextSchema,
      implementation: NonEmptyTextSchema,
    }),
  ),
  technicalApproach: NonEmptyTextSchema,
  componentWalkthrough: z.array(
    z.strictObject({
      component: NonEmptyTextSchema,
      changes: NonEmptyTextSchema,
    }),
  ),
  decisions: z.array(
    z.strictObject({
      decision: NonEmptyTextSchema,
      rationale: NonEmptyTextSchema,
      alternatives: z.array(NonEmptyTextSchema),
    }),
  ),
  invariants: z.array(NonEmptyTextSchema),
  claimedVerification: z.array(
    z.strictObject({
      command: NonEmptyTextSchema,
      outcome: z.enum(["PASSED", "FAILED", "PARTIAL", "NOT_RUN"]),
      summary: NonEmptyTextSchema,
    }),
  ),
  risks: z.array(NonEmptyTextSchema),
  knownGaps: z.array(NonEmptyTextSchema),
  challengePoints: z.array(NonEmptyTextSchema),
});

const ReviewInstanceBaseV1Schema = z.strictObject({
  number: z.int().min(1),
  maximum: z.int().min(1).max(3),
});

function requireReviewInstanceWithinMaximum(
  instance: z.infer<typeof ReviewInstanceBaseV1Schema>,
  context: z.RefinementCtx,
): void {
  if (instance.number > instance.maximum) {
    context.addIssue({
      code: "custom",
      message: "must not exceed the declared review-instance maximum",
      path: ["number"],
    });
  }
}

/** Caller-input contract: omitted maximum materializes to the protocol default. */
export const ReviewInstanceV1Schema = ReviewInstanceBaseV1Schema.extend({
  maximum: z.int().min(1).max(3).default(3),
}).superRefine(requireReviewInstanceWithinMaximum);

/** Persisted-artifact contract: the review-instance limit must be explicit. */
export const PersistedReviewInstanceV1Schema = ReviewInstanceBaseV1Schema.superRefine(
  requireReviewInstanceWithinMaximum,
);

const WorkingTreeInclusionV1Schema = z
  .strictObject({
    mode: z.literal("CUMULATIVE").default("CUMULATIVE"),
    includeUntracked: z.boolean().default(true),
  })
  .default({
    mode: "CUMULATIVE",
    includeUntracked: true,
  });

export const ReviewRequestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  flowId: FlowIdSchema,
  reviewInstance: ReviewInstanceV1Schema,
  repository: z.strictObject({
    path: LocalPathSchema,
    base: GitRefSchema.optional(),
    head: GitRefSchema.optional(),
    workingTree: WorkingTreeInclusionV1Schema,
  }),
  canonicalInputs: CanonicalInputsV1Schema,
  authorPacket: AuthorPacketV1Schema.optional(),
  reviewConfigRef: ConfigReferenceSchema,
});

export type AuthorPacketV1 = z.infer<typeof AuthorPacketV1Schema>;
export type CanonicalInputV1 = z.infer<typeof CanonicalInputV1Schema>;
export type ReviewRequestV1 = z.infer<typeof ReviewRequestV1Schema>;

export const REVIEW_REQUEST_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:review-request:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(ReviewRequestV1Schema, {
    target: "draft-2020-12",
    io: "input",
  }),
};
