import { MAX_GUIDANCE_DIRECT_CANDIDATES_V1, type SnapshotManifestV1 } from "../contracts/index.js";
import {
  type BaseGuidanceBlobMetadataV1,
  baseGuidanceBlobMetadataV1,
  listBaseGuidanceBlobMetadataV1,
  type ResolvedBaseGuidanceBlobV1,
  readBaseGuidanceFrontmatterV1,
  resolveBaseGuidanceBlobV1,
} from "./base-markdown-source.js";
import { resolveClaudeImportPathV1, scanClaudeImportOccurrencesV1 } from "./claude-imports.js";
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
import { parseGuidanceFrontmatterV1 } from "./frontmatter.js";

const DOT_CLAUDE_PATH_V1 = ".claude/CLAUDE.md";
const CLAUDE_RULES_ROOT_V1 = ".claude/rules";

export type CapturedClaudeGuidanceV1 = CapturedGuidanceV1;

/** Discovers directly selected Claude guidance from frozen BASE. */
export async function captureClaudeGuidanceV1(
  repositoryPath: string,
  manifest: SnapshotManifestV1,
  session: GuidanceDiscoverySessionV1 = createGuidanceDiscoverySessionV1(manifest),
): Promise<CapturedClaudeGuidanceV1> {
  const targets = session.targets;

  const candidatesByTarget = new Map<string, string[]>();
  const fixedCandidates = new Set<string>([DOT_CLAUDE_PATH_V1]);
  for (const target of targets) {
    const candidates = guidanceAncestorDirectoriesV1(target.applicabilityPath).map((directory) =>
      guidancePathInDirectoryV1(directory, "CLAUDE.md"),
    );
    candidatesByTarget.set(target.targetId, candidates);
    for (const candidate of candidates) fixedCandidates.add(candidate);
  }
  const ruleMetadata = await listBaseGuidanceBlobMetadataV1(
    repositoryPath,
    manifest.source.baseCommit,
    CLAUDE_RULES_ROOT_V1,
    {
      include: (path) => path.endsWith(".md"),
      maximumEntries: MAX_GUIDANCE_DIRECT_CANDIDATES_V1,
    },
  );
  const rules = [...ruleMetadata.keys()].sort();
  session.claimDirectCandidates([...fixedCandidates, ...rules]);

  const metadataByPath = new Map<string, BaseGuidanceBlobMetadataV1>();
  for (const path of rules) {
    const metadata = ruleMetadata.get(path);
    if (!metadata) throw new Error(`Claude rule ${path} has no BASE metadata.`);
    metadataByPath.set(path, metadata);
  }
  for (const path of [...fixedCandidates].sort()) {
    const metadata = await baseGuidanceBlobMetadataV1(
      repositoryPath,
      manifest.source.baseCommit,
      path,
    );
    if (metadata) metadataByPath.set(path, metadata);
  }

  const resolvedByDiscoveredPath = new Map<string, ResolvedBaseGuidanceBlobV1>();
  const ruleMatchers = new Map<string, ((path: string) => boolean) | undefined>();
  for (const path of [...metadataByPath.keys()].sort()) {
    const metadata = metadataByPath.get(path);
    if (!metadata) throw new Error(`Guidance source ${path} has no BASE metadata.`);
    const resolved = await resolveBaseGuidanceBlobV1(
      repositoryPath,
      manifest.source.baseCommit,
      path,
    );
    if (!resolved) throw new Error(`Guidance source ${path} has no resolved BASE source.`);
    resolvedByDiscoveredPath.set(path, resolved);
    if (rules.includes(path)) {
      const { paths } = parseGuidanceFrontmatterV1(
        path,
        await readBaseGuidanceFrontmatterV1(
          repositoryPath,
          resolved.resolvedPath,
          resolved.metadata,
        ),
      );
      ruleMatchers.set(path, paths ? compileGuidancePatternsV1(path, paths) : undefined);
    }
  }

  const family: GuidanceFamilyDiscoveryV1 = {
    familyId: "CLAUDE",
    label: "Claude guidance source",
    limitPath: "CLAUDE.md",
    importGraphLabel: "Claude @path import graph",
    imports: {
      syntaxKind: "CLAUDE_AT_PATH",
      maxDepth: 4,
      scan: scanClaudeImportOccurrencesV1,
      resolvePath: resolveClaudeImportPathV1,
      seedsTraversal: ({ sourceKind }) => sourceKind !== "CLAUDE_RULE",
    },
  };
  return await completeGuidanceDiscoveryV1(repositoryPath, manifest, session, family, {
    resolvedByDiscoveredPath,
    selectPathsForTarget: ({ targetId, applicabilityPath }) => [
      ...new Set([
        ...(candidatesByTarget.get(targetId) ?? []).filter((path) =>
          resolvedByDiscoveredPath.has(path),
        ),
        ...(resolvedByDiscoveredPath.has(DOT_CLAUDE_PATH_V1) ? [DOT_CLAUDE_PATH_V1] : []),
        ...rules.filter((path) => {
          if (!resolvedByDiscoveredPath.has(path)) return false;
          const matcher = ruleMatchers.get(path);
          return matcher ? matcher(applicabilityPath) : true;
        }),
      ]),
    ],
    sourceKindFor: (path) =>
      rules.includes(path)
        ? "CLAUDE_RULE"
        : path === DOT_CLAUDE_PATH_V1
          ? "CLAUDE_DOT_CLAUDE_MD"
          : "CLAUDE_MD",
  });
}
