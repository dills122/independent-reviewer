import { canonicalizeJson, digestCanonicalJson } from "./canonical-json.js";
import { type CanonicalInputV1, CanonicalInputV1Schema } from "./review-request.js";
import type { DigestV1 } from "./snapshot-manifest.js";

/**
 * Computes the identity recorded for one canonical review input.
 *
 * The complete validated input is bound so title, content, provenance, kind,
 * and ID cannot drift independently of the manifest ledger.
 */
export function computeCanonicalInputDigestV1(value: unknown): DigestV1 {
  canonicalizeJson(value);
  const input: CanonicalInputV1 = CanonicalInputV1Schema.parse(value);
  return digestCanonicalJson({
    identityProfile: "urn:independent-reviewer:identity:canonical-input:v1",
    canonicalInput: input,
  });
}
