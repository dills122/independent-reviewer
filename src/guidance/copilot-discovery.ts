import {
  type GuidanceSourceKindV1,
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
import { parseCopilotFrontmatterV1 } from "./copilot-frontmatter.js";
import { resolveCopilotImportPathV1, scanCopilotImportOccurrencesV1 } from "./copilot-imports.js";
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

const REPOSITORY_PATH_V1 = ".github/copilot-instructions.md";
const MODULAR_ROOT_V1 = ".github/instructions";
const DOT_CLAUDE_PATH_V1 = ".claude/CLAUDE.md";
/** Copilot reads these per-directory files in this precedence order after the repository file. */
const ANCESTOR_FILENAMES_V1 = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] as const;

export type CapturedCopilotGuidanceV1 = CapturedGuidanceV1;

/** Discovers deterministic repository-owned Copilot guidance from frozen BASE. */
export async function captureCopilotGuidanceV1(
  repositoryPath: string,
  manifest: SnapshotManifestV1,
  session: GuidanceDiscoverySessionV1 = createGuidanceDiscoverySessionV1(manifest),
): Promise<CapturedCopilotGuidanceV1> {
  const ancestorsByTarget = new Map(
    session.targets.map((target) => [
      target.targetId,
      guidanceAncestorDirectoriesV1(target.applicabilityPath),
    ]),
  );
  const fixedCandidates = new Set<string>([REPOSITORY_PATH_V1, DOT_CLAUDE_PATH_V1]);
  for (const directories of ancestorsByTarget.values()) {
    for (const directory of directories) {
      for (const filename of ANCESTOR_FILENAMES_V1) {
        fixedCandidates.add(guidancePathInDirectoryV1(directory, filename));
      }
    }
  }
  const modularMetadata = await listBaseGuidanceBlobMetadataV1(
    repositoryPath,
    manifest.source.baseCommit,
    MODULAR_ROOT_V1,
    {
      include: (path) => path.endsWith(".instructions.md"),
      maximumEntries: MAX_GUIDANCE_DIRECT_CANDIDATES_V1,
    },
  );
  const modularPaths = [...modularMetadata.keys()].sort();
  session.claimDirectCandidates([...fixedCandidates, ...modularPaths]);

  const metadataByPath = new Map<string, BaseGuidanceBlobMetadataV1>();
  for (const path of modularPaths) {
    const metadata = modularMetadata.get(path);
    if (!metadata) throw new Error(`Copilot modular source ${path} has no BASE metadata.`);
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
  const modularMatchers = new Map<string, (candidatePath: string) => boolean>();
  const excludedModular = new Set<string>();
  for (const path of [...metadataByPath.keys()].sort()) {
    if (!metadataByPath.has(path))
      throw new Error(`Copilot guidance source ${path} has no BASE metadata.`);
    const resolved = await resolveBaseGuidanceBlobV1(
      repositoryPath,
      manifest.source.baseCommit,
      path,
    );
    if (!resolved) throw new Error(`Copilot guidance source ${path} has no resolved BASE source.`);
    resolvedByDiscoveredPath.set(path, resolved);
    if (!modularPaths.includes(path)) continue;
    const frontmatter = parseCopilotFrontmatterV1(
      path,
      await readBaseGuidanceFrontmatterV1(repositoryPath, resolved.resolvedPath, resolved.metadata),
    );
    if (frontmatter.excludesCodeReview) excludedModular.add(path);
    else modularMatchers.set(path, compileGuidancePatternsV1(path, frontmatter.applyTo));
  }

  const sourceKindFor = (path: string): GuidanceSourceKindV1 =>
    path === REPOSITORY_PATH_V1
      ? "COPILOT_REPOSITORY"
      : modularPaths.includes(path)
        ? "COPILOT_MODULAR"
        : path.endsWith("AGENTS.md")
          ? "COPILOT_AGENTS"
          : path === DOT_CLAUDE_PATH_V1
            ? "COPILOT_DOT_CLAUDE"
            : path.endsWith("CLAUDE.md")
              ? "COPILOT_CLAUDE"
              : "COPILOT_GEMINI";

  const family: GuidanceFamilyDiscoveryV1 = {
    familyId: "COPILOT",
    label: "Copilot guidance source",
    limitPath: REPOSITORY_PATH_V1,
    importGraphLabel: "Copilot @path import graph",
    imports: {
      syntaxKind: "COPILOT_AT_PATH",
      maxDepth: 5,
      scan: scanCopilotImportOccurrencesV1,
      resolvePath: resolveCopilotImportPathV1,
      // Modular instructions and borrowed Gemini context are leaves: Copilot does not expand
      // their references, so following them would transmit content the real agent never reads.
      seedsTraversal: ({ sourceKind }) =>
        sourceKind !== "COPILOT_MODULAR" && sourceKind !== "COPILOT_GEMINI",
    },
  };
  return await completeGuidanceDiscoveryV1(repositoryPath, manifest, session, family, {
    resolvedByDiscoveredPath,
    selectPathsForTarget: ({ targetId, applicabilityPath }) => {
      const directories = ancestorsByTarget.get(targetId) ?? [];
      const ancestors = (filename: string) =>
        directories
          .map((directory) => guidancePathInDirectoryV1(directory, filename))
          .filter((path) => resolvedByDiscoveredPath.has(path));
      return [
        ...new Set([
          ...(resolvedByDiscoveredPath.has(REPOSITORY_PATH_V1) ? [REPOSITORY_PATH_V1] : []),
          ...ancestors("AGENTS.md"),
          ...ancestors("CLAUDE.md"),
          ...(resolvedByDiscoveredPath.has(DOT_CLAUDE_PATH_V1) ? [DOT_CLAUDE_PATH_V1] : []),
          ...ancestors("GEMINI.md"),
          ...modularPaths.filter(
            (path) =>
              !excludedModular.has(path) && modularMatchers.get(path)?.(applicabilityPath) === true,
          ),
        ]),
      ];
    },
    sourceKindFor,
  });
}
