import {
  buildDirectGuidanceGraphV1,
  createGuidanceDiagnosticV1,
  type DirectGuidanceSourceInputV1,
  type GuidanceGraphV1,
  projectGuidanceTargetsV1,
  type SnapshotManifestV1,
} from "../contracts/index.js";
import {
  baseGuidanceBlobMetadataV1,
  GuidanceCaptureError,
  readBaseMarkdownGuidanceSourceV1,
} from "./base-markdown-source.js";
import { guidanceAncestorDirectoriesV1, guidancePathInDirectoryV1 } from "./discovery-paths.js";

const MAX_SNAPSHOT_ENTRIES_V1 = 4_096;
const MAX_GUIDANCE_TARGETS_V1 = 8_192;
const MAX_DIRECT_CANDIDATES_V1 = 4_096;
const MAX_GUIDANCE_NODES_V1 = 256;
const MAX_DIRECT_RECOGNITIONS_V1 = 65_536;

export interface CapturedCodexGuidanceV1 {
  graph: GuidanceGraphV1;
  blobs: ReadonlyMap<string, Uint8Array>;
}

function discoveryLimit(message: string): never {
  throw new GuidanceCaptureError(
    "GUIDANCE_DISCOVERY_LIMIT_EXCEEDED",
    "AGENTS.md",
    `Guidance discovery limit exceeded: ${message}`,
  );
}

/** Discovers Codex AGENTS instructions from frozen BASE for every canonical target. */
export async function captureCodexGuidanceV1(
  repositoryPath: string,
  manifest: SnapshotManifestV1,
): Promise<CapturedCodexGuidanceV1> {
  if (manifest.paths.length > MAX_SNAPSHOT_ENTRIES_V1)
    discoveryLimit(`snapshot contains more than ${MAX_SNAPSHOT_ENTRIES_V1} entries.`);
  const targets = projectGuidanceTargetsV1(manifest);
  if (targets.length > MAX_GUIDANCE_TARGETS_V1)
    discoveryLimit(`snapshot projects more than ${MAX_GUIDANCE_TARGETS_V1} targets.`);

  const candidates = new Set<string>();
  const candidatesByTarget = new Map<string, Array<{ agents: string; override: string }>>();
  for (const target of targets) {
    const targetCandidates = guidanceAncestorDirectoriesV1(target.applicabilityPath).map(
      (directory) => ({
        agents: guidancePathInDirectoryV1(directory, "AGENTS.md"),
        override: guidancePathInDirectoryV1(directory, "AGENTS.override.md"),
      }),
    );
    for (const candidate of targetCandidates.flatMap(({ agents, override }) => [
      agents,
      override,
    ])) {
      candidates.add(candidate);
      if (candidates.size > MAX_DIRECT_CANDIDATES_V1)
        discoveryLimit(`more than ${MAX_DIRECT_CANDIDATES_V1} direct candidates were recognized.`);
    }
    candidatesByTarget.set(target.targetId, targetCandidates);
  }

  const metadataByPath = new Map<string, Awaited<ReturnType<typeof baseGuidanceBlobMetadataV1>>>();
  for (const path of [...candidates].sort()) {
    metadataByPath.set(
      path,
      await baseGuidanceBlobMetadataV1(repositoryPath, manifest.source.baseCommit, path),
    );
  }

  const selectedByTarget = new Map<string, string[]>();
  const selectedPaths = new Set<string>();
  for (const target of targets) {
    const selected = (candidatesByTarget.get(target.targetId) ?? []).flatMap(
      ({ agents, override }) => {
        const path = metadataByPath.get(override)
          ? override
          : metadataByPath.get(agents)
            ? agents
            : undefined;
        return path ? [path] : [];
      },
    );
    selectedByTarget.set(target.targetId, selected);
    for (const path of selected) selectedPaths.add(path);
  }
  if (selectedPaths.size > MAX_GUIDANCE_NODES_V1)
    discoveryLimit(`more than ${MAX_GUIDANCE_NODES_V1} applicable source nodes were selected.`);

  const sources = new Map<string, Awaited<ReturnType<typeof readBaseMarkdownGuidanceSourceV1>>>();
  const diagnostics = [];
  for (const path of [...selectedPaths].sort()) {
    const metadata = metadataByPath.get(path);
    if (!metadata) throw new Error(`Selected guidance source ${path} has no BASE metadata.`);
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
    } else {
      sources.set(path, source);
    }
  }

  const directSources = new Map<string, DirectGuidanceSourceInputV1>();
  let recognitionCount = 0;
  for (const target of targets) {
    const selected = (selectedByTarget.get(target.targetId) ?? []).filter((path) =>
      sources.has(path),
    );
    selected.forEach((path, nativeOrder) => {
      recognitionCount += 1;
      if (recognitionCount > MAX_DIRECT_RECOGNITIONS_V1)
        discoveryLimit(`more than ${MAX_DIRECT_RECOGNITIONS_V1} recognitions were produced.`);
      const source = sources.get(path);
      if (!source) throw new Error(`Selected guidance source ${path} was not loaded.`);
      const input = directSources.get(path) ?? {
        resolvedPath: path,
        contentDigest: source.contentDigest,
        directRecognitions: [],
      };
      input.directRecognitions.push({
        familyId: "CODEX",
        sourceKind: path.endsWith("AGENTS.override.md") ? "CODEX_AGENTS_OVERRIDE" : "CODEX_AGENTS",
        nativeOrder,
        applicableTargetId: target.targetId,
        discoveredPath: path,
      });
      directSources.set(path, input);
    });
  }

  return {
    graph: buildDirectGuidanceGraphV1(manifest, [...directSources.values()], diagnostics),
    blobs: new Map(
      [...sources.values()].map((source) => [
        source.contentDigest.value,
        Uint8Array.from(source.bytes),
      ]),
    ),
  };
}
