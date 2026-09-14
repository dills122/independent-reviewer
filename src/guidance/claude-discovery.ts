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
import { resolveClaudeImportPathV1, scanClaudeImportOccurrencesV1 } from "./claude-imports.js";
import { compileGuidancePatternsV1 } from "./conditional-patterns.js";
import {
  createGuidanceDiscoverySessionV1,
  type GuidanceDiscoverySessionV1,
} from "./discovery-capacity.js";
import { guidanceAncestorDirectoriesV1, guidancePathInDirectoryV1 } from "./discovery-paths.js";
import { parseGuidanceFrontmatterV1 } from "./frontmatter.js";

const MAX_GUIDANCE_IMPORT_DEPTH_V1 = 4;
const DOT_CLAUDE_PATH_V1 = ".claude/CLAUDE.md";
const CLAUDE_RULES_ROOT_V1 = ".claude/rules";

export interface CapturedClaudeGuidanceV1 {
  graph: GuidanceGraphV1;
  blobs: ReadonlyMap<string, Uint8Array>;
}

function discoveryLimit(message: string): never {
  throw new GuidanceCaptureError(
    "GUIDANCE_DISCOVERY_LIMIT_EXCEEDED",
    "CLAUDE.md",
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
  throw new GuidanceCaptureError(code, path, `${path} has an invalid Claude @path import graph.`);
}

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

  type ResolvedSourceV1 = NonNullable<Awaited<ReturnType<typeof resolveBaseGuidanceBlobV1>>>;
  const resolvedByDiscoveredPath = new Map<string, ResolvedSourceV1>();
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

  const selectPathsForTarget = (targetId: string, applicabilityPath: string): string[] => {
    const ordered = [
      ...(candidatesByTarget.get(targetId) ?? []).filter((path) =>
        resolvedByDiscoveredPath.has(path),
      ),
      ...(resolvedByDiscoveredPath.has(DOT_CLAUDE_PATH_V1) ? [DOT_CLAUDE_PATH_V1] : []),
      ...rules.filter((path) => {
        if (!resolvedByDiscoveredPath.has(path)) return false;
        const matcher = ruleMatchers.get(path);
        return matcher ? matcher(applicabilityPath) : true;
      }),
    ];
    return [...new Set(ordered)];
  };
  const selectedPaths = new Set<string>();
  for (const target of targets) {
    for (const path of selectPathsForTarget(target.targetId, target.applicabilityPath))
      selectedPaths.add(path);
  }

  const sources = new Map<string, Awaited<ReturnType<typeof readBaseMarkdownGuidanceSourceV1>>>();
  const directSourcesByDiscoveredPath = new Map<
    string,
    { resolvedPath: string; source: Awaited<ReturnType<typeof readBaseMarkdownGuidanceSourceV1>> }
  >();
  for (const path of [...selectedPaths].sort()) {
    const resolved = resolvedByDiscoveredPath.get(path);
    if (!resolved) throw new Error(`Selected guidance source ${path} was not resolved.`);
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
  for (const target of targets) {
    const selected = selectPathsForTarget(target.targetId, target.applicabilityPath).filter(
      (path) => directSourcesByDiscoveredPath.has(path),
    );
    selected.forEach((path, nativeOrder) => {
      recognitionCount += 1;
      if (recognitionCount > MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1)
        discoveryLimit(
          `more than ${MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1} recognitions were produced.`,
        );
      const loaded = directSourcesByDiscoveredPath.get(path);
      if (!loaded) throw new Error(`Selected guidance source ${path} was not loaded.`);
      const input = directSources.get(loaded.resolvedPath) ?? {
        resolvedPath: loaded.resolvedPath,
        contentDigest: loaded.source.contentDigest,
        directRecognitions: [],
      };
      const recognition = {
        familyId: "CLAUDE",
        sourceKind: rules.includes(path)
          ? "CLAUDE_RULE"
          : path === DOT_CLAUDE_PATH_V1
            ? "CLAUDE_DOT_CLAUDE_MD"
            : "CLAUDE_MD",
        nativeOrder,
        applicableTargetId: target.targetId,
        discoveredPath: path,
      } as const;
      session.claimDirectRecognition(input, recognition);
      input.directRecognitions.push(recognition);
      directSources.set(loaded.resolvedPath, input);
    });
  }
  if (directSources.size > MAX_GUIDANCE_NODES_V1)
    discoveryLimit(`more than ${MAX_GUIDANCE_NODES_V1} applicable source nodes were selected.`);

  const importTargets = new Map<
    string,
    { input: Omit<GuidanceImportInputV1, "applicableTargetIds">; targetIds: Set<string> }
  >();
  const graphSources = new Map<string, DirectGuidanceSourceInputV1>(directSources);
  const importScans = new Map<string, ReturnType<typeof scanClaudeImportOccurrencesV1>>();
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
    if (!importer) throw new Error(`Claude import source ${importerPath} was not loaded.`);
    let occurrences = importScans.get(importerPath);
    if (!occurrences) {
      occurrences = scanClaudeImportOccurrencesV1(importerPath, importer.content);
      importScans.set(importerPath, occurrences);
    }
    if (occurrences.length > 0 && depth >= MAX_GUIDANCE_IMPORT_DEPTH_V1)
      importFailure("GUIDANCE_IMPORT_DEPTH_LIMIT", importerPath);
    for (const occurrence of occurrences) {
      const occurrenceKey = session.claimOccurrence({
        familyId: "CLAUDE",
        syntaxKind: "CLAUDE_AT_PATH",
        importerPath,
        importerContentDigest: importer.contentDigest,
        requestedSpecifier: occurrence.requestedSpecifier,
        startUtf16: occurrence.startUtf16,
        endUtf16: occurrence.endUtf16,
      });
      const requestedPath = resolveClaudeImportPathV1(importerPath, occurrence.requestedSpecifier);
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
          familyId: "CLAUDE" as const,
          syntaxKind: "CLAUDE_AT_PATH" as const,
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
      .filter(({ familyId, sourceKind }) => familyId === "CLAUDE" && sourceKind !== "CLAUDE_RULE")
      .map(({ applicableTargetId }) => applicableTargetId);
    for (const applicableTargetId of targetIds) {
      await traverseImports(path, applicableTargetId, 0, new Set([path]));
    }
  }
  const imports: GuidanceImportInputV1[] = [...importTargets.values()].map(
    ({ input, targetIds }) => ({
      ...input,
      applicableTargetIds: [...targetIds].sort(),
    }),
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
        if (!source) throw new Error(`Applicable guidance source ${path} was not loaded.`);
        return [source.contentDigest.value, Uint8Array.from(source.bytes)];
      }),
    ),
  };
}
