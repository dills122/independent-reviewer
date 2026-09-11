import { digestCanonicalJson } from "../contracts/canonical-json.js";
import { compareUtf16 } from "../contracts/primitives.js";
import {
  finalizeReviewContextMapV1,
  type ReviewContextMapV1,
} from "../contracts/review-context-map.js";
import type {
  SnapshotContentV1,
  SnapshotManifestV1,
  SnapshotPathEntryV1,
} from "../contracts/snapshot-manifest.js";

const PRODUCER_ID = "producer_snapshot_manifest" as const;
const PRODUCER_VERSION = "captured-references-v1" as const;

function stableId(prefix: "context" | "region" | "relation", value: unknown): string {
  return `${prefix}_${digestCanonicalJson(value).value.slice(0, 24)}`;
}

function regionFor(
  manifest: SnapshotManifestV1,
  path: string,
  side: "BASE" | "HEAD",
  content: SnapshotContentV1 | null,
  origin: ReviewContextMapV1["regions"][number]["origin"],
  role?: SnapshotPathEntryV1["role"],
): ReviewContextMapV1["regions"][number] | undefined {
  if (!content?.digest || content.byteLength === undefined) return undefined;
  const identity = {
    snapshotDigest: manifest.snapshotDigest,
    path,
    side,
    fileDigest: content.digest,
    origin,
    producerId: PRODUCER_ID,
  };
  return {
    regionId: stableId("region", identity),
    origin,
    path,
    side,
    fileDigest: content.digest,
    byteLength: content.byteLength,
    ...(role ? { role } : {}),
    languageId: "unknown",
    kind: "FILE",
    producerId: PRODUCER_ID,
    producerKind: "CAPTURED_FILE",
  };
}

function changedRegions(
  manifest: SnapshotManifestV1,
  entry: SnapshotPathEntryV1,
): ReviewContextMapV1["regions"] {
  const beforePath = "previousPath" in entry ? entry.previousPath : entry.path;
  return [
    regionFor(manifest, beforePath, "BASE", entry.before, "CHANGED_PATH", entry.role),
    regionFor(manifest, entry.path, "HEAD", entry.after, "CHANGED_PATH", entry.role),
  ].filter((region): region is ReviewContextMapV1["regions"][number] => region !== undefined);
}

/**
 * Builds the parser-independent map every packet can support. Current capture supplies only direct
 * referenced-source relations; language analyzers can add finer regions without changing planner.
 */
export function buildFallbackReviewContextMapV1(manifest: SnapshotManifestV1): ReviewContextMapV1 {
  const regions = manifest.paths.flatMap((entry) => changedRegions(manifest, entry));
  for (const source of manifest.referencedSources) {
    const region = regionFor(manifest, source.path, "HEAD", source.content, "SUPPORTING_CONTEXT");
    if (region) regions.push(region);
  }
  regions.sort((left, right) => {
    const pathOrder = compareUtf16(left.path, right.path);
    if (pathOrder) return pathOrder;
    const sideOrder = left.side === right.side ? 0 : left.side === "BASE" ? -1 : 1;
    return sideOrder || compareUtf16(left.regionId, right.regionId);
  });

  const changedHeadByPath = new Map(
    regions
      .filter((region) => region.origin === "CHANGED_PATH" && region.side === "HEAD")
      .map((region) => [region.path, region]),
  );
  const supportByPath = new Map(
    regions
      .filter((region) => region.origin === "SUPPORTING_CONTEXT")
      .map((region) => [region.path, region]),
  );
  const relations: ReviewContextMapV1["relations"] = [];
  for (const source of manifest.referencedSources) {
    const target = supportByPath.get(source.path);
    if (!target) continue;
    for (const importer of [...source.importedBy].sort(compareUtf16)) {
      const changed = changedHeadByPath.get(importer);
      if (!changed) continue;
      const identity = {
        sourceRegionId: changed.regionId,
        targetRegionId: target.regionId,
        kind: "DEPENDS_ON",
        certainty: "SYNTACTIC",
        producerId: PRODUCER_ID,
      } as const;
      relations.push({
        relationId: stableId("relation", identity),
        ...identity,
        producerKind: "CAPTURED_DIRECT_REFERENCE",
      });
    }
  }
  relations.sort((left, right) => compareUtf16(left.relationId, right.relationId));

  return finalizeReviewContextMapV1({
    schemaVersion: 1,
    contextMapId: stableId("context", {
      snapshotDigest: manifest.snapshotDigest,
      producerVersion: PRODUCER_VERSION,
    }),
    snapshotDigest: manifest.snapshotDigest,
    producers: [
      {
        producerId: PRODUCER_ID,
        producerVersion: PRODUCER_VERSION,
        status: "COMPLETE",
        diagnostics: [],
      },
    ],
    regions,
    relations,
  });
}
