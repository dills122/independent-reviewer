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
  type BaseGuidanceBlobMetadataV1,
  GuidanceCaptureError,
  listBaseGuidanceBlobMetadataV1,
  readBaseMarkdownGuidanceSourceV1,
} from "./base-markdown-source.js";
import { compileGuidancePatternsV1 } from "./conditional-patterns.js";
import { guidanceAncestorDirectoriesV1, guidancePathInDirectoryV1 } from "./discovery-paths.js";
import { parseGuidanceFrontmatterV1 } from "./frontmatter.js";

const MAX_SNAPSHOT_ENTRIES_V1 = 4_096;
const MAX_GUIDANCE_TARGETS_V1 = 8_192;
const MAX_DIRECT_CANDIDATES_V1 = 4_096;
const MAX_GUIDANCE_NODES_V1 = 256;
const MAX_DIRECT_RECOGNITIONS_V1 = 65_536;
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

/** Discovers directly selected Claude guidance from frozen BASE. */
export async function captureClaudeGuidanceV1(
  repositoryPath: string,
  manifest: SnapshotManifestV1,
): Promise<CapturedClaudeGuidanceV1> {
  if (manifest.paths.length > MAX_SNAPSHOT_ENTRIES_V1)
    discoveryLimit(`snapshot contains more than ${MAX_SNAPSHOT_ENTRIES_V1} entries.`);
  const targets = projectGuidanceTargetsV1(manifest);
  if (targets.length > MAX_GUIDANCE_TARGETS_V1)
    discoveryLimit(`snapshot projects more than ${MAX_GUIDANCE_TARGETS_V1} targets.`);

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
  );
  const rules = [...ruleMetadata.keys()].filter((path) => path.endsWith(".md")).sort();
  if (fixedCandidates.size + rules.length > MAX_DIRECT_CANDIDATES_V1)
    discoveryLimit(`more than ${MAX_DIRECT_CANDIDATES_V1} direct candidates were recognized.`);

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

  const sources = new Map<string, Awaited<ReturnType<typeof readBaseMarkdownGuidanceSourceV1>>>();
  const ruleMatchers = new Map<string, ((path: string) => boolean) | undefined>();
  const diagnostics = [];
  for (const path of [...metadataByPath.keys()].sort()) {
    const metadata = metadataByPath.get(path);
    if (!metadata) throw new Error(`Guidance source ${path} has no BASE metadata.`);
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
    if (rules.includes(path)) {
      const { paths } = parseGuidanceFrontmatterV1(path, source.content);
      ruleMatchers.set(path, paths ? compileGuidancePatternsV1(path, paths) : undefined);
    }
  }
  const directSources = new Map<string, DirectGuidanceSourceInputV1>();
  let recognitionCount = 0;
  for (const target of targets) {
    const ordered = [
      ...(candidatesByTarget.get(target.targetId) ?? []).filter((path) => sources.has(path)),
      ...(sources.has(DOT_CLAUDE_PATH_V1) ? [DOT_CLAUDE_PATH_V1] : []),
      ...rules.filter((path) => {
        if (!sources.has(path)) return false;
        const matcher = ruleMatchers.get(path);
        return matcher ? matcher(target.applicabilityPath) : true;
      }),
    ];
    const selected = [...new Set(ordered)];
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
        familyId: "CLAUDE",
        sourceKind: rules.includes(path)
          ? "CLAUDE_RULE"
          : path === DOT_CLAUDE_PATH_V1
            ? "CLAUDE_DOT_CLAUDE_MD"
            : "CLAUDE_MD",
        nativeOrder,
        applicableTargetId: target.targetId,
        discoveredPath: path,
      });
      directSources.set(path, input);
    });
  }
  if (directSources.size > MAX_GUIDANCE_NODES_V1)
    discoveryLimit(`more than ${MAX_GUIDANCE_NODES_V1} applicable source nodes were selected.`);

  return {
    graph: buildDirectGuidanceGraphV1(manifest, [...directSources.values()], diagnostics),
    blobs: new Map(
      [...directSources.keys()].map((path) => {
        const source = sources.get(path);
        if (!source) throw new Error(`Applicable guidance source ${path} was not loaded.`);
        return [source.contentDigest.value, Uint8Array.from(source.bytes)];
      }),
    ),
  };
}
