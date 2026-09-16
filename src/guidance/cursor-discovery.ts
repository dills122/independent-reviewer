import {
  createGuidanceDiagnosticV1,
  MAX_GUIDANCE_DIRECT_CANDIDATES_V1,
  type SnapshotManifestV1,
} from "../contracts/index.js";
import {
  type BaseGuidanceBlobMetadataV1,
  listBaseGuidanceBlobMetadataV1,
  type ResolvedBaseGuidanceBlobV1,
  readBaseGuidanceFrontmatterV1,
  resolveBaseGuidanceBlobV1,
} from "./base-markdown-source.js";
import { compileGuidancePatternsV1 } from "./conditional-patterns.js";
import { parseCursorFrontmatterV1 } from "./cursor-frontmatter.js";
import { resolveCursorImportPathV1, scanCursorImportOccurrencesV1 } from "./cursor-imports.js";
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

const CURSOR_RULES_SUFFIX_V1 = ".cursor/rules";

export type CapturedCursorGuidanceV1 = CapturedGuidanceV1;

/** The directory a rule governs: everything under the parent of its `.cursor/rules` root. */
function ruleScope(path: string): string {
  const marker = `/${CURSOR_RULES_SUFFIX_V1}/`;
  const index = path.indexOf(marker);
  return index === -1 ? "" : path.slice(0, index);
}

function scopeDepth(path: string): number {
  const scope = ruleScope(path);
  return scope.length === 0 ? 0 : scope.split("/").length;
}

function targetWithinScope(targetPath: string, scope: string): boolean {
  return scope.length === 0 || targetPath.startsWith(`${scope}/`);
}

/** Discovers deterministic always-on and glob-attached Cursor project rules from frozen BASE. */
export async function captureCursorGuidanceV1(
  repositoryPath: string,
  manifest: SnapshotManifestV1,
  session: GuidanceDiscoverySessionV1 = createGuidanceDiscoverySessionV1(manifest),
): Promise<CapturedCursorGuidanceV1> {
  const ruleMetadata = new Map<string, BaseGuidanceBlobMetadataV1>();
  const roots = new Set<string>();
  for (const target of session.targets) {
    for (const directory of guidanceAncestorDirectoriesV1(target.applicabilityPath)) {
      roots.add(guidancePathInDirectoryV1(directory, CURSOR_RULES_SUFFIX_V1));
    }
  }
  for (const root of [...roots].sort()) {
    const listed = await listBaseGuidanceBlobMetadataV1(
      repositoryPath,
      manifest.source.baseCommit,
      root,
      {
        include: (path) => path.endsWith(".mdc"),
        maximumEntries: MAX_GUIDANCE_DIRECT_CANDIDATES_V1,
      },
    );
    for (const [path, metadata] of listed) {
      session.claimDirectCandidates([path]);
      ruleMetadata.set(path, metadata);
    }
  }
  // Shallower scopes win precedence ties, so native order follows scope depth before path order.
  const rulePaths = [...ruleMetadata.keys()].sort((left, right) => {
    const depthDifference = scopeDepth(left) - scopeDepth(right);
    return depthDifference === 0 ? (left < right ? -1 : left > right ? 1 : 0) : depthDifference;
  });

  const resolvedByDiscoveredPath = new Map<string, ResolvedBaseGuidanceBlobV1>();
  const alwaysApply = new Set<string>();
  const matchers = new Map<string, (candidatePath: string) => boolean>();
  for (const path of rulePaths) {
    const metadata = ruleMetadata.get(path);
    if (!metadata) throw new Error(`Cursor rule ${path} has no BASE metadata.`);
    const resolved = await resolveBaseGuidanceBlobV1(
      repositoryPath,
      manifest.source.baseCommit,
      path,
    );
    if (!resolved) throw new Error(`Cursor rule ${path} has no resolved BASE source.`);
    resolvedByDiscoveredPath.set(path, resolved);
    const frontmatter = parseCursorFrontmatterV1(
      path,
      await readBaseGuidanceFrontmatterV1(repositoryPath, resolved.resolvedPath, resolved.metadata),
    );
    if (frontmatter.mode === "agentRequested" || frontmatter.mode === "manual") {
      session.addDiagnostic(
        createGuidanceDiagnosticV1({
          code:
            frontmatter.mode === "manual"
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
    if (frontmatter.alwaysApply) alwaysApply.add(path);
    else if (frontmatter.globs.length > 0)
      matchers.set(path, compileGuidancePatternsV1(path, frontmatter.globs));
  }

  const family: GuidanceFamilyDiscoveryV1 = {
    familyId: "CURSOR",
    label: "Cursor rule",
    limitPath: CURSOR_RULES_SUFFIX_V1,
    importGraphLabel: "Cursor @filename reference graph",
    imports: {
      syntaxKind: "CURSOR_AT_FILENAME",
      maxDepth: 5,
      scan: scanCursorImportOccurrencesV1,
      resolvePath: resolveCursorImportPathV1,
      seedsTraversal: () => true,
    },
  };
  return await completeGuidanceDiscoveryV1(repositoryPath, manifest, session, family, {
    resolvedByDiscoveredPath,
    selectPathsForTarget: ({ applicabilityPath }) =>
      rulePaths.filter((path) => {
        if (
          !resolvedByDiscoveredPath.has(path) ||
          !targetWithinScope(applicabilityPath, ruleScope(path))
        )
          return false;
        return alwaysApply.has(path) || matchers.get(path)?.(applicabilityPath) === true;
      }),
    sourceKindFor: () => "CURSOR_RULE",
  });
}
