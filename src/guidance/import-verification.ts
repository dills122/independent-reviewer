import type { DigestV1, GuidanceGraphV1 } from "../contracts/index.js";
import { resolveClaudeImportPathV1, scanClaudeImportOccurrencesV1 } from "./claude-imports.js";
import { resolveCopilotImportPathV1, scanCopilotImportOccurrencesV1 } from "./copilot-imports.js";
import { resolveCursorImportPathV1, scanCursorImportOccurrencesV1 } from "./cursor-imports.js";
import { resolveGeminiImportPathV1, scanGeminiImportOccurrencesV1 } from "./gemini-imports.js";
import {
  resolveKiroFileReferencePathV1,
  scanKiroFileReferenceOccurrencesV1,
} from "./kiro-imports.js";

type GuidanceNodeV1 = GuidanceGraphV1["nodes"][number];
type GuidanceOccurrenceV1 = GuidanceGraphV1["occurrences"][number];
type ImportFamilyV1 = GuidanceOccurrenceV1["familyId"];

interface ResolvedImportSourceV1 {
  resolvedPath: string;
  contentDigest: DigestV1;
}

interface ScannedOccurrenceV1 {
  requestedSpecifier: string;
  startUtf16: number;
  endUtf16: number;
}

const importFamilies = {
  CLAUDE: {
    sourceKinds: new Set(["CLAUDE_MD", "CLAUDE_DOT_CLAUDE_MD"]),
    maxDepth: 4,
    scan: scanClaudeImportOccurrencesV1,
    resolve: resolveClaudeImportPathV1,
  },
  GEMINI: {
    sourceKinds: new Set(["GEMINI_CONTEXT"]),
    maxDepth: 5,
    scan: scanGeminiImportOccurrencesV1,
    resolve: resolveGeminiImportPathV1,
  },
  KIRO: {
    sourceKinds: new Set(["KIRO_STEERING"]),
    maxDepth: 5,
    scan: scanKiroFileReferenceOccurrencesV1,
    resolve: resolveKiroFileReferencePathV1,
  },
  COPILOT: {
    sourceKinds: new Set([
      "COPILOT_REPOSITORY",
      "COPILOT_AGENTS",
      "COPILOT_CLAUDE",
      "COPILOT_DOT_CLAUDE",
    ]),
    maxDepth: 5,
    scan: scanCopilotImportOccurrencesV1,
    resolve: resolveCopilotImportPathV1,
  },
  CURSOR: {
    sourceKinds: new Set(["CURSOR_RULE"]),
    maxDepth: 5,
    scan: scanCursorImportOccurrencesV1,
    resolve: resolveCursorImportPathV1,
  },
} as const;

function occurrenceKey(occurrence: ScannedOccurrenceV1): string {
  return JSON.stringify([
    occurrence.requestedSpecifier,
    occurrence.startUtf16,
    occurrence.endUtf16,
  ]);
}

function sameDigest(left: DigestV1, right: DigestV1): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

/**
 * Re-parses frozen source bytes, recomputes import closure, and optionally re-resolves every
 * destination against frozen BASE. The resolver is mandatory at capture/persistence boundaries.
 */
export async function assertGuidanceImportOccurrencesV1(
  graph: GuidanceGraphV1,
  readSource: (node: GuidanceNodeV1) => Promise<Uint8Array>,
  resolveImportSource?: (requestedPath: string) => Promise<ResolvedImportSourceV1>,
): Promise<void> {
  const nodes = new Map(graph.nodes.map((node) => [node.sourceId, node]));
  const occurrencesByImporterFamily = new Map<string, GuidanceOccurrenceV1[]>();
  const edgesByOccurrence = new Map<string, GuidanceGraphV1["edges"]>();
  const contentBySource = new Map<string, string>();
  const scannedBySourceFamily = new Map<string, ScannedOccurrenceV1[]>();
  const verifiedOccurrenceIds = new Set<string>();
  const verifiedEdgeIds = new Set<string>();
  const completed = new Set<string>();

  for (const occurrence of graph.occurrences) {
    if (!(occurrence.familyId in importFamilies))
      throw new Error(`Guidance occurrence ${occurrence.occurrenceId} has an unsupported family.`);
    const key = JSON.stringify([occurrence.importerSourceId, occurrence.familyId]);
    const familyOccurrences = occurrencesByImporterFamily.get(key) ?? [];
    familyOccurrences.push(occurrence);
    occurrencesByImporterFamily.set(key, familyOccurrences);
  }
  for (const edge of graph.edges) {
    const occurrenceEdges = edgesByOccurrence.get(edge.occurrenceId) ?? [];
    occurrenceEdges.push(edge);
    edgesByOccurrence.set(edge.occurrenceId, occurrenceEdges);
  }

  const readContent = async (node: GuidanceNodeV1): Promise<string> => {
    const cached = contentBySource.get(node.sourceId);
    if (cached !== undefined) return cached;
    const bytes = await readSource(node);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`Guidance source ${node.resolvedPath} is not valid UTF-8.`);
    }
    contentBySource.set(node.sourceId, content);
    return content;
  };

  const scanSource = async (node: GuidanceNodeV1, familyId: ImportFamilyV1) => {
    const key = JSON.stringify([node.sourceId, familyId]);
    const cached = scannedBySourceFamily.get(key);
    if (cached) return cached;
    const family = importFamilies[familyId as keyof typeof importFamilies];
    if (!family) throw new Error(`Guidance family ${familyId} cannot import sources.`);
    const scanned = family.scan(node.resolvedPath, await readContent(node));
    const actual = occurrencesByImporterFamily.get(key) ?? [];
    const expectedKeys = scanned.map(occurrenceKey).sort();
    const actualKeys = actual.map(occurrenceKey).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys))
      throw new Error(`Guidance source ${node.resolvedPath} has invalid persisted occurrences.`);
    scannedBySourceFamily.set(key, scanned);
    return scanned;
  };

  const traverse = async (
    node: GuidanceNodeV1,
    familyId: keyof typeof importFamilies,
    targetId: string,
    depth: number,
    ancestry: ReadonlySet<string>,
  ): Promise<void> => {
    const state = JSON.stringify([node.sourceId, familyId, targetId, depth]);
    if (completed.has(state)) return;
    const family = importFamilies[familyId];
    const scanned = await scanSource(node, familyId);
    if (scanned.length > 0 && depth >= family.maxDepth)
      throw new Error(`Guidance import depth limit exceeded at ${node.resolvedPath}.`);
    const actualOccurrences =
      occurrencesByImporterFamily.get(JSON.stringify([node.sourceId, familyId])) ?? [];
    const occurrenceByKey = new Map(actualOccurrences.map((item) => [occurrenceKey(item), item]));

    for (const scannedOccurrence of scanned) {
      const occurrence = occurrenceByKey.get(occurrenceKey(scannedOccurrence));
      if (!occurrence)
        throw new Error(`Guidance source ${node.resolvedPath} omits a persisted occurrence.`);
      verifiedOccurrenceIds.add(occurrence.occurrenceId);
      const occurrenceEdges = edgesByOccurrence.get(occurrence.occurrenceId) ?? [];
      const importedSourceIds = new Set(
        occurrenceEdges.map(({ importedSourceId }) => importedSourceId),
      );
      if (importedSourceIds.size !== 1)
        throw new Error(
          `Guidance occurrence ${occurrence.occurrenceId} has no unique destination.`,
        );
      const importedSourceId = [...importedSourceIds][0];
      const imported = importedSourceId ? nodes.get(importedSourceId) : undefined;
      if (!imported)
        throw new Error(`Guidance occurrence ${occurrence.occurrenceId} has no imported source.`);
      const requestedPath = family.resolve(node.resolvedPath, occurrence.requestedSpecifier);
      if (resolveImportSource) {
        const resolved = await resolveImportSource(requestedPath);
        if (
          resolved.resolvedPath !== imported.resolvedPath ||
          !sameDigest(resolved.contentDigest, imported.contentDigest)
        ) {
          throw new Error(
            `Guidance occurrence ${occurrence.occurrenceId} has an invalid resolved destination.`,
          );
        }
      }
      const edge = occurrenceEdges.find(
        ({ applicableTargetId }) => applicableTargetId === targetId,
      );
      if (!edge)
        throw new Error(
          `Guidance occurrence ${occurrence.occurrenceId} has incomplete edge closure.`,
        );
      verifiedEdgeIds.add(edge.edgeId);
      if (ancestry.has(imported.sourceId))
        throw new Error(`Guidance import cycle detected at ${imported.resolvedPath}.`);
      await traverse(
        imported,
        familyId,
        targetId,
        depth + 1,
        new Set([...ancestry, imported.sourceId]),
      );
    }
    completed.add(state);
  };

  for (const node of graph.nodes) {
    for (const recognition of node.directRecognitions) {
      const family = importFamilies[recognition.familyId as keyof typeof importFamilies];
      if (!family?.sourceKinds.has(recognition.sourceKind as never)) continue;
      await traverse(
        node,
        recognition.familyId as keyof typeof importFamilies,
        recognition.applicableTargetId,
        0,
        new Set([node.sourceId]),
      );
    }
  }

  if (verifiedOccurrenceIds.size !== graph.occurrences.length)
    throw new Error("Guidance graph contains occurrences outside exact import closure.");
  if (verifiedEdgeIds.size !== graph.edges.length)
    throw new Error("Guidance graph contains edges outside exact import closure.");
}
