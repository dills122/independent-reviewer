import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import * as z from "zod";
import { buildReviewContextMapV1 } from "../context/build-review-context-map.js";
import { sha256Utf8 } from "../contracts/canonical-json.js";
import {
  assertGuidanceGraphMatchesSnapshotV1,
  type AuthorPacketV1,
  AuthorPacketV1Schema,
  canonicalizeJson,
  computeCanonicalInputDigestV1,
  DigestV1Schema,
  type GuidanceGraphV1,
  guidanceGraphDigestV1,
  GuidanceGraphV1Schema,
  jsonDocument,
  PersistedCanonicalInputsV1Schema,
  type ReviewContextMapV1,
  ReviewContextMapV1Schema,
  type ReviewRequestV1,
  type SnapshotManifestV1,
  SnapshotManifestV1Schema,
  sha256BytesHex,
  verifyReviewContextMapIdentityV1,
  verifySnapshotManifestIdentityV1,
} from "../contracts/index.js";
import type { CapturedReviewerRulesGuidanceV1 } from "../guidance/reviewer-rules.js";
import { assertGuidanceImportOccurrencesV1 } from "../guidance/import-verification.js";
import { readStrictJsonFileV1 } from "../contracts/strict-json.js";
import {
  canonicalInputList,
  type ReviewAuthor,
  ReviewAuthorSchema,
  type ReviewCanonicalInputs,
  ReviewCanonicalInputsSchema,
  ReviewRequestSchema,
} from "../contracts/standards-review.js";
import { buildFallbackReviewContextMapV1 } from "../planning/fallback-context-map.js";
import { mapWithConcurrencyV1 } from "./concurrency.js";
import type { CapturedGitSnapshotV1 } from "./git-capture.js";

const MANIFEST_FILE = "snapshot-manifest.json";
const CANONICAL_INPUTS_FILE = "canonical-inputs.json";
const AUTHOR_PACKET_FILE = "author-packet.json";
const PACKET_METADATA_FILE = "packet-metadata.json";
const CONTEXT_MAP_FILE = "review-context-map.json";
const GUIDANCE_GRAPH_FILE = "guidance-graph.json";
const BLOBS_DIRECTORY = "blobs";
const MAX_PACKET_JSON_BYTES_V1 = 64 * 1024 * 1024;

function readPacketJsonV1(packetPath: string, fileName: string): Promise<unknown> {
  return readStrictJsonFileV1(join(packetPath, fileName), {
    maxBytes: MAX_PACKET_JSON_BYTES_V1,
    source: `snapshot packet ${fileName}`,
  });
}

export interface InspectedSnapshotPacketV1 {
  manifest: SnapshotManifestV1;
  contextMap: ReviewContextMapV1;
  canonicalInputs: ReviewRequestV1["canonicalInputs"];
  authorPacket?: AuthorPacketV1;
  reviewConfigRef: string;
  blobCount: number;
  guidanceGraph?: GuidanceGraphV1;
  guidanceGraphDigest?: z.infer<typeof DigestV1Schema>;
}

export interface InspectedSnapshotPacket
  extends Omit<InspectedSnapshotPacketV1, "canonicalInputs" | "authorPacket"> {
  canonicalInputs: ReviewCanonicalInputs;
  authorPacket?: ReviewAuthor;
}

const PacketMetadataV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  reviewConfigRef: z
    .string()
    .min(8)
    .max(128)
    .regex(/^config_[A-Za-z0-9][A-Za-z0-9_-]*$/),
});

const PacketMetadataSchema = z.union([
  PacketMetadataV1Schema,
  PacketMetadataV1Schema.extend({ schemaVersion: z.literal(2), authorDigest: DigestV1Schema }),
  z.strictObject({
    schemaVersion: z.literal(3),
    requestSchemaVersion: z.union([z.literal(1), z.literal(2)]),
    reviewConfigRef: PacketMetadataV1Schema.shape.reviewConfigRef,
    contextMapDigest: DigestV1Schema,
    authorDigest: DigestV1Schema.optional(),
  }),
  z.strictObject({
    schemaVersion: z.literal(4),
    requestSchemaVersion: z.union([z.literal(1), z.literal(2)]),
    reviewConfigRef: PacketMetadataV1Schema.shape.reviewConfigRef,
    contextMapDigest: DigestV1Schema,
    guidanceGraphDigest: DigestV1Schema,
    authorDigest: DigestV1Schema.optional(),
  }),
]);

function assertContextMapMatchesManifest(
  contextMap: ReviewContextMapV1,
  manifest: SnapshotManifestV1,
): void {
  if (contextMap.snapshotDigest.value !== manifest.snapshotDigest.value) {
    throw new Error("Review context map belongs to a different snapshot.");
  }
  const captured = new Map<string, { digest: string; byteLength: number; kind: string }>();
  for (const entry of manifest.paths) {
    const beforePath = "previousPath" in entry ? entry.previousPath : entry.path;
    if (entry.before?.digest && entry.before.byteLength !== undefined) {
      captured.set(`CHANGED_PATH\0${beforePath}\0BASE`, {
        digest: entry.before.digest.value,
        byteLength: entry.before.byteLength,
        kind: entry.before.kind,
      });
    }
    if (entry.after?.digest && entry.after.byteLength !== undefined) {
      captured.set(`CHANGED_PATH\0${entry.path}\0HEAD`, {
        digest: entry.after.digest.value,
        byteLength: entry.after.byteLength,
        kind: entry.after.kind,
      });
    }
  }
  for (const source of manifest.referencedSources) {
    if (source.content.digest && source.content.byteLength !== undefined) {
      captured.set(`SUPPORTING_CONTEXT\0${source.path}\0HEAD`, {
        digest: source.content.digest.value,
        byteLength: source.content.byteLength,
        kind: source.content.kind,
      });
    }
  }
  for (const region of contextMap.regions) {
    const content = captured.get(`${region.origin}\0${region.path}\0${region.side}`);
    if (
      !content ||
      content.digest !== region.fileDigest.value ||
      content.byteLength !== region.byteLength ||
      (region.range !== undefined && content.kind !== "TEXT")
    ) {
      throw new Error(
        `Review context map region ${region.regionId} does not match captured content.`,
      );
    }
  }
  const fileCoverage = new Set(
    contextMap.regions
      .filter((region) => region.kind === "FILE")
      .map((region) => `${region.origin}\0${region.path}\0${region.side}`),
  );
  for (const key of captured.keys()) {
    if (!fileCoverage.has(key)) {
      throw new Error("Review context map omits required captured file coverage.");
    }
  }
}

interface SourceBoundaryV1 {
  utf16Offset: number;
  utf8Offset: number;
  line: number;
  utf16Column: number;
  utf8Column: number;
}

/**
 * Indexes only offsets named by persisted ranges. One linear source pass avoids retaining a
 * per-character table or rescanning a file for every declaration.
 */
async function verifyRangedBlobFile(
  path: string,
  regions: ReviewContextMapV1["regions"],
  expected: { digest: string; byteLength: number },
): Promise<{ digest: string; byteLength: number }> {
  const utf16Requests = new Set<number>();
  const utf8Requests = new Set<number>();
  for (const region of regions) {
    const range = region.range;
    if (!range) continue;
    const requests = range.coordinateUnit === "UTF16_CODE_UNIT" ? utf16Requests : utf8Requests;
    requests.add(range.startOffset);
    requests.add(range.endOffsetExclusive);
  }

  const boundaries = new Map<string, SourceBoundaryV1>();
  let utf16Offset = 0;
  let utf8Offset = 0;
  let line = 1;
  let lineStartUtf16 = 0;
  let lineStartUtf8 = 0;
  let pending = "";
  const recordBoundary = () => {
    const boundary = {
      utf16Offset,
      utf8Offset,
      line,
      utf16Column: utf16Offset - lineStartUtf16,
      utf8Column: utf8Offset - lineStartUtf8,
    };
    if (utf16Requests.has(utf16Offset)) boundaries.set(`UTF16_CODE_UNIT:${utf16Offset}`, boundary);
    if (utf8Requests.has(utf8Offset)) boundaries.set(`UTF8_BYTE:${utf8Offset}`, boundary);
  };
  const processPending = (final: boolean) => {
    let index = 0;
    while (index < pending.length) {
      const first = pending.charCodeAt(index);
      if (
        !final &&
        index + 1 === pending.length &&
        (first === 13 || (first >= 0xd800 && first <= 0xdbff))
      )
        break;
      recordBoundary();
      if (first === 13) {
        const width = pending.charCodeAt(index + 1) === 10 ? 2 : 1;
        index += width;
        utf16Offset += width;
        utf8Offset += width;
        line += 1;
        lineStartUtf16 = utf16Offset;
        lineStartUtf8 = utf8Offset;
        continue;
      }
      if (first === 10) {
        index += 1;
        utf16Offset += 1;
        utf8Offset += 1;
        line += 1;
        lineStartUtf16 = utf16Offset;
        lineStartUtf8 = utf8Offset;
        continue;
      }
      const codePoint = pending.codePointAt(index);
      if (codePoint === undefined) throw new Error("Unable to index source range coordinates.");
      const width = codePoint > 0xffff ? 2 : 1;
      const character = pending.slice(index, index + width);
      index += width;
      utf16Offset += width;
      utf8Offset += Buffer.byteLength(character, "utf8");
    }
    pending = pending.slice(index);
  };

  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let byteLength = 0;
  let sourceError: unknown;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Uint8Array;
    byteLength += bytes.length;
    hash.update(bytes);
    if (sourceError === undefined) {
      try {
        pending += decoder.decode(bytes, { stream: true });
        processPending(false);
      } catch (error) {
        sourceError = error;
      }
    }
  }
  if (sourceError === undefined) {
    try {
      pending += decoder.decode();
      processPending(true);
      recordBoundary();
      if (pending.length > 0 || utf8Offset !== byteLength) {
        throw new Error("Source coordinate index did not cover the complete blob.");
      }
    } catch (error) {
      sourceError = error;
    }
  }
  const digest = hash.digest("hex");
  if (byteLength !== expected.byteLength || digest !== expected.digest) {
    throw new Error(`Captured blob ${expected.digest} failed digest verification.`);
  }
  if (sourceError !== undefined) {
    throw new Error("Review context map source range does not reference valid UTF-8 text.", {
      cause: sourceError,
    });
  }
  for (const region of regions) {
    const range = region.range;
    if (!range) continue;
    const start = boundaries.get(`${range.coordinateUnit}:${range.startOffset}`);
    const end = boundaries.get(`${range.coordinateUnit}:${range.endOffsetExclusive}`);
    const startColumn =
      range.coordinateUnit === "UTF16_CODE_UNIT" ? start?.utf16Column : start?.utf8Column;
    const endColumn =
      range.coordinateUnit === "UTF16_CODE_UNIT" ? end?.utf16Column : end?.utf8Column;
    if (
      !start ||
      !end ||
      end.utf8Offset - start.utf8Offset !== range.contentByteLength ||
      start.line !== range.startLine ||
      startColumn !== range.startColumn ||
      end.line !== range.endLine ||
      endColumn !== range.endColumn
    ) {
      throw new Error(
        `Review context map source range for region ${region.regionId} does not match captured content.`,
      );
    }
  }
  return { digest, byteLength };
}

function contentRecords(manifest: SnapshotManifestV1): Array<{
  digest: string;
  byteLength: number;
}> {
  const records = new Map<string, number>();
  const contents = [
    ...manifest.paths.flatMap((entry) => [entry.before, entry.after]),
    // Referenced context is stored and verified exactly like changed content; leaving it out here
    // would write a manifest naming blobs the packet does not contain.
    ...manifest.referencedSources.map((source) => source.content),
  ];
  for (const content of contents) {
    if (!content?.digest || content.byteLength === undefined) {
      continue;
    }
    const priorLength = records.get(content.digest.value);
    if (priorLength !== undefined && priorLength !== content.byteLength) {
      throw new Error("Snapshot reuses a content digest with conflicting byte lengths.");
    }
    records.set(content.digest.value, content.byteLength);
  }
  return [...records].map(([digest, byteLength]) => ({ digest, byteLength }));
}

function canonicalInputLedger(canonicalInputs: ReviewCanonicalInputs): unknown[] {
  return canonicalInputList(canonicalInputs)
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
  canonicalInputs: ReviewCanonicalInputs,
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

/**
 * Streams one blob through SHA-256. Verification never needs the bytes themselves, so streaming
 * keeps peak memory bounded by the concurrency limit rather than by the size of the packet.
 */
async function verifyBlobFile(path: string): Promise<{ digest: string; byteLength: number }> {
  const hash = createHash("sha256");
  let byteLength = 0;
  await pipeline(createReadStream(path), async (source) => {
    for await (const chunk of source) {
      const bytes = chunk as Uint8Array;
      byteLength += bytes.length;
      hash.update(bytes);
    }
  });
  return { digest: hash.digest("hex"), byteLength };
}

/** Writes a new private snapshot packet directory and never overwrites an existing packet. */
export async function writeSnapshotPacketV1(
  packetPath: string,
  captured: CapturedGitSnapshotV1,
  requestValue: unknown,
  options: { guidance?: CapturedReviewerRulesGuidanceV1 } = {},
): Promise<void> {
  const request = ReviewRequestSchema.parse(requestValue);
  if (!verifySnapshotManifestIdentityV1(captured.manifest)) {
    throw new Error("Cannot write a snapshot with an invalid manifest identity.");
  }
  assertCanonicalInputsMatch(captured.manifest, request.canonicalInputs);
  const contextMap = await buildReviewContextMapV1(captured.manifest, captured.blobs);
  const records = contentRecords(captured.manifest);
  const packetBlobs = new Map(captured.blobs);
  if (options.guidance) {
    assertGuidanceGraphMatchesSnapshotV1(options.guidance.graph, captured.manifest);
    for (const node of options.guidance.graph.nodes) {
      const bytes = options.guidance.blobs.get(node.contentDigest.value);
      if (!bytes || sha256BytesHex(bytes) !== node.contentDigest.value) {
        throw new Error(`Guidance blob ${node.contentDigest.value} failed digest verification.`);
      }
      const existing = packetBlobs.get(node.contentDigest.value);
      if (existing && !Buffer.from(existing).equals(bytes)) {
        throw new Error("Guidance digest conflicts with captured snapshot content.");
      }
      packetBlobs.set(node.contentDigest.value, bytes);
      if (!records.some(({ digest }) => digest === node.contentDigest.value)) {
        records.push({ digest: node.contentDigest.value, byteLength: bytes.length });
      }
    }
    await assertGuidanceImportOccurrencesV1(options.guidance.graph, async (node) => {
      const bytes = options.guidance?.blobs.get(node.contentDigest.value);
      if (!bytes) throw new Error(`Guidance blob ${node.contentDigest.value} is missing.`);
      return bytes;
    });
  }
  for (const record of records) {
    const bytes = packetBlobs.get(record.digest);
    if (!bytes || bytes.length !== record.byteLength || sha256BytesHex(bytes) !== record.digest) {
      throw new Error(`Captured blob ${record.digest} does not match the snapshot manifest.`);
    }
  }

  // The packet is staged in a sibling directory and renamed into place, so an interrupted or
  // failed write leaves no directory at packetPath: nothing partial to mistake for a packet, and
  // nothing blocking a retry.
  await mkdir(dirname(packetPath), { recursive: true, mode: 0o700 });
  const stagingPath = `${packetPath}.partial-${randomUUID()}`;
  try {
    await mkdir(stagingPath, { mode: 0o700 });
    await mkdir(join(stagingPath, BLOBS_DIRECTORY), { mode: 0o700 });
    await writeFile(join(stagingPath, MANIFEST_FILE), jsonDocument(captured.manifest), {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(join(stagingPath, CONTEXT_MAP_FILE), jsonDocument(contextMap), {
      flag: "wx",
      mode: 0o600,
    });
    if (options.guidance) {
      await writeFile(
        join(stagingPath, GUIDANCE_GRAPH_FILE),
        jsonDocument(options.guidance.graph),
        { flag: "wx", mode: 0o600 },
      );
    }
    await writeFile(
      join(stagingPath, CANONICAL_INPUTS_FILE),
      jsonDocument(request.canonicalInputs),
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      join(stagingPath, PACKET_METADATA_FILE),
      jsonDocument({
        schemaVersion: options.guidance ? 4 : 3,
        requestSchemaVersion: request.schemaVersion,
        reviewConfigRef: request.reviewConfigRef,
        contextMapDigest: contextMap.contextMapDigest,
        ...(options.guidance
          ? { guidanceGraphDigest: guidanceGraphDigestV1(options.guidance.graph) }
          : {}),
        ...(request.schemaVersion === 2
          ? { authorDigest: sha256Utf8(jsonDocument(request.authorPacket)) }
          : {}),
      }),
      { flag: "wx", mode: 0o600 },
    );
    if (request.authorPacket) {
      await writeFile(join(stagingPath, AUTHOR_PACKET_FILE), jsonDocument(request.authorPacket), {
        flag: "wx",
        mode: 0o600,
      });
    }
    await mapWithConcurrencyV1(records, ({ digest }) =>
      writeFile(join(stagingPath, BLOBS_DIRECTORY, digest), packetBlobs.get(digest) as Uint8Array, {
        flag: "wx",
        mode: 0o600,
      }),
    );
    await rename(stagingPath, packetPath);
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      throw new Error(`A snapshot packet already exists at ${packetPath}.`, { cause: error });
    }
    throw error;
  }
}

async function readOptionalAuthorPacket(packetPath: string): Promise<ReviewAuthor | undefined> {
  try {
    return ReviewAuthorSchema.parse(await readPacketJsonV1(packetPath, AUTHOR_PACKET_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Validates packet metadata, identities, and every manifest-referenced blob. */
export async function inspectSnapshotPacket(packetPath: string): Promise<InspectedSnapshotPacket> {
  const manifest = SnapshotManifestV1Schema.parse(
    await readPacketJsonV1(packetPath, MANIFEST_FILE),
  );
  if (!verifySnapshotManifestIdentityV1(manifest)) {
    throw new Error("Snapshot manifest digest verification failed.");
  }
  const canonicalInputs = ReviewCanonicalInputsSchema.parse(
    await readPacketJsonV1(packetPath, CANONICAL_INPUTS_FILE),
  );
  const packetMetadata = PacketMetadataSchema.parse(
    await readPacketJsonV1(packetPath, PACKET_METADATA_FILE),
  );
  if (
    (packetMetadata.schemaVersion === 3 || packetMetadata.schemaVersion === 4) &&
    (packetMetadata.requestSchemaVersion === 2) !== (packetMetadata.authorDigest !== undefined)
  ) {
    throw new Error("Packet metadata author binding does not match request mode.");
  }
  const contextMap =
    packetMetadata.schemaVersion === 3 || packetMetadata.schemaVersion === 4
      ? ReviewContextMapV1Schema.parse(await readPacketJsonV1(packetPath, CONTEXT_MAP_FILE))
      : buildFallbackReviewContextMapV1(manifest);
  if (!verifyReviewContextMapIdentityV1(contextMap)) {
    throw new Error("Review context map digest verification failed.");
  }
  if (
    (packetMetadata.schemaVersion === 3 || packetMetadata.schemaVersion === 4) &&
    packetMetadata.contextMapDigest.value !== contextMap.contextMapDigest.value
  ) {
    throw new Error("Packet metadata context map digest verification failed.");
  }
  assertContextMapMatchesManifest(contextMap, manifest);
  const guidanceGraph =
    packetMetadata.schemaVersion === 4
      ? GuidanceGraphV1Schema.parse(await readPacketJsonV1(packetPath, GUIDANCE_GRAPH_FILE))
      : undefined;
  if (packetMetadata.schemaVersion === 4 && guidanceGraph) {
    assertGuidanceGraphMatchesSnapshotV1(guidanceGraph, manifest);
    if (guidanceGraphDigestV1(guidanceGraph).value !== packetMetadata.guidanceGraphDigest.value) {
      throw new Error("Packet metadata guidance graph digest verification failed.");
    }
    await mapWithConcurrencyV1(guidanceGraph.nodes, async (node) => {
      const verified = await verifyBlobFile(
        join(packetPath, BLOBS_DIRECTORY, node.contentDigest.value),
      ).catch((error: unknown) => {
        throw new Error(`Guidance blob ${node.contentDigest.value} failed verification.`, {
          cause: error,
        });
      });
      if (verified.digest !== node.contentDigest.value) {
        throw new Error(`Guidance blob ${node.contentDigest.value} failed digest verification.`);
      }
    });
    await assertGuidanceImportOccurrencesV1(guidanceGraph, (node) =>
      readFile(join(packetPath, BLOBS_DIRECTORY, node.contentDigest.value)),
    );
  }
  assertCanonicalInputsMatch(manifest, canonicalInputs);
  const records = contentRecords(manifest);
  const rangedRegionsByDigest = new Map<string, ReviewContextMapV1["regions"]>();
  for (const region of contextMap.regions) {
    if (!region.range) continue;
    const regions = rangedRegionsByDigest.get(region.fileDigest.value) ?? [];
    regions.push(region);
    rangedRegionsByDigest.set(region.fileDigest.value, regions);
  }
  await mapWithConcurrencyV1(records, async ({ digest, byteLength }) => {
    const blobPath = join(packetPath, BLOBS_DIRECTORY, digest);
    const rangedRegions = rangedRegionsByDigest.get(digest);
    const verified = rangedRegions
      ? await verifyRangedBlobFile(blobPath, rangedRegions, { digest, byteLength })
      : await verifyBlobFile(blobPath);
    if (verified.byteLength !== byteLength || verified.digest !== digest) {
      throw new Error(`Captured blob ${digest} failed digest verification.`);
    }
  });
  const authorPacket = await readOptionalAuthorPacket(packetPath);
  const requestSchemaVersion =
    packetMetadata.schemaVersion === 3 || packetMetadata.schemaVersion === 4
      ? packetMetadata.requestSchemaVersion
      : packetMetadata.schemaVersion;
  if ((requestSchemaVersion === 2) !== "standards" in canonicalInputs)
    throw new Error("Packet mode mismatch.");
  if (
    requestSchemaVersion === 2 &&
    (!authorPacket ||
      packetMetadata.schemaVersion === 1 ||
      !packetMetadata.authorDigest ||
      sha256Utf8(jsonDocument(authorPacket)).value !== packetMetadata.authorDigest.value)
  )
    throw new Error("Author overview digest verification failed.");
  return {
    manifest,
    contextMap,
    canonicalInputs,
    ...(authorPacket ? { authorPacket } : {}),
    reviewConfigRef: packetMetadata.reviewConfigRef,
    blobCount: new Set([
      ...records.map(({ digest }) => digest),
      ...(guidanceGraph?.nodes.map(({ contentDigest }) => contentDigest.value) ?? []),
    ]).size,
    ...(guidanceGraph
      ? { guidanceGraph, guidanceGraphDigest: guidanceGraphDigestV1(guidanceGraph) }
      : {}),
  };
}

/** Reads one digest-addressed blob and verifies it before returning bytes. */
export async function readSnapshotBlobV1(
  packetPath: string,
  digestValue: unknown,
): Promise<Uint8Array> {
  const digest = DigestV1Schema.parse(digestValue);
  const bytes = await readFile(join(packetPath, BLOBS_DIRECTORY, digest.value));
  if (sha256BytesHex(bytes) !== digest.value) {
    throw new Error(`Captured blob ${digest.value} failed digest verification.`);
  }
  return bytes;
}

export async function inspectSnapshotPacketV1(
  packetPath: string,
): Promise<InspectedSnapshotPacketV1> {
  const packet = await inspectSnapshotPacket(packetPath);
  return {
    ...packet,
    canonicalInputs: PersistedCanonicalInputsV1Schema.parse(packet.canonicalInputs),
    ...(packet.authorPacket
      ? { authorPacket: AuthorPacketV1Schema.parse(packet.authorPacket) }
      : {}),
  } as InspectedSnapshotPacketV1;
}
