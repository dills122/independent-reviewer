import * as z from "zod";
import { canonicalizeJson, cloneCanonicalJson, digestCanonicalJson } from "./canonical-json.js";
import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import {
  CanonicalInputIdSchema,
  ClaimTextV1Schema,
  compareUtf16,
  prefixedIdentifier,
} from "./primitives.js";
import { ReviewEvidenceAnchorV1Schema } from "./review-results.js";
import { DigestV1Schema } from "./snapshot-manifest.js";

/** Set order is part of the wire contract, not a best-effort normalization. */
function canonicalSet<T extends z.ZodType>(entry: T) {
  return z
    .array(entry)
    .max(1024)
    .superRefine((values, context) => {
      const keys = values.map((value) => canonicalizeJson(value));
      for (let index = 1; index < keys.length; index++) {
        if (compareUtf16(keys[index - 1] ?? "", keys[index] ?? "") >= 0) {
          context.addIssue({
            code: "custom",
            message: "must be unique and canonically sorted",
            path: [index],
          });
        }
      }
    });
}

export const ReviewClaimIdV1Schema = prefixedIdentifier("claim").regex(/^claim_[0-9a-f]{64}$/);
const RuleIdSchema = prefixedIdentifier("rule");
const ObligationReferenceV1Schema = z.strictObject({
  canonicalInputId: CanonicalInputIdSchema,
  ruleId: RuleIdSchema.nullable(),
});
const ClaimScenarioV1Schema = z.strictObject({
  preconditions: ClaimTextV1Schema,
  action: ClaimTextV1Schema,
  observedResult: ClaimTextV1Schema,
  expectedResult: ClaimTextV1Schema,
});
const ClaimEffectV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("REQUIREMENTS"), severity: z.enum(["P0", "P1", "P2", "P3"]) }),
  z.strictObject({
    kind: z.literal("STANDARDS"),
    enforcement: z.enum(["REQUIRED", "RECOMMENDED"]),
  }),
  z.strictObject({ kind: z.literal("BLOCKING_UNCERTAINTY") }),
  z.strictObject({
    kind: z.literal("STANDARD_STATUS"),
    ruleId: RuleIdSchema,
    status: z.enum(["CONFLICT", "UNASSESSED"]),
    conflictingRuleIds: canonicalSet(RuleIdSchema),
  }),
]);

export const ReviewClaimCoreV1Schema = z
  .strictObject({
    mode: z.enum(["REQUIREMENTS", "STANDARDS"]),
    kind: z.enum(["VIOLATION", "BLOCKING_UNCERTAINTY", "STANDARD_STATUS"]),
    obligations: canonicalSet(ObligationReferenceV1Schema).refine((values) => values.length > 0),
    scenario: ClaimScenarioV1Schema.nullable(),
    evidence: canonicalSet(ReviewEvidenceAnchorV1Schema),
    assertion: ClaimTextV1Schema,
    correction: ClaimTextV1Schema.nullable(),
    effect: ClaimEffectV1Schema,
  })
  .superRefine((core, context) => {
    const fail = (message: string) => context.addIssue({ code: "custom", message });
    if (core.kind === "VIOLATION") {
      if (
        core.effect.kind !== core.mode ||
        core.scenario === null ||
        core.correction === null ||
        core.evidence.length === 0
      ) {
        fail("violation requires mode-compatible effect, scenario, evidence and correction");
      }
    } else {
      if (core.scenario !== null || core.correction !== null || core.effect.kind !== core.kind) {
        fail("non-violation requires matching effect and no scenario or correction");
      }
    }
    if (core.kind === "STANDARD_STATUS" && core.mode !== "STANDARDS")
      fail("standard status requires standards mode");
    if (core.mode === "REQUIREMENTS" && core.obligations.some((item) => item.ruleId !== null))
      fail("requirements obligations cannot cite selected standards rules");
    if (core.mode === "STANDARDS" && core.obligations.some((item) => item.ruleId === null))
      fail("standards obligations must cite selected rules");
    if (core.effect.kind === "STANDARD_STATUS") {
      const effect = core.effect;
      if (!core.obligations.some((item) => item.ruleId === effect.ruleId))
        fail("rule state must name a cited obligation");
      if (effect.conflictingRuleIds.includes(effect.ruleId))
        fail("a rule cannot conflict with itself");
      if ((effect.status === "CONFLICT") !== effect.conflictingRuleIds.length > 0)
        fail("only conflict status requires conflicting rules");
    }
  });
export type ReviewClaimCoreV1 = z.infer<typeof ReviewClaimCoreV1Schema>;

const identityBinding = { snapshotDigest: DigestV1Schema, briefDigest: DigestV1Schema };
const ClaimBindingV1Schema = z.strictObject(identityBinding);
export type ClaimBindingV1 = z.infer<typeof ClaimBindingV1Schema>;
export const ClaimIdentityPreimageV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  type: z.literal("REVIEW_CLAIM_IDENTITY"),
  ...identityBinding,
  claimCore: ReviewClaimCoreV1Schema,
});
export const IdentifiedReviewClaimV1Schema = z.strictObject({
  claimId: ReviewClaimIdV1Schema,
  core: ReviewClaimCoreV1Schema,
});
export type IdentifiedReviewClaimV1 = z.infer<typeof IdentifiedReviewClaimV1Schema>;

export function identifyReviewClaimV1(
  binding: ClaimBindingV1,
  value: unknown,
): IdentifiedReviewClaimV1 {
  const preimage = ClaimIdentityPreimageV1Schema.parse(
    cloneCanonicalJson({
      schemaVersion: 1,
      type: "REVIEW_CLAIM_IDENTITY",
      ...ClaimBindingV1Schema.parse(cloneCanonicalJson(binding)),
      claimCore: value,
    }),
  );
  return { claimId: `claim_${digestCanonicalJson(preimage).value}`, core: preimage.claimCore };
}

export const ReviewClaimSetV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    ...identityBinding,
    claims: z.array(IdentifiedReviewClaimV1Schema).max(1024),
  })
  .superRefine((set, context) => {
    let previous = "";
    for (const [index, claim] of set.claims.entries()) {
      if (
        compareUtf16(previous, claim.claimId) >= 0 ||
        identifyReviewClaimV1(
          { snapshotDigest: set.snapshotDigest, briefDigest: set.briefDigest },
          claim.core,
        ).claimId !== claim.claimId
      ) {
        context.addIssue({
          code: "custom",
          message: "claim identity/order mismatch",
          path: ["claims", index],
        });
      }
      previous = claim.claimId;
    }
  });
export type ReviewClaimSetV1 = z.infer<typeof ReviewClaimSetV1Schema>;

export function assembleReviewClaimSetV1(
  binding: ClaimBindingV1,
  cores: unknown[],
): ReviewClaimSetV1 {
  const validatedBinding = ClaimBindingV1Schema.parse(cloneCanonicalJson(binding));
  const claims = cores
    .map((core) => identifyReviewClaimV1(validatedBinding, core))
    .sort((left, right) => compareUtf16(left.claimId, right.claimId));
  return ReviewClaimSetV1Schema.parse({ schemaVersion: 1, ...validatedBinding, claims });
}

export const REVIEW_CLAIM_SET_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:review-claim-set:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(ReviewClaimSetV1Schema, { target: "draft-2020-12", io: "output" }),
};
