import { canonicalizeJson, digestCanonicalJson } from "./canonical-json.js";
import { type NeutralReviewBriefV1, NeutralReviewBriefV1Schema } from "./neutral-review-brief.js";
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

function compareCanonical(left: unknown, right: unknown): number {
  const serializedLeft = canonicalizeJson(left);
  const serializedRight = canonicalizeJson(right);
  return serializedLeft < serializedRight ? -1 : serializedLeft > serializedRight ? 1 : 0;
}

function parseSnapshotIdentityInput(value: unknown): SnapshotManifestIdentityInputV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("snapshot identity input must be an object");
  }
  canonicalizeJson(value);
  if (Object.hasOwn(value, "snapshotDigest")) {
    throw new TypeError("snapshot identity input must not contain snapshotDigest");
  }

  const parsed = SnapshotManifestV1Schema.parse({
    ...value,
    snapshotDigest: PLACEHOLDER_DIGEST,
  });
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
        includedUntrackedPaths: [...logicalSnapshot.workingTree.includedUntrackedPaths].sort(),
      },
      paths: [...logicalSnapshot.paths].sort(compareCanonical),
      exclusions: [...logicalSnapshot.exclusions].sort(compareCanonical),
      omissions: [...logicalSnapshot.omissions].sort(compareCanonical),
      canonicalInputs: [...logicalSnapshot.canonicalInputs].sort(compareCanonical),
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
 * ledgers are sorted before RFC 8785 canonicalization.
 */
export function computeSnapshotManifestDigestV1(value: unknown): DigestV1 {
  return computeParsedSnapshotDigest(parseSnapshotIdentityInput(value));
}

/** Validates draft material, computes its digest, and returns a complete manifest. */
export function finalizeSnapshotManifestV1(value: unknown): SnapshotManifestV1 {
  const identityInput = parseSnapshotIdentityInput(value);
  return SnapshotManifestV1Schema.parse({
    ...identityInput,
    snapshotDigest: computeParsedSnapshotDigest(identityInput),
  });
}

/** Returns true only for a schema-valid manifest whose logical digest matches. */
export function verifySnapshotManifestIdentityV1(value: unknown): value is SnapshotManifestV1 {
  const parsed = SnapshotManifestV1Schema.safeParse(value);
  if (!parsed.success) {
    return false;
  }

  const { snapshotDigest, ...identityInput } = parsed.data;
  return snapshotDigest.value === computeParsedSnapshotDigest(identityInput).value;
}

function parseNeutralBriefIdentityInput(value: unknown): NeutralReviewBriefIdentityInputV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("neutral brief identity input must be an object");
  }
  canonicalizeJson(value);
  if (Object.hasOwn(value, "briefDigest")) {
    throw new TypeError("neutral brief identity input must not contain briefDigest");
  }

  const parsed = NeutralReviewBriefV1Schema.parse({
    ...value,
    briefDigest: PLACEHOLDER_DIGEST,
  });
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
  return NeutralReviewBriefV1Schema.parse({
    ...identityInput,
    briefDigest: computeParsedNeutralBriefDigest(identityInput),
  });
}

/** Returns true only when both the brief and its embedded snapshot identities match. */
export function verifyNeutralReviewBriefIdentityV1(value: unknown): value is NeutralReviewBriefV1 {
  const parsed = NeutralReviewBriefV1Schema.safeParse(value);
  if (!parsed.success || !verifySnapshotManifestIdentityV1(parsed.data.snapshotManifest)) {
    return false;
  }

  const { briefDigest, ...identityInput } = parsed.data;
  return briefDigest.value === computeParsedNeutralBriefDigest(identityInput).value;
}
