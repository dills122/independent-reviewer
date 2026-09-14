import { posix } from "node:path";

import {
  buildGuidanceGraphV1,
  createGuidanceDiagnosticV1,
  type DirectGuidanceSourceInputV1,
  type GuidanceGraphV1,
  type GuidanceImportInputV1,
  MAX_GUIDANCE_DIRECT_CANDIDATES_V1,
  MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1,
  MAX_GUIDANCE_EDGES_V1,
  MAX_GUIDANCE_NODES_V1,
  MAX_GUIDANCE_OCCURRENCES_V1,
  type SnapshotManifestV1,
} from "../contracts/index.js";
import {
  baseGuidanceBlobMetadataV1,
  GuidanceCaptureError,
  listBaseGuidanceBlobMetadataV1,
  readBaseMarkdownGuidanceSourceV1,
  readResolvedBaseMarkdownGuidanceSourceV1,
  resolveBaseGuidanceBlobV1,
} from "./base-markdown-source.js";
import {
  createGuidanceDiscoverySessionV1,
  type GuidanceDiscoverySessionV1,
} from "./discovery-capacity.js";
import { buildGeminiIgnoreMatcherV1 } from "./gemini-ignore.js";
import { resolveGeminiImportPathV1, scanGeminiImportOccurrencesV1 } from "./gemini-imports.js";
import { parseGeminiSettingsV1 } from "./gemini-settings.js";

const MAX_GUIDANCE_IMPORT_DEPTH_V1 = 5;
const SETTINGS_PATH_V1 = ".gemini/settings.json";

export interface CapturedGeminiGuidanceV1 {
  graph: GuidanceGraphV1;
  blobs: ReadonlyMap<string, Uint8Array>;
}

function discoveryLimit(message: string): never {
  throw new GuidanceCaptureError(
    "GUIDANCE_DISCOVERY_LIMIT_EXCEEDED",
    "GEMINI.md",
    `Guidance discovery limit exceeded: ${message}`,
  );
}

function importFailure(
  code:
    | "GUIDANCE_IMPORT_CYCLE"
    | "GUIDANCE_IMPORT_DEPTH_LIMIT"
    | "GUIDANCE_IMPORT_EDGE_LIMIT"
    | "GUIDANCE_IMPORT_EMPTY"
    | "GUIDANCE_IMPORT_UNRESOLVED",
  path: string,
): never {
  throw new GuidanceCaptureError(code, path, `${path} has an invalid Gemini @path import graph.`);
}

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
  const targets = session.targets;

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

  const ignoreMetadata = await listBaseGuidanceBlobMetadataV1(
    repositoryPath,
    manifest.source.baseCommit,
    ".",
    {
      include: (path) => {
        const basename = posix.basename(path);
        return (
          (settings.respectGitIgnore && basename === ".gitignore") ||
          (settings.respectGeminiIgnore && basename === ".geminiignore")
        );
      },
      maximumEntries: MAX_GUIDANCE_DIRECT_CANDIDATES_V1,
    },
  );
  const ignorePaths = [...ignoreMetadata.keys()].filter((path) => {
    const basename = posix.basename(path);
    return (
      (settings.respectGitIgnore && basename === ".gitignore") ||
      (settings.respectGeminiIgnore && basename === ".geminiignore")
    );
  });
  const ignoreDocuments = [];
  for (const path of ignorePaths.sort()) {
    const metadata = ignoreMetadata.get(path);
    if (!metadata) throw new Error(`Gemini ignore source ${path} has no BASE metadata.`);
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
  const contextPaths = [...contextMetadata.keys()]
    .filter((path) => !isIgnored(path))
    .sort((left, right) => pathDepth(left) - pathDepth(right) || (left < right ? -1 : 1));
  session.claimDirectCandidates(contextPaths);

  const sources = new Map<string, Awaited<ReturnType<typeof readBaseMarkdownGuidanceSourceV1>>>();
  const directSourcesByDiscoveredPath = new Map<
    string,
    {
      resolvedPath: string;
      source: Awaited<ReturnType<typeof readBaseMarkdownGuidanceSourceV1>>;
    }
  >();
  const diagnostics = settings.unknownSettingOffsets.map((startUtf16) =>
    createGuidanceDiagnosticV1({
      code: "UNKNOWN_SETTING_IGNORED",
      severity: "WARNING",
      path: SETTINGS_PATH_V1,
      startUtf16,
      omittedCount: null,
    }),
  );
  for (const path of contextPaths) {
    const metadata = contextMetadata.get(path);
    if (!metadata) throw new Error(`Gemini context ${path} has no BASE metadata.`);
    const loaded = await readResolvedBaseMarkdownGuidanceSourceV1(
      repositoryPath,
      manifest.source.baseCommit,
      path,
    );
    if (!loaded) throw new Error(`Gemini context ${path} has no resolved BASE source.`);
    const { source } = loaded;
    if (source.content.trim().length === 0) {
      diagnostics.push(
        createGuidanceDiagnosticV1({
          code: "EMPTY_SOURCE",
          severity: "WARNING",
          path,
          startUtf16: 0,
          omittedCount: null,
        }),
      );
    } else {
      sources.set(loaded.resolvedPath, source);
      directSourcesByDiscoveredPath.set(path, loaded);
    }
  }

  const selectedPaths = contextPaths.filter((path) => directSourcesByDiscoveredPath.has(path));
  if (selectedPaths.length > MAX_GUIDANCE_NODES_V1)
    discoveryLimit(`more than ${MAX_GUIDANCE_NODES_V1} applicable source nodes were selected.`);
  const directSources = new Map<string, DirectGuidanceSourceInputV1>();
  let recognitionCount = 0;
  for (const target of targets) {
    selectedPaths.forEach((path, nativeOrder) => {
      recognitionCount += 1;
      if (recognitionCount > MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1)
        discoveryLimit(
          `more than ${MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1} recognitions were produced.`,
        );
      const direct = directSourcesByDiscoveredPath.get(path);
      if (!direct) throw new Error(`Selected Gemini context ${path} was not loaded.`);
      const input = directSources.get(direct.resolvedPath) ?? {
        resolvedPath: direct.resolvedPath,
        contentDigest: direct.source.contentDigest,
        directRecognitions: [],
      };
      const recognition = {
        familyId: "GEMINI",
        sourceKind: "GEMINI_CONTEXT",
        nativeOrder,
        applicableTargetId: target.targetId,
        discoveredPath: path,
      } as const;
      session.claimDirectRecognition(input, recognition);
      input.directRecognitions.push(recognition);
      directSources.set(direct.resolvedPath, input);
    });
  }

  const importTargets = new Map<
    string,
    { input: Omit<GuidanceImportInputV1, "applicableTargetIds">; targetIds: Set<string> }
  >();
  const graphSources = new Map<string, DirectGuidanceSourceInputV1>(directSources);
  const importScans = new Map<string, ReturnType<typeof scanGeminiImportOccurrencesV1>>();
  let importEdgeCount = 0;
  const loadImportedSource = async (path: string) => {
    if (isIgnored(path)) importFailure("GUIDANCE_IMPORT_UNRESOLVED", path);
    const resolved = await resolveBaseGuidanceBlobV1(
      repositoryPath,
      manifest.source.baseCommit,
      path,
    );
    if (!resolved) importFailure("GUIDANCE_IMPORT_UNRESOLVED", path);
    const existing = sources.get(resolved.resolvedPath);
    if (existing) return { resolvedPath: resolved.resolvedPath, source: existing };
    const source = await readBaseMarkdownGuidanceSourceV1(
      repositoryPath,
      resolved.resolvedPath,
      resolved.metadata,
    );
    if (source.content.trim().length === 0)
      importFailure("GUIDANCE_IMPORT_EMPTY", resolved.resolvedPath);
    sources.set(resolved.resolvedPath, source);
    return { resolvedPath: resolved.resolvedPath, source };
  };
  const traverseImports = async (
    importerPath: string,
    applicableTargetId: string,
    depth: number,
    ancestry: ReadonlySet<string>,
  ): Promise<void> => {
    const importer = sources.get(importerPath);
    if (!importer) throw new Error(`Gemini import source ${importerPath} was not loaded.`);
    let occurrences = importScans.get(importerPath);
    if (!occurrences) {
      occurrences = scanGeminiImportOccurrencesV1(importerPath, importer.content);
      importScans.set(importerPath, occurrences);
    }
    if (occurrences.length > 0 && depth >= MAX_GUIDANCE_IMPORT_DEPTH_V1)
      importFailure("GUIDANCE_IMPORT_DEPTH_LIMIT", importerPath);
    for (const occurrence of occurrences) {
      const occurrenceKey = session.claimOccurrence({
        familyId: "GEMINI",
        syntaxKind: "GEMINI_AT_PATH",
        importerPath,
        importerContentDigest: importer.contentDigest,
        requestedSpecifier: occurrence.requestedSpecifier,
        startUtf16: occurrence.startUtf16,
        endUtf16: occurrence.endUtf16,
      });
      const requestedPath = resolveGeminiImportPathV1(importerPath, occurrence.requestedSpecifier);
      const { resolvedPath: importedPath, source: imported } =
        await loadImportedSource(requestedPath);
      if (ancestry.has(importedPath)) importFailure("GUIDANCE_IMPORT_CYCLE", importedPath);
      const key = JSON.stringify([
        importerPath,
        importer.contentDigest.value,
        occurrence.requestedSpecifier,
        occurrence.startUtf16,
        occurrence.endUtf16,
        importedPath,
        imported.contentDigest.value,
      ]);
      const accumulated = importTargets.get(key) ?? {
        input: {
          familyId: "GEMINI" as const,
          syntaxKind: "GEMINI_AT_PATH" as const,
          importerPath,
          importerContentDigest: importer.contentDigest,
          importedPath,
          importedContentDigest: imported.contentDigest,
          requestedSpecifier: occurrence.requestedSpecifier,
          startUtf16: occurrence.startUtf16,
          endUtf16: occurrence.endUtf16,
        },
        targetIds: new Set<string>(),
      };
      if (!accumulated.targetIds.has(applicableTargetId)) {
        session.claimImportEdge(
          occurrenceKey,
          { resolvedPath: importedPath, contentDigest: imported.contentDigest },
          applicableTargetId,
        );
        accumulated.targetIds.add(applicableTargetId);
        importEdgeCount += 1;
      }
      importTargets.set(key, accumulated);
      if (importTargets.size > MAX_GUIDANCE_OCCURRENCES_V1)
        discoveryLimit(
          `more than ${MAX_GUIDANCE_OCCURRENCES_V1} import occurrences were produced.`,
        );
      if (importEdgeCount > MAX_GUIDANCE_EDGES_V1)
        importFailure("GUIDANCE_IMPORT_EDGE_LIMIT", importerPath);
      const existingGraphSource = graphSources.get(importedPath);
      graphSources.set(
        importedPath,
        existingGraphSource ?? {
          resolvedPath: importedPath,
          contentDigest: imported.contentDigest,
          directRecognitions: [],
        },
      );
      if (graphSources.size > MAX_GUIDANCE_NODES_V1)
        discoveryLimit(`more than ${MAX_GUIDANCE_NODES_V1} applicable source nodes were selected.`);
      await traverseImports(
        importedPath,
        applicableTargetId,
        depth + 1,
        new Set([...ancestry, importedPath]),
      );
    }
  };

  for (const [path, source] of directSources) {
    for (const applicableTargetId of source.directRecognitions.map(
      ({ applicableTargetId }) => applicableTargetId,
    )) {
      await traverseImports(path, applicableTargetId, 0, new Set([path]));
    }
  }
  const imports: GuidanceImportInputV1[] = [...importTargets.values()].map(
    ({ input, targetIds }) => ({ ...input, applicableTargetIds: [...targetIds].sort() }),
  );

  for (const diagnostic of diagnostics) session.addDiagnostic(diagnostic);
  return {
    graph: buildGuidanceGraphV1(
      manifest,
      [...graphSources.values()],
      imports,
      session.finalizeDiagnostics(),
    ),
    blobs: new Map(
      [...graphSources.keys()].map((path) => {
        const source = sources.get(path);
        if (!source) throw new Error(`Applicable Gemini guidance ${path} was not loaded.`);
        return [source.contentDigest.value, Uint8Array.from(source.bytes)];
      }),
    ),
  };
}
