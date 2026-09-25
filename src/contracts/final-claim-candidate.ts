import * as z from "zod";
import { canonicalizeJson, cloneCanonicalJson } from "./canonical-json.js";
import { compareUtf16 } from "./primitives.js";
import {
  assembleReviewClaimSetV1,
  ReviewClaimCoreV1Schema,
  ReviewClaimIdV1Schema,
  type ReviewClaimSetV1,
  ReviewClaimSetV1Schema,
} from "./review-claims.js";
import { DigestV1Schema } from "./snapshot-manifest.js";
import { contractJsonSchema } from "./standards-review.js";

const orderedIds = z
  .array(ReviewClaimIdV1Schema)
  .max(1024)
  .refine(
    (ids) => ids.every((id, index) => index === 0 || compareUtf16(ids[index - 1] ?? "", id) < 0),
    "claim IDs must be sorted and unique",
  );
export const ClaimTransitionProposalV1Schema = z.strictObject({
  continuedClaimIds: orderedIds,
  withdrawnClaimIds: orderedIds,
  newClaims: z.array(ReviewClaimCoreV1Schema).max(1024),
});
export type ClaimTransitionProposalV1 = z.infer<typeof ClaimTransitionProposalV1Schema>;
export const FinalClaimCandidateV4Schema = ClaimTransitionProposalV1Schema.extend({
  schemaVersion: z.literal(4),
  stage: z.literal("FINAL"),
  mode: z.enum(["REQUIREMENTS", "STANDARDS"]),
  snapshotDigest: DigestV1Schema,
  briefDigest: DigestV1Schema,
});
export type FinalClaimCandidateV4 = z.infer<typeof FinalClaimCandidateV4Schema>;

export function assembleFinalClaimCandidateV4(
  priorValue: ReviewClaimSetV1,
  value: unknown,
): FinalClaimCandidateV4 {
  const prior = ReviewClaimSetV1Schema.parse(cloneCanonicalJson(priorValue));
  const candidate = FinalClaimCandidateV4Schema.parse(cloneCanonicalJson(value));
  if (
    canonicalizeJson([prior.snapshotDigest, prior.briefDigest]) !==
    canonicalizeJson([candidate.snapshotDigest, candidate.briefDigest])
  )
    throw new Error("Final claim candidate binding mismatch");
  const mentioned = [...candidate.continuedClaimIds, ...candidate.withdrawnClaimIds];
  const ids = new Set(prior.claims.map((claim) => claim.claimId));
  if (
    mentioned.length !== ids.size ||
    new Set(mentioned).size !== mentioned.length ||
    mentioned.some((id) => !ids.has(id))
  )
    throw new Error("Every prior claim requires exactly one transition");
  const additions = assembleReviewClaimSetV1(
    { snapshotDigest: prior.snapshotDigest, briefDigest: prior.briefDigest },
    candidate.newClaims,
  );
  if (additions.claims.some((claim) => ids.has(claim.claimId)))
    throw new Error("Prior claim identity cannot be introduced as new");
  if ([...prior.claims, ...additions.claims].some((claim) => claim.core.mode !== candidate.mode))
    throw new Error("Final claim candidate mode mismatch");
  return candidate;
}

export const FINAL_CLAIM_CANDIDATE_V4_JSON_SCHEMA = contractJsonSchema(
  FinalClaimCandidateV4Schema,
  "final-claim-candidate:v4",
);
