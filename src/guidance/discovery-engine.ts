import {
  buildGuidanceGraphV1,
  createGuidanceDiagnosticV1,
  type DirectGuidanceRecognitionV1,
  type DirectGuidanceSourceInputV1,
  type GuidanceFamilyV1,
  type GuidanceGraphV1,
  type GuidanceImportInputV1,
  type GuidanceImportSyntaxKindV1,
  type GuidanceSourceKindV1,
  type GuidanceTargetV1,
  MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1,
  MAX_GUIDANCE_EDGES_V1,
  MAX_GUIDANCE_NODES_V1,
  MAX_GUIDANCE_OCCURRENCES_V1,
  type SnapshotManifestV1,
} from "../contracts/index.js";
import {
  type BaseMarkdownGuidanceSourceV1,
  GuidanceCaptureError,
  type ResolvedBaseGuidanceBlobV1,
  readBaseMarkdownGuidanceSourceV1,
  resolveBaseGuidanceBlobV1,
} from "./base-markdown-source.js";
import type { GuidanceDiscoverySessionV1 } from "./discovery-capacity.js";

/** Every family's import scanner reports the same three fields, so the engine needs only these. */
export interface GuidanceImportOccurrenceV1 {
  requestedSpecifier: string;
  startUtf16: number;
  endUtf16: number;
}

export interface CapturedGuidanceV1 {
  graph: GuidanceGraphV1;
  blobs: ReadonlyMap<string, Uint8Array>;
}

export type GuidanceImportFailureCodeV1 =
  | "GUIDANCE_IMPORT_CYCLE"
  | "GUIDANCE_IMPORT_DEPTH_LIMIT"
  | "GUIDANCE_IMPORT_EDGE_LIMIT"
  | "GUIDANCE_IMPORT_EMPTY"
  | "GUIDANCE_IMPORT_UNRESOLVED";

/** How one family expresses, resolves and reaches imports between guidance sources. */
export interface GuidanceImportSyntaxV1 {
  syntaxKind: GuidanceImportSyntaxKindV1;
  /** Hops allowed from a directly recognized source before GUIDANCE_IMPORT_DEPTH_LIMIT. */
  maxDepth: number;
  scan(importerPath: string, content: string): readonly GuidanceImportOccurrenceV1[];
  resolvePath(importerPath: string, requestedSpecifier: string): string;
  /**
   * Optional gate applied to a resolved import path before the BASE blob is read. A family whose
   * tooling hides paths from itself (Gemini's ignore files) reports them unresolved rather than
   * importing content the real agent would never see.
   */
  isReachable?(path: string): boolean;
  /** Only sources reached through a recognition matching this follow their imports. */
  seedsTraversal(recognition: DirectGuidanceRecognitionV1): boolean;
}

export interface GuidanceFamilyDiscoveryV1 {
  familyId: GuidanceFamilyV1;
  /** Names the family in invariant and import-failure messages, e.g. "Claude guidance". */
  label: string;
  /** Path reported when a discovery cap is exceeded; identifies the family in the error. */
  limitPath: string;
  /** Names the family's import syntax in failure messages, e.g. "Claude @path import graph". */
  importGraphLabel: string;
  imports: GuidanceImportSyntaxV1;
}

/**
 * What a family decided before the shared pipeline runs: which BASE blobs it resolved, which of
 * them each target recognizes and in what native order, and how each is classified.
 */
export interface GuidanceSelectionV1 {
  resolvedByDiscoveredPath: ReadonlyMap<string, ResolvedBaseGuidanceBlobV1>;
  selectPathsForTarget(target: GuidanceTargetV1): readonly string[];
  sourceKindFor(discoveredPath: string): GuidanceSourceKindV1;
}

export function guidanceDiscoveryLimitV1(
  family: GuidanceFamilyDiscoveryV1,
  message: string,
): never {
  throw new GuidanceCaptureError(
    "GUIDANCE_DISCOVERY_LIMIT_EXCEEDED",
    family.limitPath,
    `Guidance discovery limit exceeded: ${message}`,
  );
}

function importFailure(
  family: GuidanceFamilyDiscoveryV1,
  code: GuidanceImportFailureCodeV1,
  path: string,
): never {
  throw new GuidanceCaptureError(code, path, `${path} has an invalid ${family.importGraphLabel}.`);
}

/**
 * Runs the part of discovery every family shares: loading the selected BASE sources, producing
 * direct recognitions in native order, expanding the import graph, and building the graph and
 * blob set.
 *
 * Families differ only in which paths they consider and how they classify them, so that decision
 * arrives already made in `selection` and everything after it is single-sourced here. The five
 * families previously each carried their own copy of this pipeline, and it had already drifted:
 * only one retained the conflicting-content-identity guard below.
 */
export async function completeGuidanceDiscoveryV1(
  repositoryPath: string,
  manifest: SnapshotManifestV1,
  session: GuidanceDiscoverySessionV1,
  family: GuidanceFamilyDiscoveryV1,
  selection: GuidanceSelectionV1,
): Promise<CapturedGuidanceV1> {
  const { resolvedByDiscoveredPath } = selection;
  const selectedPaths = new Set<string>();
  for (const target of session.targets) {
    for (const path of selection.selectPathsForTarget(target)) selectedPaths.add(path);
  }

  const sources = new Map<string, BaseMarkdownGuidanceSourceV1>();
  const directSourcesByDiscoveredPath = new Map<
    string,
    { resolvedPath: string; source: BaseMarkdownGuidanceSourceV1 }
  >();
  for (const path of [...selectedPaths].sort()) {
    const resolved = resolvedByDiscoveredPath.get(path);
    if (!resolved) throw new Error(`Selected ${family.label} ${path} was not resolved.`);
    const source = await readBaseMarkdownGuidanceSourceV1(
      repositoryPath,
      resolved.resolvedPath,
      resolved.metadata,
    );
    if (source.content.trim().length === 0) {
      session.addDiagnostic(
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
    sources.set(resolved.resolvedPath, source);
    directSourcesByDiscoveredPath.set(path, { resolvedPath: resolved.resolvedPath, source });
  }

  const directSources = new Map<string, DirectGuidanceSourceInputV1>();
  let recognitionCount = 0;
  for (const target of session.targets) {
    const selected = selection
      .selectPathsForTarget(target)
      .filter((path) => directSourcesByDiscoveredPath.has(path));
    selected.forEach((path, nativeOrder) => {
      recognitionCount += 1;
      if (recognitionCount > MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1)
        guidanceDiscoveryLimitV1(
          family,
          `more than ${MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1} recognitions were produced.`,
        );
      const direct = directSourcesByDiscoveredPath.get(path);
      if (!direct) throw new Error(`Selected ${family.label} ${path} was not loaded.`);
      const input = directSources.get(direct.resolvedPath) ?? {
        resolvedPath: direct.resolvedPath,
        contentDigest: direct.source.contentDigest,
        directRecognitions: [],
      };
      const recognition: DirectGuidanceRecognitionV1 = {
        familyId: family.familyId,
        sourceKind: selection.sourceKindFor(path),
        nativeOrder,
        applicableTargetId: target.targetId,
        discoveredPath: path,
      };
      session.claimDirectRecognition(input, recognition);
      input.directRecognitions.push(recognition);
      directSources.set(direct.resolvedPath, input);
    });
  }
  if (directSources.size > MAX_GUIDANCE_NODES_V1)
    guidanceDiscoveryLimitV1(
      family,
      `more than ${MAX_GUIDANCE_NODES_V1} applicable source nodes were selected.`,
    );

  const importTargets = new Map<
    string,
    { input: Omit<GuidanceImportInputV1, "applicableTargetIds">; targetIds: Set<string> }
  >();
  const graphSources = new Map<string, DirectGuidanceSourceInputV1>(directSources);
  const importScans = new Map<string, readonly GuidanceImportOccurrenceV1[]>();
  let importEdgeCount = 0;

  const loadImportedSource = async (path: string) => {
    if (family.imports.isReachable?.(path) === false)
      importFailure(family, "GUIDANCE_IMPORT_UNRESOLVED", path);
    const resolved = await resolveBaseGuidanceBlobV1(
      repositoryPath,
      manifest.source.baseCommit,
      path,
    );
    if (!resolved) importFailure(family, "GUIDANCE_IMPORT_UNRESOLVED", path);
    const existing = sources.get(resolved.resolvedPath);
    if (existing) return { resolvedPath: resolved.resolvedPath, source: existing };
    const source = await readBaseMarkdownGuidanceSourceV1(
      repositoryPath,
      resolved.resolvedPath,
      resolved.metadata,
    );
    if (source.content.trim().length === 0)
      importFailure(family, "GUIDANCE_IMPORT_EMPTY", resolved.resolvedPath);
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
    if (!importer) throw new Error(`${family.label} import source ${importerPath} was not loaded.`);
    let occurrences = importScans.get(importerPath);
    if (!occurrences) {
      occurrences = family.imports.scan(importerPath, importer.content);
      importScans.set(importerPath, occurrences);
    }
    if (occurrences.length > 0 && depth >= family.imports.maxDepth)
      importFailure(family, "GUIDANCE_IMPORT_DEPTH_LIMIT", importerPath);
    for (const occurrence of occurrences) {
      const occurrenceKey = session.claimOccurrence({
        familyId: family.familyId,
        syntaxKind: family.imports.syntaxKind,
        importerPath,
        importerContentDigest: importer.contentDigest,
        requestedSpecifier: occurrence.requestedSpecifier,
        startUtf16: occurrence.startUtf16,
        endUtf16: occurrence.endUtf16,
      });
      const requestedPath = family.imports.resolvePath(importerPath, occurrence.requestedSpecifier);
      const { resolvedPath: importedPath, source: imported } =
        await loadImportedSource(requestedPath);
      if (ancestry.has(importedPath)) importFailure(family, "GUIDANCE_IMPORT_CYCLE", importedPath);
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
          familyId: family.familyId,
          syntaxKind: family.imports.syntaxKind,
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
        guidanceDiscoveryLimitV1(
          family,
          `more than ${MAX_GUIDANCE_OCCURRENCES_V1} import occurrences were produced.`,
        );
      if (importEdgeCount > MAX_GUIDANCE_EDGES_V1)
        importFailure(family, "GUIDANCE_IMPORT_EDGE_LIMIT", importerPath);
      const existingGraphSource = graphSources.get(importedPath);
      if (
        existingGraphSource &&
        existingGraphSource.contentDigest.value !== imported.contentDigest.value
      ) {
        throw new Error(`Guidance source ${importedPath} has conflicting BASE content identity.`);
      }
      graphSources.set(
        importedPath,
        existingGraphSource ?? {
          resolvedPath: importedPath,
          contentDigest: imported.contentDigest,
          directRecognitions: [],
        },
      );
      if (graphSources.size > MAX_GUIDANCE_NODES_V1)
        guidanceDiscoveryLimitV1(
          family,
          `more than ${MAX_GUIDANCE_NODES_V1} applicable source nodes were selected.`,
        );
      await traverseImports(
        importedPath,
        applicableTargetId,
        depth + 1,
        new Set([...ancestry, importedPath]),
      );
    }
  };

  for (const [path, source] of directSources) {
    for (const recognition of source.directRecognitions) {
      if (!family.imports.seedsTraversal(recognition)) continue;
      await traverseImports(path, recognition.applicableTargetId, 0, new Set([path]));
    }
  }

  const imports: GuidanceImportInputV1[] = [...importTargets.values()].map(
    ({ input, targetIds }) => ({ ...input, applicableTargetIds: [...targetIds].sort() }),
  );
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
        if (!source) throw new Error(`Applicable ${family.label} ${path} was not loaded.`);
        return [source.contentDigest.value, Uint8Array.from(source.bytes)];
      }),
    ),
  };
}
