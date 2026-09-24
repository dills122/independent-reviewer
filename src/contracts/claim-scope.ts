import { canonicalizeJson } from "./canonical-json.js";
import type { ReviewBrief } from "./neutral-review-brief.js";
import { type ReviewClaimSetV1, ReviewClaimSetV1Schema } from "./review-claims.js";
import { selectedRules } from "./standards-review.js";

/** Frozen canonical input and enforcement identities are runner authority, never model choice. */
export function assertClaimScopeV1(value: ReviewClaimSetV1, brief: ReviewBrief): void {
  const set = ReviewClaimSetV1Schema.parse(value);
  const mode = brief.schemaVersion === 1 ? "REQUIREMENTS" : "STANDARDS";
  if (
    canonicalizeJson([set.snapshotDigest, set.briefDigest]) !==
    canonicalizeJson([brief.snapshotManifest.snapshotDigest, brief.briefDigest])
  )
    throw new Error("Claim scope binding mismatch");
  const canonicalIds = new Set(brief.snapshotManifest.canonicalInputs.map((entry) => entry.id));
  const owners = new Map<string, { inputId: string; enforcement: "REQUIRED" | "RECOMMENDED" }>();
  if (brief.schemaVersion !== 1)
    for (const input of brief.canonicalInputs.standards)
      for (const rule of selectedRules({ standards: [input] }))
        owners.set(rule.id, { inputId: input.id, enforcement: rule.enforcement });
  for (const { core } of set.claims) {
    if (core.mode !== mode) throw new Error("Claim scope mode mismatch");
    for (const ref of core.obligations) {
      if (
        !canonicalIds.has(ref.canonicalInputId) ||
        (ref.ruleId !== null && owners.get(ref.ruleId)?.inputId !== ref.canonicalInputId)
      )
        throw new Error("Claim cites an unknown canonical obligation");
    }
    if (core.effect.kind === "STANDARDS") {
      const enforcement = core.obligations.some(
        (ref) => ref.ruleId !== null && owners.get(ref.ruleId)?.enforcement === "REQUIRED",
      )
        ? "REQUIRED"
        : "RECOMMENDED";
      if (core.effect.enforcement !== enforcement)
        throw new Error("Claim enforcement differs from selected canonical rules");
    }
    if (
      core.effect.kind === "STANDARD_STATUS" &&
      core.effect.conflictingRuleIds.some((id) => !owners.has(id))
    )
      throw new Error("Claim cites an unknown conflicting rule");
  }
}
