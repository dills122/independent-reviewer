import {
  createGuidanceDiagnosticV1,
  MAX_GUIDANCE_DIRECT_CANDIDATES_V1,
  type SnapshotManifestV1,
} from "../contracts/index.js";
import {
  type BaseGuidanceBlobMetadataV1,
  baseGuidanceBlobMetadataV1,
  listBaseGuidanceBlobMetadataV1,
  type ResolvedBaseGuidanceBlobV1,
  readBaseGuidanceFrontmatterV1,
  resolveBaseGuidanceBlobV1,
} from "./base-markdown-source.js";
import { compileGuidancePatternsV1 } from "./conditional-patterns.js";
import {
  createGuidanceDiscoverySessionV1,
  type GuidanceDiscoverySessionV1,
} from "./discovery-capacity.js";
import {
  type CapturedGuidanceV1,
  completeGuidanceDiscoveryV1,
  type GuidanceFamilyDiscoveryV1,
} from "./discovery-engine.js";
import { guidanceAncestorDirectoriesV1, guidancePathInDirectoryV1 } from "./discovery-paths.js";
import { parseKiroSteeringFrontmatterV1 } from "./kiro-frontmatter.js";
import {
  resolveKiroFileReferencePathV1,
  scanKiroFileReferenceOccurrencesV1,
} from "./kiro-imports.js";

const KIRO_STEERING_ROOT_V1 = ".kiro/steering";

export type CapturedKiroGuidanceV1 = CapturedGuidanceV1;

/** Discovers Kiro AGENTS and steering sources from frozen BASE. */
export async function captureKiroGuidanceV1(
  repositoryPath: string,
  manifest: SnapshotManifestV1,
  session: GuidanceDiscoverySessionV1 = createGuidanceDiscoverySessionV1(manifest),
): Promise<CapturedKiroGuidanceV1> {
  const agentsByTarget = new Map<string, string[]>();
  const agentCandidates = new Set<string>();
  for (const target of session.targets) {
    const candidates = guidanceAncestorDirectoriesV1(target.applicabilityPath).map((directory) =>
      guidancePathInDirectoryV1(directory, "AGENTS.md"),
    );
    agentsByTarget.set(target.targetId, candidates);
    for (const candidate of candidates) agentCandidates.add(candidate);
  }
  const steeringMetadata = await listBaseGuidanceBlobMetadataV1(
    repositoryPath,
    manifest.source.baseCommit,
    KIRO_STEERING_ROOT_V1,
    {
      include: (path) => path.endsWith(".md"),
      maximumEntries: MAX_GUIDANCE_DIRECT_CANDIDATES_V1,
    },
  );
  const steeringPaths = [...steeringMetadata.keys()].sort();
  session.claimDirectCandidates([...agentCandidates, ...steeringPaths]);

  const metadataByPath = new Map<string, BaseGuidanceBlobMetadataV1>();
  for (const path of steeringPaths) {
    const metadata = steeringMetadata.get(path);
    if (!metadata) throw new Error(`Kiro steering source ${path} has no BASE metadata.`);
    metadataByPath.set(path, metadata);
  }
  for (const path of [...agentCandidates].sort()) {
    const metadata = await baseGuidanceBlobMetadataV1(
      repositoryPath,
      manifest.source.baseCommit,
      path,
    );
    if (metadata) metadataByPath.set(path, metadata);
  }

  const resolvedByDiscoveredPath = new Map<string, ResolvedBaseGuidanceBlobV1>();
  const steeringMatchers = new Map<string, ((path: string) => boolean) | undefined>();
  const excludedSteering = new Set<string>();
  for (const path of [...metadataByPath.keys()].sort()) {
    if (!metadataByPath.has(path)) throw new Error(`Kiro guidance ${path} has no BASE metadata.`);
    const resolved = await resolveBaseGuidanceBlobV1(
      repositoryPath,
      manifest.source.baseCommit,
      path,
    );
    if (!resolved) throw new Error(`Kiro guidance ${path} has no resolved BASE source.`);
    resolvedByDiscoveredPath.set(path, resolved);
    if (!steeringPaths.includes(path)) continue;
    const parsed = parseKiroSteeringFrontmatterV1(
      path,
      await readBaseGuidanceFrontmatterV1(repositoryPath, resolved.resolvedPath, resolved.metadata),
    );
    // Only `always` and `fileMatch` steering is deterministically selected; the rest depends on a
    // live agent's judgement, so it is recorded as an exclusion rather than silently dropped.
    if (parsed.inclusion === "manual" || parsed.inclusion === "auto") {
      excludedSteering.add(path);
      session.addDiagnostic(
        createGuidanceDiagnosticV1({
          code:
            parsed.inclusion === "manual"
              ? "UNSELECTED_MANUAL_MODE"
              : "UNSELECTED_MODEL_SELECTED_MODE",
          severity: "EXCLUSION",
          path,
          startUtf16: 0,
          omittedCount: null,
        }),
      );
      continue;
    }
    steeringMatchers.set(
      path,
      parsed.inclusion === "fileMatch"
        ? compileGuidancePatternsV1(path, parsed.fileMatchPatterns ?? [])
        : undefined,
    );
  }

  const family: GuidanceFamilyDiscoveryV1 = {
    familyId: "KIRO",
    label: "Kiro guidance",
    limitPath: KIRO_STEERING_ROOT_V1,
    importGraphLabel: "Kiro file-reference graph",
    imports: {
      syntaxKind: "KIRO_FILE_REFERENCE",
      maxDepth: 5,
      scan: scanKiroFileReferenceOccurrencesV1,
      resolvePath: resolveKiroFileReferencePathV1,
      seedsTraversal: ({ sourceKind }) => sourceKind === "KIRO_STEERING",
    },
  };
  return await completeGuidanceDiscoveryV1(repositoryPath, manifest, session, family, {
    resolvedByDiscoveredPath,
    selectPathsForTarget: ({ targetId, applicabilityPath }) => [
      ...(agentsByTarget.get(targetId) ?? []).filter((path) => resolvedByDiscoveredPath.has(path)),
      ...steeringPaths.filter((path) => {
        if (excludedSteering.has(path) || !resolvedByDiscoveredPath.has(path)) return false;
        const matcher = steeringMatchers.get(path);
        return matcher ? matcher(applicabilityPath) : true;
      }),
    ],
    sourceKindFor: (path) => (steeringPaths.includes(path) ? "KIRO_STEERING" : "KIRO_AGENTS"),
  });
}
