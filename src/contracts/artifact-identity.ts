import { canonicalizeJson, cloneCanonicalJson, digestCanonicalJson } from "./canonical-json.js";
import {
  type NeutralReviewBriefV1,
  NeutralReviewBriefV1Schema,
  type ReviewBrief,
  ReviewBriefSchema,
  StandardsReviewBriefV2Schema,
  StandardsReviewBriefV3Schema,
} from "./neutral-review-brief.js";
import { compareUtf16 } from "./primitives.js";
import {
  type DigestV1,
  type SnapshotManifestV1,
  SnapshotManifestV1Schema,
} from "./snapshot-manifest.js";

export type SnapshotManifestIdentityInputV1 = Omit<SnapshotManifestV1, "snapshotDigest">;
export type NeutralReviewBriefIdentityInputV1 = Omit<NeutralReviewBriefV1, "briefDigest">;

const PLACEHOLDER_DIGEST: DigestV1 = {
  algorithm: "SHA256",
  value: "0".repeat(64),
};

/** Ascending lexicographic comparison of ECMAScript UTF-16 code units. */
/** Orders a set entry by its complete RFC 8785 canonical JSON serialization. */
function compareCanonicalJsonUtf16(left: unknown, right: unknown): number {
  const serializedLeft = canonicalizeJson(left);
  const serializedRight = canonicalizeJson(right);
  return compareUtf16(serializedLeft, serializedRight);
}

function addOwnField(
  value: object,
  key: "briefDigest" | "snapshotDigest",
  fieldValue: DigestV1,
): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>;
  Object.assign(result, value);
  Object.defineProperty(result, key, {
    configurable: true,
    enumerable: true,
    value: fieldValue,
    writable: true,
  });
  return result;
}

function parseSnapshotIdentityInput(value: unknown): SnapshotManifestIdentityInputV1 {
  const canonicalValue = cloneCanonicalJson(value);
  if (!canonicalValue || typeof canonicalValue !== "object" || Array.isArray(canonicalValue)) {
    throw new TypeError("snapshot identity input must be an object");
  }
  if (Object.hasOwn(canonicalValue, "snapshotDigest")) {
    throw new TypeError("snapshot identity input must not contain snapshotDigest");
  }

  const parsed = SnapshotManifestV1Schema.parse(
    addOwnField(canonicalValue, "snapshotDigest", PLACEHOLDER_DIGEST),
  );
  const { snapshotDigest: _snapshotDigest, ...identityInput } = parsed;
  return identityInput;
}

function snapshotIdentityPayload(input: SnapshotManifestIdentityInputV1): unknown {
  const {
    snapshotId: _snapshotId,
    flowId: _flowId,
    reviewInstance: _reviewInstance,
    raceCheck,
    ...logicalSnapshot
  } = input;

  return {
    identityProfile: "urn:independent-reviewer:identity:snapshot-manifest:v1",
    snapshot: {
      ...logicalSnapshot,
      workingTree: {
        ...logicalSnapshot.workingTree,
        includedUntrackedPaths: [...logicalSnapshot.workingTree.includedUntrackedPaths].sort(
          compareUtf16,
        ),
      },
      paths: [...logicalSnapshot.paths].sort(compareCanonicalJsonUtf16),
      exclusions: [...logicalSnapshot.exclusions].sort(compareCanonicalJsonUtf16),
      omissions: [...logicalSnapshot.omissions].sort(compareCanonicalJsonUtf16),
      canonicalInputs: [...logicalSnapshot.canonicalInputs].sort(compareCanonicalJsonUtf16),
      captureState: {
        status: raceCheck.status,
        beforeStateDigest: raceCheck.beforeStateDigest,
        afterStateDigest: raceCheck.afterStateDigest,
      },
    },
  };
}

function computeParsedSnapshotDigest(input: SnapshotManifestIdentityInputV1): DigestV1 {
  return digestCanonicalJson(snapshotIdentityPayload(input));
}

/**
 * Computes the logical snapshot digest after strict input validation.
 *
 * Opaque artifact/run IDs and capture-attempt count are excluded. Set-like
 * ledgers are sorted by the identity profile before RFC 8785 canonicalization.
 */
export function computeSnapshotManifestDigestV1(value: unknown): DigestV1 {
  return computeParsedSnapshotDigest(parseSnapshotIdentityInput(value));
}

/** Validates draft material, computes its digest, and returns a complete manifest. */
export function finalizeSnapshotManifestV1(value: unknown): SnapshotManifestV1 {
  const identityInput = parseSnapshotIdentityInput(value);
  const candidate = addOwnField(
    cloneCanonicalJson(identityInput) as object,
    "snapshotDigest",
    computeParsedSnapshotDigest(identityInput),
  );
  return SnapshotManifestV1Schema.parse(candidate);
}

/** Returns true only for a schema-valid manifest whose logical digest matches. */
export function verifySnapshotManifestIdentityV1(value: unknown): value is SnapshotManifestV1 {
  let canonicalValue: unknown;
  try {
    canonicalValue = cloneCanonicalJson(value);
  } catch {
    return false;
  }
  const parsed = SnapshotManifestV1Schema.safeParse(canonicalValue);
  if (!parsed.success) {
    return false;
  }

  const { snapshotDigest, ...identityInput } = parsed.data;
  return snapshotDigest.value === computeParsedSnapshotDigest(identityInput).value;
}

function parseNeutralBriefIdentityInput(value: unknown): NeutralReviewBriefIdentityInputV1 {
  const canonicalValue = cloneCanonicalJson(value);
  if (!canonicalValue || typeof canonicalValue !== "object" || Array.isArray(canonicalValue)) {
    throw new TypeError("neutral brief identity input must be an object");
  }
  if (Object.hasOwn(canonicalValue, "briefDigest")) {
    throw new TypeError("neutral brief identity input must not contain briefDigest");
  }

  const parsed = NeutralReviewBriefV1Schema.parse(
    addOwnField(canonicalValue, "briefDigest", PLACEHOLDER_DIGEST),
  );
  const { briefDigest: _briefDigest, ...identityInput } = parsed;
  return identityInput;
}

function neutralBriefIdentityPayload(input: NeutralReviewBriefIdentityInputV1): unknown {
  const { briefId: _briefId, ...blindContent } = input;
  return {
    identityProfile: "urn:independent-reviewer:identity:neutral-review-brief:v1",
    neutralReviewBrief: blindContent,
  };
}

function computeParsedNeutralBriefDigest(input: NeutralReviewBriefIdentityInputV1): DigestV1 {
  return digestCanonicalJson(neutralBriefIdentityPayload(input));
}

/** Computes the exact blind-stage content digest after strict input validation. */
export function computeNeutralReviewBriefDigestV1(value: unknown): DigestV1 {
  const identityInput = parseNeutralBriefIdentityInput(value);
  if (!verifySnapshotManifestIdentityV1(identityInput.snapshotManifest)) {
    throw new TypeError("neutral brief contains an invalid snapshot identity");
  }
  return computeParsedNeutralBriefDigest(identityInput);
}

/** Validates blind-stage material and returns a complete, identity-bound brief. */
export function finalizeNeutralReviewBriefV1(value: unknown): NeutralReviewBriefV1 {
  const identityInput = parseNeutralBriefIdentityInput(value);
  if (!verifySnapshotManifestIdentityV1(identityInput.snapshotManifest)) {
    throw new TypeError("neutral brief contains an invalid snapshot identity");
  }
  const candidate = addOwnField(
    cloneCanonicalJson(identityInput) as object,
    "briefDigest",
    computeParsedNeutralBriefDigest(identityInput),
  );
  return NeutralReviewBriefV1Schema.parse(candidate);
}

/** Returns true only when both the brief and its embedded snapshot identities match. */
export function verifyNeutralReviewBriefIdentityV1(value: unknown): value is NeutralReviewBriefV1 {
  let canonicalValue: unknown;
  try {
    canonicalValue = cloneCanonicalJson(value);
  } catch {
    return false;
  }
  const parsed = NeutralReviewBriefV1Schema.safeParse(canonicalValue);
  if (!parsed.success || !verifySnapshotManifestIdentityV1(parsed.data.snapshotManifest)) {
    return false;
  }

  const { briefDigest, ...identityInput } = parsed.data;
  return briefDigest.value === computeParsedNeutralBriefDigest(identityInput).value;
}

/** Standards briefs have a separate identity profile; legacy v1 identities are unchanged. */
export function finalizeReviewBrief(value: unknown): ReviewBrief {
  const cloned = cloneCanonicalJson(value);
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned))
    throw new TypeError("Brief must be an object.");
  const schemaVersion = (cloned as Record<string, unknown>).schemaVersion;
  if (schemaVersion === 1) return finalizeNeutralReviewBriefV1(cloned);
  if (schemaVersion !== 2 && schemaVersion !== 3)
    throw new TypeError("Unsupported brief schema version.");
  if (Object.hasOwn(cloned, "briefDigest"))
    throw new TypeError("Brief draft must not contain briefDigest.");
  const parsed =
    schemaVersion === 2
      ? StandardsReviewBriefV2Schema.parse(addOwnField(cloned, "briefDigest", PLACEHOLDER_DIGEST))
      : StandardsReviewBriefV3Schema.parse(addOwnField(cloned, "briefDigest", PLACEHOLDER_DIGEST));
  if (!verifySnapshotManifestIdentityV1(parsed.snapshotManifest))
    throw new TypeError("Invalid snapshot identity.");
  const { briefId: _id, briefDigest: _digest, ...content } = parsed;
  return {
    ...parsed,
    briefDigest: digestCanonicalJson({
      identityProfile: `urn:independent-reviewer:identity:standards-brief:v${schemaVersion}`,
      content,
    }),
  };
}
export function verifyReviewBriefIdentity(value: unknown): value is ReviewBrief {
  try {
    const cloned = cloneCanonicalJson(value);
    if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) return false;
    if ((cloned as Record<string, unknown>).schemaVersion === 1)
      return verifyNeutralReviewBriefIdentityV1(cloned);
    const parsed = ReviewBriefSchema.parse(cloned);
    if (parsed.schemaVersion === 1) return false;
    const { briefDigest, ...draft } = parsed;
    return finalizeReviewBrief(draft).briefDigest.value === briefDigest.value;
  } catch {
    return false;
  }
}
