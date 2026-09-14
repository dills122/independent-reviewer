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
  baseGuidanceBlobMetadataV1,
  GuidanceCaptureError,
  listBaseGuidanceBlobMetadataV1,
  readBaseMarkdownGuidanceSourceV1,
  resolveBaseGuidanceBlobV1,
} from "./base-markdown-source.js";
import { compileGuidancePatternsV1 } from "./conditional-patterns.js";
import { parseCopilotFrontmatterV1 } from "./copilot-frontmatter.js";
import { resolveCopilotImportPathV1, scanCopilotImportOccurrencesV1 } from "./copilot-imports.js";
import {
  createGuidanceDiscoverySessionV1,
  type GuidanceDiscoverySessionV1,
} from "./discovery-capacity.js";
import { guidanceAncestorDirectoriesV1, guidancePathInDirectoryV1 } from "./discovery-paths.js";

const MAX_GUIDANCE_IMPORT_DEPTH_V1 = 5;
const REPOSITORY_PATH_V1 = ".github/copilot-instructions.md";
const MODULAR_ROOT_V1 = ".github/instructions";
const DOT_CLAUDE_PATH_V1 = ".claude/CLAUDE.md";

export interface CapturedCopilotGuidanceV1 {
  graph: GuidanceGraphV1;
  blobs: ReadonlyMap<string, Uint8Array>;
}

function discoveryLimit(message: string): never {
  throw new GuidanceCaptureError(
    "GUIDANCE_DISCOVERY_LIMIT_EXCEEDED",
    REPOSITORY_PATH_V1,
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
  throw new GuidanceCaptureError(code, path, `${path} has an invalid Copilot @path import graph.`);
}

type LoadedSourceV1 = Awaited<ReturnType<typeof readBaseMarkdownGuidanceSourceV1>>;

/** Discovers deterministic repository-owned Copilot guidance from frozen BASE. */
export async function captureCopilotGuidanceV1(
  repositoryPath: string,
  manifest: SnapshotManifestV1,
  session: GuidanceDiscoverySessionV1 = createGuidanceDiscoverySessionV1(manifest),
): Promise<CapturedCopilotGuidanceV1> {
  const targets = session.targets;

  const ancestorsByTarget = new Map(
    targets.map((target) => [
      target.targetId,
      guidanceAncestorDirectoriesV1(target.applicabilityPath),
    ]),
  );
  const fixedCandidates = new Set<string>([REPOSITORY_PATH_V1, DOT_CLAUDE_PATH_V1]);
  for (const directories of ancestorsByTarget.values()) {
    for (const directory of directories) {
      for (const filename of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
        fixedCandidates.add(guidancePathInDirectoryV1(directory, filename));
      }
    }
  }
  const modularMetadata = await listBaseGuidanceBlobMetadataV1(
    repositoryPath,
    manifest.source.baseCommit,
    MODULAR_ROOT_V1,
  );
  const modularPaths = [...modularMetadata.keys()]
    .filter((path) => path.endsWith(".instructions.md"))
    .sort();
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

  const sources = new Map<string, LoadedSourceV1>();
  const modularMatchers = new Map<string, (candidatePath: string) => boolean>();
  const excludedModular = new Set<string>();
  const diagnostics = [];
  for (const path of [...metadataByPath.keys()].sort()) {
    const metadata = metadataByPath.get(path);
    if (!metadata) throw new Error(`Copilot guidance source ${path} has no BASE metadata.`);
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
    if (modularPaths.includes(path)) {
      const metadata = parseCopilotFrontmatterV1(path, source.content);
      if (metadata.excludesCodeReview) excludedModular.add(path);
      else modularMatchers.set(path, compileGuidancePatternsV1(path, metadata.applyTo));
    }
  }

  const directSources = new Map<string, DirectGuidanceSourceInputV1>();
  let recognitionCount = 0;
  for (const target of targets) {
    const directories = ancestorsByTarget.get(target.targetId) ?? [];
    const agents = directories.map((directory) =>
      guidancePathInDirectoryV1(directory, "AGENTS.md"),
    );
    const claude = directories.map((directory) =>
      guidancePathInDirectoryV1(directory, "CLAUDE.md"),
    );
    const gemini = directories.map((directory) =>
      guidancePathInDirectoryV1(directory, "GEMINI.md"),
    );
    const ordered = [
      ...(sources.has(REPOSITORY_PATH_V1) ? [REPOSITORY_PATH_V1] : []),
      ...agents.filter((path) => sources.has(path)),
      ...claude.filter((path) => sources.has(path)),
      ...(sources.has(DOT_CLAUDE_PATH_V1) ? [DOT_CLAUDE_PATH_V1] : []),
      ...gemini.filter((path) => sources.has(path)),
      ...modularPaths.filter(
        (path) =>
          !excludedModular.has(path) &&
          modularMatchers.get(path)?.(target.applicabilityPath) === true,
      ),
    ];
    [...new Set(ordered)].forEach((path, nativeOrder) => {
      recognitionCount += 1;
      if (recognitionCount > MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1)
        discoveryLimit(
          `more than ${MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1} recognitions were produced.`,
        );
      const source = sources.get(path);
      if (!source) throw new Error(`Selected Copilot source ${path} was not loaded.`);
      const input = directSources.get(path) ?? {
        resolvedPath: path,
        contentDigest: source.contentDigest,
        directRecognitions: [],
      };
      const recognition = {
        familyId: "COPILOT",
        sourceKind:
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
                    : "COPILOT_GEMINI",
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
  const importScans = new Map<string, ReturnType<typeof scanCopilotImportOccurrencesV1>>();
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
    if (!importer) throw new Error(`Copilot import source ${importerPath} was not loaded.`);
    let occurrences = importScans.get(importerPath);
    if (!occurrences) {
      occurrences = scanCopilotImportOccurrencesV1(importerPath, importer.content);
      importScans.set(importerPath, occurrences);
    }
    if (occurrences.length > 0 && depth >= MAX_GUIDANCE_IMPORT_DEPTH_V1)
      importFailure("GUIDANCE_IMPORT_DEPTH_LIMIT", importerPath);
    for (const occurrence of occurrences) {
      const occurrenceKey = session.claimOccurrence({
        familyId: "COPILOT",
        syntaxKind: "COPILOT_AT_PATH",
        importerPath,
        importerContentDigest: importer.contentDigest,
        requestedSpecifier: occurrence.requestedSpecifier,
        startUtf16: occurrence.startUtf16,
        endUtf16: occurrence.endUtf16,
      });
      const requestedPath = resolveCopilotImportPathV1(importerPath, occurrence.requestedSpecifier);
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
          familyId: "COPILOT" as const,
          syntaxKind: "COPILOT_AT_PATH" as const,
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
    for (const recognition of input.directRecognitions) {
      if (
        recognition.sourceKind === "COPILOT_MODULAR" ||
        recognition.sourceKind === "COPILOT_GEMINI"
      ) {
        continue;
      }
      await traverseImports(path, recognition.applicableTargetId, 0, new Set([path]));
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
        if (!source) throw new Error(`Applicable Copilot source ${path} was not loaded.`);
        return [source.contentDigest.value, Uint8Array.from(source.bytes)];
      }),
    ),
  };
}
