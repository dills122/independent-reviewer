import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import * as z from "zod";

import {
  AuthorPacketV1Schema,
  canonicalizeJson,
  computeCanonicalInputDigestV1,
  PersistedCanonicalInputsV1Schema,
  ReviewRequestV1Schema,
  DigestV1Schema,
  SnapshotManifestV1Schema,
  verifySnapshotManifestIdentityV1,
  type AuthorPacketV1,
  type ReviewRequestV1,
  type SnapshotManifestV1,
} from "../contracts/index.js";
import type { CapturedGitSnapshotV1 } from "./git-capture.js";

const MANIFEST_FILE = "snapshot-manifest.json";
const CANONICAL_INPUTS_FILE = "canonical-inputs.json";
const AUTHOR_PACKET_FILE = "author-packet.json";
const PACKET_METADATA_FILE = "packet-metadata.json";
const BLOBS_DIRECTORY = "blobs";

export interface InspectedSnapshotPacketV1 {
  manifest: SnapshotManifestV1;
  canonicalInputs: ReviewRequestV1["canonicalInputs"];
  authorPacket?: AuthorPacketV1;
  reviewConfigRef: string;
  blobCount: number;
}

const PacketMetadataV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  reviewConfigRef: z
    .string()
    .min(8)
    .max(128)
    .regex(/^config_[A-Za-z0-9][A-Za-z0-9_-]*$/),
});

function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function contentRecords(manifest: SnapshotManifestV1): Array<{
  digest: string;
  byteLength: number;
}> {
  const records = new Map<string, number>();
  for (const entry of manifest.paths) {
    for (const content of [entry.before, entry.after]) {
      if (!content?.digest || content.byteLength === undefined) {
        continue;
      }
      const priorLength = records.get(content.digest.value);
      if (priorLength !== undefined && priorLength !== content.byteLength) {
        throw new Error("Snapshot reuses a content digest with conflicting byte lengths.");
      }
      records.set(content.digest.value, content.byteLength);
    }
  }
  return [...records].map(([digest, byteLength]) => ({ digest, byteLength }));
}

function canonicalInputLedger(canonicalInputs: ReviewRequestV1["canonicalInputs"]): unknown[] {
  return [
    ...canonicalInputs.requirements,
    canonicalInputs.implementationPlan,
    ...canonicalInputs.projectGuidance,
  ]
    .map((input) => ({
      id: input.id,
      kind: input.kind,
      digest: computeCanonicalInputDigestV1(input),
      provenance: input.provenance,
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function assertCanonicalInputsMatch(
  manifest: SnapshotManifestV1,
  canonicalInputs: ReviewRequestV1["canonicalInputs"],
): void {
  const manifestLedger = [...manifest.canonicalInputs].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  if (
    canonicalizeJson(manifestLedger) !== canonicalizeJson(canonicalInputLedger(canonicalInputs))
  ) {
    throw new Error("Canonical inputs do not match the snapshot manifest.");
  }
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Writes a new private snapshot packet directory and never overwrites an existing packet. */
export async function writeSnapshotPacketV1(
  packetPath: string,
  captured: CapturedGitSnapshotV1,
  requestValue: unknown,
): Promise<void> {
  const request = ReviewRequestV1Schema.parse(requestValue);
  if (!verifySnapshotManifestIdentityV1(captured.manifest)) {
    throw new Error("Cannot write a snapshot with an invalid manifest identity.");
  }
  assertCanonicalInputsMatch(captured.manifest, request.canonicalInputs);
  const records = contentRecords(captured.manifest);
  for (const record of records) {
    const bytes = captured.blobs.get(record.digest);
    if (!bytes || bytes.length !== record.byteLength || digestBytes(bytes) !== record.digest) {
      throw new Error(`Captured blob ${record.digest} does not match the snapshot manifest.`);
    }
  }

  await mkdir(dirname(packetPath), { recursive: true, mode: 0o700 });
  await mkdir(packetPath, { mode: 0o700 });
  await mkdir(join(packetPath, BLOBS_DIRECTORY), { mode: 0o700 });
  await writeFile(join(packetPath, MANIFEST_FILE), jsonDocument(captured.manifest), {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(join(packetPath, CANONICAL_INPUTS_FILE), jsonDocument(request.canonicalInputs), {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    join(packetPath, PACKET_METADATA_FILE),
    jsonDocument({ schemaVersion: 1, reviewConfigRef: request.reviewConfigRef }),
    { flag: "wx", mode: 0o600 },
  );
  if (request.authorPacket) {
    await writeFile(join(packetPath, AUTHOR_PACKET_FILE), jsonDocument(request.authorPacket), {
      flag: "wx",
      mode: 0o600,
    });
  }
  await Promise.all(
    records.map(({ digest }) =>
      writeFile(
        join(packetPath, BLOBS_DIRECTORY, digest),
        captured.blobs.get(digest) as Uint8Array,
        {
          flag: "wx",
          mode: 0o600,
        },
      ),
    ),
  );
}

async function readOptionalAuthorPacket(packetPath: string): Promise<AuthorPacketV1 | undefined> {
  try {
    return AuthorPacketV1Schema.parse(
      JSON.parse(await readFile(join(packetPath, AUTHOR_PACKET_FILE), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Validates packet metadata, identities, and every manifest-referenced blob. */
export async function inspectSnapshotPacketV1(
  packetPath: string,
): Promise<InspectedSnapshotPacketV1> {
  const manifest = SnapshotManifestV1Schema.parse(
    JSON.parse(await readFile(join(packetPath, MANIFEST_FILE), "utf8")),
  );
  if (!verifySnapshotManifestIdentityV1(manifest)) {
    throw new Error("Snapshot manifest digest verification failed.");
  }
  const canonicalInputs = PersistedCanonicalInputsV1Schema.parse(
    JSON.parse(await readFile(join(packetPath, CANONICAL_INPUTS_FILE), "utf8")),
  );
  const packetMetadata = PacketMetadataV1Schema.parse(
    JSON.parse(await readFile(join(packetPath, PACKET_METADATA_FILE), "utf8")),
  );
  assertCanonicalInputsMatch(manifest, canonicalInputs);
  const records = contentRecords(manifest);
  await Promise.all(
    records.map(async ({ digest, byteLength }) => {
      const bytes = await readFile(join(packetPath, BLOBS_DIRECTORY, digest));
      if (bytes.length !== byteLength || digestBytes(bytes) !== digest) {
        throw new Error(`Captured blob ${digest} failed digest verification.`);
      }
    }),
  );
  const authorPacket = await readOptionalAuthorPacket(packetPath);
  return {
    manifest,
    canonicalInputs,
    ...(authorPacket ? { authorPacket } : {}),
    reviewConfigRef: packetMetadata.reviewConfigRef,
    blobCount: records.length,
  };
}

/** Reads one digest-addressed blob and verifies it before returning bytes. */
export async function readSnapshotBlobV1(
  packetPath: string,
  digestValue: unknown,
): Promise<Uint8Array> {
  const digest = DigestV1Schema.parse(digestValue);
  const bytes = await readFile(join(packetPath, BLOBS_DIRECTORY, digest.value));
  if (digestBytes(bytes) !== digest.value) {
    throw new Error(`Captured blob ${digest.value} failed digest verification.`);
  }
  return bytes;
}
