import {
  buildGuidanceGraphV1,
  type DirectGuidanceSourceInputV1,
  type GuidanceGraphV1,
  type GuidanceImportInputV1,
  type SnapshotManifestV1,
} from "../contracts/index.js";
import { captureClaudeGuidanceV1 } from "./claude-discovery.js";
import { captureCodexGuidanceV1 } from "./codex-discovery.js";
import { captureReviewerRulesGuidanceV1 } from "./reviewer-rules.js";

export interface CapturedRepositoryGuidanceV1 {
  graph: GuidanceGraphV1;
  blobs: ReadonlyMap<string, Uint8Array>;
}

/** Combines family adapters into one canonical graph and deduplicated blob set. */
export async function captureRepositoryGuidanceV1(
  repositoryPath: string,
  manifest: SnapshotManifestV1,
): Promise<CapturedRepositoryGuidanceV1> {
  const captures = [
    await captureCodexGuidanceV1(repositoryPath, manifest),
    await captureClaudeGuidanceV1(repositoryPath, manifest),
    await captureReviewerRulesGuidanceV1(repositoryPath, manifest),
  ];
  const sources: DirectGuidanceSourceInputV1[] = captures.flatMap(({ graph }) =>
    graph.nodes.map(({ resolvedPath, contentDigest, directRecognitions }) => ({
      resolvedPath,
      contentDigest,
      directRecognitions,
    })),
  );
  const imports: GuidanceImportInputV1[] = captures.flatMap(({ graph }) => {
    const nodes = new Map(graph.nodes.map((node) => [node.sourceId, node]));
    return graph.occurrences.map((occurrence) => {
      const importer = nodes.get(occurrence.importerSourceId);
      const edges = graph.edges.filter(
        ({ occurrenceId }) => occurrenceId === occurrence.occurrenceId,
      );
      const importedIds = new Set(edges.map(({ importedSourceId }) => importedSourceId));
      if (!importer || importedIds.size !== 1)
        throw new Error(`Guidance occurrence ${occurrence.occurrenceId} is not fully resolved.`);
      const importedSourceId = [...importedIds][0];
      const imported = importedSourceId ? nodes.get(importedSourceId) : undefined;
      if (!imported)
        throw new Error(`Guidance occurrence ${occurrence.occurrenceId} has no imported source.`);
      return {
        familyId: occurrence.familyId,
        syntaxKind: occurrence.syntaxKind,
        importerPath: importer.resolvedPath,
        importerContentDigest: importer.contentDigest,
        importedPath: imported.resolvedPath,
        importedContentDigest: imported.contentDigest,
        requestedSpecifier: occurrence.requestedSpecifier,
        startUtf16: occurrence.startUtf16,
        endUtf16: occurrence.endUtf16,
        applicableTargetIds: edges.map(({ applicableTargetId }) => applicableTargetId),
      };
    });
  });
  const blobs = new Map<string, Uint8Array>();
  for (const capture of captures) {
    for (const [digest, bytes] of capture.blobs) {
      const existing = blobs.get(digest);
      if (existing && !Buffer.from(existing).equals(bytes))
        throw new Error(`Guidance blob ${digest} has conflicting content.`);
      blobs.set(digest, Uint8Array.from(bytes));
    }
  }
  return {
    graph: buildGuidanceGraphV1(
      manifest,
      sources,
      imports,
      captures.flatMap(({ graph }) => graph.diagnostics),
    ),
    blobs,
  };
}
