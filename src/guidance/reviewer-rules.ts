import {
  buildReviewerRulesGuidanceGraphV1,
  createGuidanceDiagnosticV1,
  type GuidanceGraphV1,
  type SnapshotManifestV1,
} from "../contracts/index.js";
import {
  baseGuidanceBlobMetadataV1,
  readBaseMarkdownGuidanceSourceV1,
} from "./base-markdown-source.js";

export {
  GuidanceCaptureError,
  type GuidanceCaptureErrorCode,
  MAX_GUIDANCE_SOURCE_BYTES_V1,
} from "./base-markdown-source.js";

export const REVIEWER_RULES_PATH_V1 = ".independent-reviewer/rules.md";
export interface CapturedReviewerRulesGuidanceV1 {
  graph: GuidanceGraphV1;
  blobs: ReadonlyMap<string, Uint8Array>;
}

/** Captures only explicit reviewer rules from frozen BASE; no harness discovery occurs here. */
export async function captureReviewerRulesGuidanceV1(
  repositoryPath: string,
  manifest: SnapshotManifestV1,
): Promise<CapturedReviewerRulesGuidanceV1> {
  const metadata = await baseGuidanceBlobMetadataV1(
    repositoryPath,
    manifest.source.baseCommit,
    REVIEWER_RULES_PATH_V1,
  );
  if (!metadata) {
    return { graph: buildReviewerRulesGuidanceGraphV1(manifest), blobs: new Map() };
  }
  const source = await readBaseMarkdownGuidanceSourceV1(
    repositoryPath,
    REVIEWER_RULES_PATH_V1,
    metadata,
  );
  if (source.content.trim().length === 0) {
    const diagnostic = createGuidanceDiagnosticV1({
      code: "EMPTY_SOURCE",
      severity: "WARNING",
      path: REVIEWER_RULES_PATH_V1,
      startUtf16: 0,
      omittedCount: null,
    });
    return {
      graph: buildReviewerRulesGuidanceGraphV1(manifest, undefined, [diagnostic]),
      blobs: new Map(),
    };
  }
  return {
    graph: buildReviewerRulesGuidanceGraphV1(manifest, source.contentDigest),
    blobs: new Map([[source.contentDigest.value, Uint8Array.from(source.bytes)]]),
  };
}
