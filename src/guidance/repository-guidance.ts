import {
  buildDirectGuidanceGraphV1,
  type DirectGuidanceSourceInputV1,
  type GuidanceGraphV1,
  type SnapshotManifestV1,
} from "../contracts/index.js";
import { captureClaudeGuidanceV1 } from "./claude-discovery.js";
import { captureCodexGuidanceV1 } from "./codex-discovery.js";
import { captureReviewerRulesGuidanceV1 } from "./reviewer-rules.js";

export interface CapturedRepositoryGuidanceV1 {
  graph: GuidanceGraphV1;
  blobs: ReadonlyMap<string, Uint8Array>;
}

/** Combines direct family adapters into one canonical graph and deduplicated blob set. */
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
    graph: buildDirectGuidanceGraphV1(
      manifest,
      sources,
      captures.flatMap(({ graph }) => graph.diagnostics),
    ),
    blobs,
  };
}
