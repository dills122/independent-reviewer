import {
  buildGuidanceGraphV1,
  createGuidanceDiagnosticV1,
  type DirectGuidanceSourceInputV1,
  type GuidanceGraphV1,
  type GuidanceImportInputV1,
  MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1,
  MAX_GUIDANCE_EDGES_V1,
  MAX_GUIDANCE_NODES_V1,
  MAX_GUIDANCE_OCCURRENCES_V1,
  type SnapshotManifestV1,
} from "../contracts/index.js";
import {
  type BaseGuidanceBlobMetadataV1,
  GuidanceCaptureError,
  listBaseGuidanceBlobMetadataV1,
  readBaseMarkdownGuidanceSourceV1,
  resolveBaseGuidanceBlobV1,
} from "./base-markdown-source.js";
import { compileGuidancePatternsV1 } from "./conditional-patterns.js";
import { parseCursorFrontmatterV1 } from "./cursor-frontmatter.js";
import { resolveCursorImportPathV1, scanCursorImportOccurrencesV1 } from "./cursor-imports.js";
import {
  createGuidanceDiscoverySessionV1,
  type GuidanceDiscoverySessionV1,
} from "./discovery-capacity.js";
import { guidanceAncestorDirectoriesV1, guidancePathInDirectoryV1 } from "./discovery-paths.js";

const MAX_GUIDANCE_IMPORT_DEPTH_V1 = 5;
const CURSOR_RULES_SUFFIX_V1 = ".cursor/rules";

export interface CapturedCursorGuidanceV1 {
  graph: GuidanceGraphV1;
  blobs: ReadonlyMap<string, Uint8Array>;
}

function discoveryLimit(message: string): never {
  throw new GuidanceCaptureError(
    "GUIDANCE_DISCOVERY_LIMIT_EXCEEDED",
    CURSOR_RULES_SUFFIX_V1,
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
  throw new GuidanceCaptureError(
    code,
    path,
    `${path} has an invalid Cursor @filename reference graph.`,
  );
}

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

type LoadedSourceV1 = Awaited<ReturnType<typeof readBaseMarkdownGuidanceSourceV1>>;

/** Discovers deterministic always-on and glob-attached Cursor project rules from frozen BASE. */
export async function captureCursorGuidanceV1(
  repositoryPath: string,
  manifest: SnapshotManifestV1,
  session: GuidanceDiscoverySessionV1 = createGuidanceDiscoverySessionV1(manifest),
): Promise<CapturedCursorGuidanceV1> {
  const targets = session.targets;

  const ruleMetadata = new Map<string, BaseGuidanceBlobMetadataV1>();
  const roots = new Set<string>();
  for (const target of targets) {
    for (const directory of guidanceAncestorDirectoriesV1(target.applicabilityPath)) {
      roots.add(guidancePathInDirectoryV1(directory, CURSOR_RULES_SUFFIX_V1));
    }
  }
  for (const root of [...roots].sort()) {
    const listed = await listBaseGuidanceBlobMetadataV1(
      repositoryPath,
      manifest.source.baseCommit,
      root,
    );
    for (const [path, metadata] of listed) {
      if (path.endsWith(".mdc")) ruleMetadata.set(path, metadata);
    }
  }
  session.claimDirectCandidates([...ruleMetadata.keys()]);
  const rulePaths = [...ruleMetadata.keys()].sort((left, right) => {
    const depthDifference = scopeDepth(left) - scopeDepth(right);
    return depthDifference === 0 ? (left < right ? -1 : left > right ? 1 : 0) : depthDifference;
  });

  const sources = new Map<string, LoadedSourceV1>();
  const alwaysApply = new Set<string>();
  const matchers = new Map<string, (candidatePath: string) => boolean>();
  const diagnostics = [];
  for (const path of rulePaths) {
    const metadata = ruleMetadata.get(path);
    if (!metadata) throw new Error(`Cursor rule ${path} has no BASE metadata.`);
    const source = await readBaseMarkdownGuidanceSourceV1(repositoryPath, path, metadata);
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
      continue;
    }
    sources.set(path, source);
    const frontmatter = parseCursorFrontmatterV1(path, source.content);
    if (frontmatter.alwaysApply) alwaysApply.add(path);
    else if (frontmatter.globs.length > 0)
      matchers.set(path, compileGuidancePatternsV1(path, frontmatter.globs));
    else {
      diagnostics.push(
        createGuidanceDiagnosticV1({
          code: "UNSELECTED_MODEL_SELECTED_MODE",
          severity: "EXCLUSION",
          path,
          startUtf16: 0,
          omittedCount: null,
        }),
      );
    }
  }

  const directSources = new Map<string, DirectGuidanceSourceInputV1>();
  let recognitionCount = 0;
  for (const target of targets) {
    const selected = rulePaths.filter((path) => {
      if (!sources.has(path) || !targetWithinScope(target.applicabilityPath, ruleScope(path)))
        return false;
      return alwaysApply.has(path) || matchers.get(path)?.(target.applicabilityPath) === true;
    });
    selected.forEach((path, nativeOrder) => {
      recognitionCount += 1;
      if (recognitionCount > MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1)
        discoveryLimit(
          `more than ${MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1} recognitions were produced.`,
        );
      const source = sources.get(path);
      if (!source) throw new Error(`Selected Cursor rule ${path} was not loaded.`);
      const input = directSources.get(path) ?? {
        resolvedPath: path,
        contentDigest: source.contentDigest,
        directRecognitions: [],
      };
      const recognition = {
        familyId: "CURSOR",
        sourceKind: "CURSOR_RULE",
        nativeOrder,
        applicableTargetId: target.targetId,
        discoveredPath: path,
      } as const;
      session.claimDirectRecognition(input, recognition);
      input.directRecognitions.push(recognition);
      directSources.set(path, input);
    });
  }
  if (directSources.size > MAX_GUIDANCE_NODES_V1)
    discoveryLimit(`more than ${MAX_GUIDANCE_NODES_V1} applicable source nodes were selected.`);

  const graphSources = new Map(directSources);
  const importTargets = new Map<
    string,
    { input: Omit<GuidanceImportInputV1, "applicableTargetIds">; targetIds: Set<string> }
  >();
  const importScans = new Map<string, ReturnType<typeof scanCursorImportOccurrencesV1>>();
  let importEdgeCount = 0;
  const loadImportedSource = async (path: string) => {
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
    if (!importer) throw new Error(`Cursor import source ${importerPath} was not loaded.`);
    let occurrences = importScans.get(importerPath);
    if (!occurrences) {
      occurrences = scanCursorImportOccurrencesV1(importerPath, importer.content);
      importScans.set(importerPath, occurrences);
    }
    if (occurrences.length > 0 && depth >= MAX_GUIDANCE_IMPORT_DEPTH_V1)
      importFailure("GUIDANCE_IMPORT_DEPTH_LIMIT", importerPath);
    for (const occurrence of occurrences) {
      const occurrenceKey = session.claimOccurrence({
        familyId: "CURSOR",
        syntaxKind: "CURSOR_AT_FILENAME",
        importerPath,
        importerContentDigest: importer.contentDigest,
        requestedSpecifier: occurrence.requestedSpecifier,
        startUtf16: occurrence.startUtf16,
        endUtf16: occurrence.endUtf16,
      });
      const requestedPath = resolveCursorImportPathV1(importerPath, occurrence.requestedSpecifier);
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
          familyId: "CURSOR" as const,
          syntaxKind: "CURSOR_AT_FILENAME" as const,
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

  for (const [path, input] of directSources) {
    for (const { applicableTargetId } of input.directRecognitions) {
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
        if (!source) throw new Error(`Applicable Cursor source ${path} was not loaded.`);
        return [source.contentDigest.value, Uint8Array.from(source.bytes)];
      }),
    ),
  };
}
