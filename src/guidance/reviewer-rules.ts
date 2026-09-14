import {
  buildDirectGuidanceGraphV1,
  createGuidanceDiagnosticV1,
  type DirectGuidanceSourceInputV1,
  type GuidanceGraphV1,
  type SnapshotManifestV1,
} from "../contracts/index.js";
import { readResolvedBaseMarkdownGuidanceSourceV1 } from "./base-markdown-source.js";
import {
  createGuidanceDiscoverySessionV1,
  type GuidanceDiscoverySessionV1,
} from "./discovery-capacity.js";

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
  session: GuidanceDiscoverySessionV1 = createGuidanceDiscoverySessionV1(manifest),
): Promise<CapturedReviewerRulesGuidanceV1> {
  session.claimDirectCandidates([REVIEWER_RULES_PATH_V1]);
  const loaded = await readResolvedBaseMarkdownGuidanceSourceV1(
    repositoryPath,
    manifest.source.baseCommit,
    REVIEWER_RULES_PATH_V1,
  );
  if (!loaded) {
    return {
      graph: buildDirectGuidanceGraphV1(manifest, [], session.finalizeDiagnostics()),
      blobs: new Map(),
    };
  }
  const { source } = loaded;
  if (source.content.trim().length === 0) {
    const diagnostic = createGuidanceDiagnosticV1({
      code: "EMPTY_SOURCE",
      severity: "WARNING",
      path: REVIEWER_RULES_PATH_V1,
      startUtf16: 0,
      omittedCount: null,
    });
    session.addDiagnostic(diagnostic);
    return {
      graph: buildDirectGuidanceGraphV1(manifest, [], session.finalizeDiagnostics()),
      blobs: new Map(),
    };
  }
  const input: DirectGuidanceSourceInputV1 = {
    resolvedPath: loaded.resolvedPath,
    contentDigest: source.contentDigest,
    directRecognitions: session.targets.map((target) => ({
      familyId: "INDEPENDENT_REVIEWER",
      sourceKind: "REVIEWER_RULES",
      nativeOrder: 0,
      applicableTargetId: target.targetId,
      discoveredPath: REVIEWER_RULES_PATH_V1,
    })),
  };
  for (const recognition of input.directRecognitions)
    session.claimDirectRecognition(input, recognition);
  return {
    graph: buildDirectGuidanceGraphV1(manifest, [input], session.finalizeDiagnostics()),
    blobs: new Map([[source.contentDigest.value, Uint8Array.from(source.bytes)]]),
  };
}
