import { posix } from "node:path";

import {
  createGuidanceDiagnosticV1,
  MAX_GUIDANCE_DIRECT_CANDIDATES_V1,
  type SnapshotManifestV1,
} from "../contracts/index.js";
import {
  baseGuidanceBlobMetadataV1,
  listBaseGuidanceBlobMetadataV1,
  type ResolvedBaseGuidanceBlobV1,
  readResolvedBaseMarkdownGuidanceSourceV1,
  resolveBaseGuidanceBlobV1,
} from "./base-markdown-source.js";
import {
  createGuidanceDiscoverySessionV1,
  type GuidanceDiscoverySessionV1,
} from "./discovery-capacity.js";
import {
  type CapturedGuidanceV1,
  completeGuidanceDiscoveryV1,
  type GuidanceFamilyDiscoveryV1,
} from "./discovery-engine.js";
import { buildGeminiIgnoreMatcherV1 } from "./gemini-ignore.js";
import { resolveGeminiImportPathV1, scanGeminiImportOccurrencesV1 } from "./gemini-imports.js";
import { parseGeminiSettingsV1 } from "./gemini-settings.js";

const SETTINGS_PATH_V1 = ".gemini/settings.json";

export type CapturedGeminiGuidanceV1 = CapturedGuidanceV1;

function pathDepth(path: string): number {
  const directory = posix.dirname(path);
  return directory === "." ? 0 : directory.split("/").length;
}

/** Discovers Gemini context sources and imports from frozen BASE. */
export async function captureGeminiGuidanceV1(
  repositoryPath: string,
  manifest: SnapshotManifestV1,
  session: GuidanceDiscoverySessionV1 = createGuidanceDiscoverySessionV1(manifest),
): Promise<CapturedGeminiGuidanceV1> {
  const settingsMetadata = await baseGuidanceBlobMetadataV1(
    repositoryPath,
    manifest.source.baseCommit,
    SETTINGS_PATH_V1,
  );
  const settings = settingsMetadata
    ? parseGeminiSettingsV1(
        SETTINGS_PATH_V1,
        (
          await readResolvedBaseMarkdownGuidanceSourceV1(
            repositoryPath,
            manifest.source.baseCommit,
            SETTINGS_PATH_V1,
          )
        )?.source.content ?? "",
      )
    : {
        contextFileNames: ["GEMINI.md"],
        respectGitIgnore: true,
        respectGeminiIgnore: true,
        unknownSettingOffsets: [],
      };
  for (const startUtf16 of settings.unknownSettingOffsets) {
    session.addDiagnostic(
      createGuidanceDiagnosticV1({
        code: "UNKNOWN_SETTING_IGNORED",
        severity: "WARNING",
        path: SETTINGS_PATH_V1,
        startUtf16,
        omittedCount: null,
      }),
    );
  }

  const isIgnoreSource = (path: string): boolean => {
    const basename = posix.basename(path);
    return (
      (settings.respectGitIgnore && basename === ".gitignore") ||
      (settings.respectGeminiIgnore && basename === ".geminiignore")
    );
  };
  const ignoreMetadata = await listBaseGuidanceBlobMetadataV1(
    repositoryPath,
    manifest.source.baseCommit,
    ".",
    { include: isIgnoreSource, maximumEntries: MAX_GUIDANCE_DIRECT_CANDIDATES_V1 },
  );
  const ignoreDocuments = [];
  for (const path of [...ignoreMetadata.keys()].filter(isIgnoreSource).sort()) {
    const loaded = await readResolvedBaseMarkdownGuidanceSourceV1(
      repositoryPath,
      manifest.source.baseCommit,
      path,
    );
    if (!loaded) throw new Error(`Gemini ignore source ${path} has no resolved BASE source.`);
    ignoreDocuments.push({ path, content: loaded.source.content });
  }
  const isIgnored = buildGeminiIgnoreMatcherV1(ignoreDocuments);

  const configuredNames = new Set(settings.contextFileNames);
  const contextMetadata = await listBaseGuidanceBlobMetadataV1(
    repositoryPath,
    manifest.source.baseCommit,
    ".",
    {
      include: (path) => configuredNames.has(posix.basename(path)),
      maximumEntries: MAX_GUIDANCE_DIRECT_CANDIDATES_V1,
    },
  );
  // Shallower context files are read first by Gemini, so native order follows directory depth.
  const contextPaths = [...contextMetadata.keys()]
    .filter((path) => !isIgnored(path))
    .sort((left, right) => pathDepth(left) - pathDepth(right) || (left < right ? -1 : 1));
  session.claimDirectCandidates(contextPaths);

  const resolvedByDiscoveredPath = new Map<string, ResolvedBaseGuidanceBlobV1>();
  for (const path of contextPaths) {
    if (!contextMetadata.has(path)) throw new Error(`Gemini context ${path} has no BASE metadata.`);
    const resolved = await resolveBaseGuidanceBlobV1(
      repositoryPath,
      manifest.source.baseCommit,
      path,
    );
    if (!resolved) throw new Error(`Gemini context ${path} has no resolved BASE source.`);
    resolvedByDiscoveredPath.set(path, resolved);
  }

  const family: GuidanceFamilyDiscoveryV1 = {
    familyId: "GEMINI",
    label: "Gemini context",
    limitPath: "GEMINI.md",
    importGraphLabel: "Gemini @path import graph",
    imports: {
      syntaxKind: "GEMINI_AT_PATH",
      maxDepth: 5,
      scan: scanGeminiImportOccurrencesV1,
      resolvePath: resolveGeminiImportPathV1,
      isReachable: (path) => !isIgnored(path),
      seedsTraversal: () => true,
    },
  };
  return await completeGuidanceDiscoveryV1(repositoryPath, manifest, session, family, {
    resolvedByDiscoveredPath,
    selectPathsForTarget: () => contextPaths,
    sourceKindFor: () => "GEMINI_CONTEXT",
  });
}
