import { canonicalizeJson, digestCanonicalJson } from "../contracts/canonical-json.js";
import { compareUtf16 } from "../contracts/primitives.js";
import {
  finalizeReviewContextMapV1,
  type ReviewContextMapV1,
} from "../contracts/review-context-map.js";
import type { SnapshotManifestV1 } from "../contracts/snapshot-manifest.js";
import { buildFallbackReviewContextMapV1 } from "../planning/fallback-context-map.js";
import { createTreeSitterContextAnalyzerV1 } from "./tree-sitter-analyzer.js";

const STATUS_PRIORITY = {
  COMPLETE: 0,
  UNSUPPORTED: 1,
  PARTIAL: 2,
  FAILED: 3,
} as const;

/** Syntax enrichment cannot make a bounded snapshot packet grow without limit. */
const MAX_SYNTAX_REGIONS_V1 = 1_024;
const MAX_SYNTAX_ENRICHMENT_BYTES_V1 = 512 * 1_024;

function mergeProducer(
  producers: Map<string, ReviewContextMapV1["producers"][number]>,
  candidate: ReviewContextMapV1["producers"][number],
): void {
  const current = producers.get(candidate.producerId);
  if (!current) {
    producers.set(candidate.producerId, candidate);
    return;
  }
  producers.set(candidate.producerId, {
    ...current,
    status:
      STATUS_PRIORITY[candidate.status] > STATUS_PRIORITY[current.status]
        ? candidate.status
        : current.status,
    diagnostics: [...new Set([...current.diagnostics, ...candidate.diagnostics])].sort(
      compareUtf16,
    ),
  });
}

function relationId(sourceRegionId: string, targetRegionId: string): string {
  return `relation_${digestCanonicalJson({
    sourceRegionId,
    targetRegionId,
    kind: "ENCLOSES",
    producerKind: "TREE_SITTER_DECLARATION_QUERY",
  }).value.slice(0, 24)}`;
}

/** Adds best-effort language regions while retaining universal file-level fallback coverage. */
export async function buildReviewContextMapV1(
  manifest: SnapshotManifestV1,
  blobs: ReadonlyMap<string, Uint8Array>,
): Promise<ReviewContextMapV1> {
  const fallback = buildFallbackReviewContextMapV1(manifest);
  const producers = new Map(fallback.producers.map((producer) => [producer.producerId, producer]));
  const regions = [...fallback.regions];
  const relations = [...fallback.relations];
  let syntaxRegionCount = 0;
  let syntaxEnrichmentBytes = 0;
  let enrichmentExhausted = false;
  const textRegions = new Set<string>();
  for (const entry of manifest.paths) {
    const beforePath = "previousPath" in entry ? entry.previousPath : entry.path;
    if (entry.before?.kind === "TEXT") textRegions.add(`${beforePath}\0BASE`);
    if (entry.after?.kind === "TEXT") textRegions.add(`${entry.path}\0HEAD`);
  }
  for (const source of manifest.referencedSources) {
    if (source.content.kind === "TEXT") textRegions.add(`${source.path}\0HEAD`);
  }
  const fileRegions = fallback.regions.filter(
    (region) => region.kind === "FILE" && textRegions.has(`${region.path}\0${region.side}`),
  );
  let analyzer: Awaited<ReturnType<typeof createTreeSitterContextAnalyzerV1>> | undefined;
  try {
    analyzer = await createTreeSitterContextAnalyzerV1();
    for (const fileRegion of fileRegions) {
      if (enrichmentExhausted) break;
      const bytes = blobs.get(fileRegion.fileDigest.value);
      if (!bytes) continue;
      try {
        const result = await analyzer.analyze({
          path: fileRegion.path,
          source: Buffer.from(bytes).toString("utf8"),
          fileDigest: fileRegion.fileDigest,
          side: fileRegion.side,
          origin: fileRegion.origin,
          ...(fileRegion.role ? { role: fileRegion.role } : {}),
        });
        mergeProducer(producers, result.producer);
        for (const region of result.regions) {
          const relation = {
            relationId: relationId(fileRegion.regionId, region.regionId),
            sourceRegionId: fileRegion.regionId,
            targetRegionId: region.regionId,
            kind: "ENCLOSES",
            certainty: "SYNTACTIC",
            producerId: result.producer.producerId,
            producerKind: "TREE_SITTER_DECLARATION_QUERY",
          } as const;
          const addedBytes = Buffer.byteLength(canonicalizeJson({ region, relation }), "utf8");
          if (
            syntaxRegionCount >= MAX_SYNTAX_REGIONS_V1 ||
            syntaxEnrichmentBytes + addedBytes > MAX_SYNTAX_ENRICHMENT_BYTES_V1
          ) {
            enrichmentExhausted = true;
            mergeProducer(producers, {
              ...result.producer,
              status: "PARTIAL",
              diagnostics: [
                ...result.producer.diagnostics,
                `Syntax enrichment stopped at ${MAX_SYNTAX_REGIONS_V1} regions or ${MAX_SYNTAX_ENRICHMENT_BYTES_V1} serialized bytes; file-level fallback remains available.`,
              ],
            });
            break;
          }
          regions.push(region);
          relations.push(relation);
          syntaxRegionCount += 1;
          syntaxEnrichmentBytes += addedBytes;
        }
      } catch {
        mergeProducer(producers, {
          producerId: "producer_tree_sitter_runtime",
          producerVersion: "web-tree-sitter@0.27.0;declarations-v2;bounded-v1",
          status: "FAILED",
          diagnostics: [
            `${fileRegion.path}: Tree-sitter analysis failed; file-level fallback remains available.`,
          ],
        });
      }
    }
  } catch {
    mergeProducer(producers, {
      producerId: "producer_tree_sitter_runtime",
      producerVersion: "web-tree-sitter@0.27.0;declarations-v2;bounded-v1",
      status: "FAILED",
      diagnostics: [
        "Tree-sitter runtime initialization failed; file-level fallback remains available.",
      ],
    });
  } finally {
    analyzer?.dispose();
  }

  regions.sort((left, right) => compareUtf16(left.regionId, right.regionId));
  relations.sort((left, right) => compareUtf16(left.relationId, right.relationId));
  const { contextMapDigest: _digest, ...draft } = fallback;
  return finalizeReviewContextMapV1({
    ...draft,
    producers: [...producers.values()].sort((left, right) =>
      compareUtf16(left.producerId, right.producerId),
    ),
    regions,
    relations,
  });
}
