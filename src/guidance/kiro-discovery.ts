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
  type BaseGuidanceBlobMetadataV1,
  baseGuidanceBlobMetadataV1,
  GuidanceCaptureError,
  listBaseGuidanceBlobMetadataV1,
  readBaseGuidanceFrontmatterV1,
  readBaseMarkdownGuidanceSourceV1,
  resolveBaseGuidanceBlobV1,
} from "./base-markdown-source.js";
import { compileGuidancePatternsV1 } from "./conditional-patterns.js";
import {
  createGuidanceDiscoverySessionV1,
  type GuidanceDiscoverySessionV1,
} from "./discovery-capacity.js";
import { guidanceAncestorDirectoriesV1, guidancePathInDirectoryV1 } from "./discovery-paths.js";
import { parseKiroSteeringFrontmatterV1 } from "./kiro-frontmatter.js";
import {
  resolveKiroFileReferencePathV1,
  scanKiroFileReferenceOccurrencesV1,
} from "./kiro-imports.js";

const MAX_GUIDANCE_IMPORT_DEPTH_V1 = 5;
const KIRO_STEERING_ROOT_V1 = ".kiro/steering";

export interface CapturedKiroGuidanceV1 {
  graph: GuidanceGraphV1;
  blobs: ReadonlyMap<string, Uint8Array>;
}

function discoveryLimit(message: string): never {
  throw new GuidanceCaptureError(
    "GUIDANCE_DISCOVERY_LIMIT_EXCEEDED",
    ".kiro/steering",
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
  throw new GuidanceCaptureError(code, path, `${path} has an invalid Kiro file-reference graph.`);
}

/** Discovers Kiro AGENTS and steering sources from frozen BASE. */
export async function captureKiroGuidanceV1(
  repositoryPath: string,
  manifest: SnapshotManifestV1,
  session: GuidanceDiscoverySessionV1 = createGuidanceDiscoverySessionV1(manifest),
): Promise<CapturedKiroGuidanceV1> {
  const targets = session.targets;

  const agentsByTarget = new Map<string, string[]>();
  const agentCandidates = new Set<string>();
  for (const target of targets) {
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

  const sources = new Map<string, Awaited<ReturnType<typeof readBaseMarkdownGuidanceSourceV1>>>();
  const directSourcesByDiscoveredPath = new Map<
    string,
    { resolvedPath: string; source: Awaited<ReturnType<typeof readBaseMarkdownGuidanceSourceV1>> }
  >();
  const steeringMatchers = new Map<string, ((path: string) => boolean) | undefined>();
  const excludedSteering = new Set<string>();
  const diagnostics = [];
  for (const path of [...metadataByPath.keys()].sort()) {
    const metadata = metadataByPath.get(path);
    if (!metadata) throw new Error(`Kiro guidance ${path} has no BASE metadata.`);
    const resolved = await resolveBaseGuidanceBlobV1(
      repositoryPath,
      manifest.source.baseCommit,
      path,
    );
    if (!resolved) throw new Error(`Kiro guidance ${path} has no resolved BASE source.`);
    if (steeringPaths.includes(path)) {
      const parsed = parseKiroSteeringFrontmatterV1(
        path,
        await readBaseGuidanceFrontmatterV1(
          repositoryPath,
          resolved.resolvedPath,
          resolved.metadata,
        ),
      );
      if (parsed.inclusion === "manual" || parsed.inclusion === "auto") {
        excludedSteering.add(path);
        diagnostics.push(
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
    const source = await readBaseMarkdownGuidanceSourceV1(
      repositoryPath,
      resolved.resolvedPath,
      resolved.metadata,
    );
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
    sources.set(resolved.resolvedPath, source);
    directSourcesByDiscoveredPath.set(path, { resolvedPath: resolved.resolvedPath, source });
  }

  const directSources = new Map<string, DirectGuidanceSourceInputV1>();
  let recognitionCount = 0;
  for (const target of targets) {
    const orderedAgents = (agentsByTarget.get(target.targetId) ?? []).filter((path) =>
      directSourcesByDiscoveredPath.has(path),
    );
    const orderedSteering = steeringPaths.filter((path) => {
      if (excludedSteering.has(path) || !directSourcesByDiscoveredPath.has(path)) return false;
      const matcher = steeringMatchers.get(path);
      return matcher ? matcher(target.applicabilityPath) : true;
    });
    [...orderedAgents, ...orderedSteering].forEach((path, nativeOrder) => {
      recognitionCount += 1;
      if (recognitionCount > MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1)
        discoveryLimit(
          `more than ${MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1} recognitions were produced.`,
        );
      const direct = directSourcesByDiscoveredPath.get(path);
      if (!direct) throw new Error(`Selected Kiro guidance ${path} was not loaded.`);
      const input = directSources.get(direct.resolvedPath) ?? {
        resolvedPath: direct.resolvedPath,
        contentDigest: direct.source.contentDigest,
        directRecognitions: [],
      };
      const recognition = {
        familyId: "KIRO",
        sourceKind: steeringPaths.includes(path) ? "KIRO_STEERING" : "KIRO_AGENTS",
        nativeOrder,
        applicableTargetId: target.targetId,
        discoveredPath: path,
      } as const;
      session.claimDirectRecognition(input, recognition);
      input.directRecognitions.push(recognition);
      directSources.set(direct.resolvedPath, input);
    });
  }
  if (directSources.size > MAX_GUIDANCE_NODES_V1)
    discoveryLimit(`more than ${MAX_GUIDANCE_NODES_V1} applicable source nodes were selected.`);

  const importTargets = new Map<
    string,
    { input: Omit<GuidanceImportInputV1, "applicableTargetIds">; targetIds: Set<string> }
  >();
  const graphSources = new Map<string, DirectGuidanceSourceInputV1>(directSources);
  const importScans = new Map<string, ReturnType<typeof scanKiroFileReferenceOccurrencesV1>>();
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
    if (!importer) throw new Error(`Kiro import source ${importerPath} was not loaded.`);
    let occurrences = importScans.get(importerPath);
    if (!occurrences) {
      occurrences = scanKiroFileReferenceOccurrencesV1(importerPath, importer.content);
      importScans.set(importerPath, occurrences);
    }
    if (occurrences.length > 0 && depth >= MAX_GUIDANCE_IMPORT_DEPTH_V1)
      importFailure("GUIDANCE_IMPORT_DEPTH_LIMIT", importerPath);
    for (const occurrence of occurrences) {
      const occurrenceKey = session.claimOccurrence({
        familyId: "KIRO",
        syntaxKind: "KIRO_FILE_REFERENCE",
        importerPath,
        importerContentDigest: importer.contentDigest,
        requestedSpecifier: occurrence.requestedSpecifier,
        startUtf16: occurrence.startUtf16,
        endUtf16: occurrence.endUtf16,
      });
      const requestedPath = resolveKiroFileReferencePathV1(
        importerPath,
        occurrence.requestedSpecifier,
      );
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
          familyId: "KIRO" as const,
          syntaxKind: "KIRO_FILE_REFERENCE" as const,
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
    const targetIds = source.directRecognitions
      .filter(({ sourceKind }) => sourceKind === "KIRO_STEERING")
      .map(({ applicableTargetId }) => applicableTargetId);
    for (const applicableTargetId of targetIds) {
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
        if (!source) throw new Error(`Applicable Kiro guidance ${path} was not loaded.`);
        return [source.contentDigest.value, Uint8Array.from(source.bytes)];
      }),
    ),
  };
}
