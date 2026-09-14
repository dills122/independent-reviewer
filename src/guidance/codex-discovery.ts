import {
  buildDirectGuidanceGraphV1,
  createGuidanceDiagnosticV1,
  type DirectGuidanceSourceInputV1,
  type GuidanceGraphV1,
  MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1,
  MAX_GUIDANCE_NODES_V1,
  type SnapshotManifestV1,
} from "../contracts/index.js";
import {
  baseGuidanceBlobMetadataV1,
  GuidanceCaptureError,
  readResolvedBaseMarkdownGuidanceSourceV1,
} from "./base-markdown-source.js";
import {
  createGuidanceDiscoverySessionV1,
  type GuidanceDiscoverySessionV1,
} from "./discovery-capacity.js";
import { guidanceAncestorDirectoriesV1, guidancePathInDirectoryV1 } from "./discovery-paths.js";

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
  session: GuidanceDiscoverySessionV1 = createGuidanceDiscoverySessionV1(manifest),
): Promise<CapturedCodexGuidanceV1> {
  const targets = session.targets;

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
    }
    candidatesByTarget.set(target.targetId, targetCandidates);
  }
  session.claimDirectCandidates([...candidates]);

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

  type LoadedSourceV1 = NonNullable<
    Awaited<ReturnType<typeof readResolvedBaseMarkdownGuidanceSourceV1>>
  >;
  const sourcesByDiscoveredPath = new Map<string, LoadedSourceV1>();
  for (const path of [...selectedPaths].sort()) {
    const metadata = metadataByPath.get(path);
    if (!metadata) throw new Error(`Selected guidance source ${path} has no BASE metadata.`);
    const loaded = await readResolvedBaseMarkdownGuidanceSourceV1(
      repositoryPath,
      manifest.source.baseCommit,
      path,
    );
    if (!loaded) throw new Error(`Selected guidance source ${path} has no resolved BASE source.`);
    if (loaded.source.content.trim().length === 0) {
      session.addDiagnostic(
        createGuidanceDiagnosticV1({
          code: "EMPTY_SOURCE",
          severity: "WARNING",
          path,
          startUtf16: 0,
          omittedCount: null,
        }),
      );
    } else {
      sourcesByDiscoveredPath.set(path, loaded);
    }
  }

  const directSources = new Map<string, DirectGuidanceSourceInputV1>();
  let recognitionCount = 0;
  for (const target of targets) {
    const selected = (selectedByTarget.get(target.targetId) ?? []).filter((path) =>
      sourcesByDiscoveredPath.has(path),
    );
    selected.forEach((path, nativeOrder) => {
      recognitionCount += 1;
      if (recognitionCount > MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1)
        discoveryLimit(
          `more than ${MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1} recognitions were produced.`,
        );
      const loaded = sourcesByDiscoveredPath.get(path);
      if (!loaded) throw new Error(`Selected guidance source ${path} was not loaded.`);
      const input = directSources.get(loaded.resolvedPath) ?? {
        resolvedPath: loaded.resolvedPath,
        contentDigest: loaded.source.contentDigest,
        directRecognitions: [],
      };
      const recognition = {
        familyId: "CODEX",
        sourceKind: path.endsWith("AGENTS.override.md") ? "CODEX_AGENTS_OVERRIDE" : "CODEX_AGENTS",
        nativeOrder,
        applicableTargetId: target.targetId,
        discoveredPath: path,
      } as const;
      session.claimDirectRecognition(input, recognition);
      input.directRecognitions.push(recognition);
      directSources.set(loaded.resolvedPath, input);
    });
  }

  return {
    graph: buildDirectGuidanceGraphV1(
      manifest,
      [...directSources.values()],
      session.finalizeDiagnostics(),
    ),
    blobs: new Map(
      [...sourcesByDiscoveredPath.values()].map(({ source }) => [
        source.contentDigest.value,
        Uint8Array.from(source.bytes),
      ]),
    ),
  };
}
