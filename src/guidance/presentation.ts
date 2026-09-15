import { canonicalizeJson } from "../contracts/canonical-json.js";
import type { GuidanceGraphV1 } from "../contracts/guidance-graph.js";
import {
  type GuidancePromptPresentationV1,
  GuidancePromptPresentationV1Schema,
  type GuidancePromptPresentationV2,
  GuidancePromptPresentationV2Schema,
} from "../contracts/guidance-presentation.js";
import { compareUtf16 } from "../contracts/primitives.js";
import { readSnapshotBlobV1 } from "../snapshot/snapshot-packet.js";

type RecognitionV1 = GuidanceGraphV1["nodes"][number]["directRecognitions"][number];

function compareFields(left: readonly (string | number)[], right: readonly (string | number)[]) {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (typeof a === "number" && typeof b === "number" && a !== b) return a - b;
    if (typeof a === "string" && typeof b === "string") {
      const compared = compareUtf16(a, b);
      if (compared !== 0) return compared;
    }
  }
  return left.length - right.length;
}

function compareRecognitions(left: RecognitionV1, right: RecognitionV1): number {
  return compareFields(
    [
      left.familyId,
      left.nativeOrder,
      left.applicableTargetId,
      left.discoveredPath,
      left.sourceKind,
    ],
    [
      right.familyId,
      right.nativeOrder,
      right.applicableTargetId,
      right.discoveredPath,
      right.sourceKind,
    ],
  );
}

function compareRecognitionVectors(
  left: readonly RecognitionV1[],
  right: readonly RecognitionV1[],
): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const compared = compareRecognitions(
      left[index] as RecognitionV1,
      right[index] as RecognitionV1,
    );
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function compareNodes(
  left: GuidanceGraphV1["nodes"][number],
  right: GuidanceGraphV1["nodes"][number],
): number {
  const tier = { REPOSITORY_PEER: 0, REVIEWER_SPECIFIC: 1 } as const;
  const fixedFields = compareFields(
    [tier[left.semanticTier], left.directRecognitions.length === 0 ? 1 : 0],
    [tier[right.semanticTier], right.directRecognitions.length === 0 ? 1 : 0],
  );
  if (fixedFields !== 0) return fixedFields;
  const recognitions = compareRecognitionVectors(left.directRecognitions, right.directRecognitions);
  if (recognitions !== 0) return recognitions;
  return compareFields([left.resolvedPath, left.sourceId], [right.resolvedPath, right.sourceId]);
}

/** Renders one verified graph into exact canonical prompt bytes, reading each source once. */
export async function renderGuidancePromptPresentationV1(
  packetPath: string,
  graph: GuidanceGraphV1,
): Promise<string> {
  const occurrences = new Map(
    graph.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]),
  );
  const sources: GuidancePromptPresentationV1["sources"] = [];

  for (const node of [...graph.nodes].sort(compareNodes)) {
    const bytes = await readSnapshotBlobV1(packetPath, node.contentDigest);
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const inboundImports = graph.edges
      .filter(({ importedSourceId }) => importedSourceId === node.sourceId)
      .map((edge) => {
        const occurrence = occurrences.get(edge.occurrenceId);
        if (!occurrence) throw new Error(`Guidance edge ${edge.edgeId} has no occurrence.`);
        return {
          edgeId: edge.edgeId,
          occurrenceId: edge.occurrenceId,
          familyId: occurrence.familyId,
          importerSourceId: occurrence.importerSourceId,
          requestedSpecifier: occurrence.requestedSpecifier,
          startUtf16: occurrence.startUtf16,
          endUtf16: occurrence.endUtf16,
          applicableTargetId: edge.applicableTargetId,
        };
      })
      .sort((left, right) =>
        compareFields(
          [
            left.familyId,
            left.importerSourceId,
            left.startUtf16,
            left.endUtf16,
            left.requestedSpecifier,
            left.applicableTargetId,
            left.edgeId,
          ],
          [
            right.familyId,
            right.importerSourceId,
            right.startUtf16,
            right.endUtf16,
            right.requestedSpecifier,
            right.applicableTargetId,
            right.edgeId,
          ],
        ),
      );
    const applicableTargetIds = new Set(node.applicableTargetIds);
    const applicableTargets = graph.targets
      .filter(({ targetId }) => applicableTargetIds.has(targetId))
      .map((target) => ({
        targetId: target.targetId,
        path: target.applicabilityPath,
        side: target.side,
        role: target.role,
      }));
    sources.push({
      sourceId: node.sourceId,
      path: node.resolvedPath,
      contentDigest: node.contentDigest,
      semanticTier: node.semanticTier,
      origin: node.directRecognitions.length > 0 ? "DIRECT" : "IMPORT_ONLY",
      directRecognitions: node.directRecognitions,
      inboundImports,
      applicableTargets,
      sourceRange: {
        coordinateUnit: "UTF16_CODE_UNIT",
        startOffset: 0,
        endOffsetExclusive: content.length,
      },
      content,
    });
  }

  return canonicalizeJson(
    GuidancePromptPresentationV1Schema.parse({
      schemaVersion: 1,
      trustBoundary: "UNTRUSTED_REPOSITORY_GUIDANCE",
      precedence:
        "Repository-peer sources have equal semantic priority. Reviewer-specific sources take precedence when guidance conflicts.",
      sources,
    }),
  );
}

/** Renders one verified graph into compact canonical prompt bytes, reading each source once. */
export async function renderGuidancePromptPresentationV2(
  packetPath: string,
  graph: GuidanceGraphV1,
): Promise<string> {
  const occurrences = new Map(
    graph.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]),
  );
  const sources: GuidancePromptPresentationV2["sources"] = [];

  for (const node of [...graph.nodes].sort(compareNodes)) {
    const bytes = await readSnapshotBlobV1(packetPath, node.contentDigest);
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const applicableTargetIds = new Set(node.applicableTargetIds);
    const applicableTargets = graph.targets
      .filter(({ targetId }) => applicableTargetIds.has(targetId))
      .map((target) => ({
        targetId: target.targetId,
        path: target.applicabilityPath,
        side: target.side,
        role: target.role,
      }));
    const targetIndexById = new Map(
      applicableTargets.map(({ targetId }, index) => [targetId, index]),
    );

    type DirectGroup =
      GuidancePromptPresentationV2["sources"][number]["directRecognitionGroups"][number];
    const directGroupsByKey = new Map<string, DirectGroup>();
    for (const recognition of [...node.directRecognitions].sort(compareRecognitions)) {
      const targetIndex = targetIndexById.get(recognition.applicableTargetId);
      if (targetIndex === undefined)
        throw new Error(
          `Guidance recognition references target outside source applicability: ${recognition.applicableTargetId}.`,
        );
      const { applicableTargetId: _targetId, ...groupIdentity } = recognition;
      const key = canonicalizeJson(groupIdentity);
      const existing = directGroupsByKey.get(key);
      if (existing) existing.applicableTargetIndexes.push(targetIndex);
      else directGroupsByKey.set(key, { ...groupIdentity, applicableTargetIndexes: [targetIndex] });
    }
    const directRecognitionGroups = [...directGroupsByKey.values()]
      .map((group) => ({
        ...group,
        applicableTargetIndexes: group.applicableTargetIndexes.sort((left, right) => left - right),
      }))
      .sort((left, right) =>
        compareFields(
          [left.familyId, left.nativeOrder, left.discoveredPath, left.sourceKind],
          [right.familyId, right.nativeOrder, right.discoveredPath, right.sourceKind],
        ),
      );

    type ImportGroup =
      GuidancePromptPresentationV2["sources"][number]["inboundImportGroups"][number];
    const importGroupsByOccurrence = new Map<string, ImportGroup>();
    for (const edge of graph.edges.filter(
      ({ importedSourceId }) => importedSourceId === node.sourceId,
    )) {
      const occurrence = occurrences.get(edge.occurrenceId);
      if (!occurrence) throw new Error(`Guidance edge ${edge.edgeId} has no occurrence.`);
      const targetIndex = targetIndexById.get(edge.applicableTargetId);
      if (targetIndex === undefined)
        throw new Error(
          `Guidance edge references target outside source applicability: ${edge.applicableTargetId}.`,
        );
      const existing = importGroupsByOccurrence.get(occurrence.occurrenceId);
      const compactEdge = { edgeId: edge.edgeId, applicableTargetIndex: targetIndex };
      if (existing) existing.edges.push(compactEdge);
      else
        importGroupsByOccurrence.set(occurrence.occurrenceId, {
          occurrenceId: occurrence.occurrenceId,
          familyId: occurrence.familyId,
          syntaxKind: occurrence.syntaxKind,
          importerSourceId: occurrence.importerSourceId,
          requestedSpecifier: occurrence.requestedSpecifier,
          startUtf16: occurrence.startUtf16,
          endUtf16: occurrence.endUtf16,
          edges: [compactEdge],
        });
    }
    const inboundImportGroups = [...importGroupsByOccurrence.values()]
      .map((group) => ({
        ...group,
        edges: group.edges.sort((left, right) =>
          compareFields(
            [left.applicableTargetIndex, left.edgeId],
            [right.applicableTargetIndex, right.edgeId],
          ),
        ),
      }))
      .sort((left, right) =>
        compareFields(
          [
            left.familyId,
            left.importerSourceId,
            left.startUtf16,
            left.endUtf16,
            left.requestedSpecifier,
            left.occurrenceId,
          ],
          [
            right.familyId,
            right.importerSourceId,
            right.startUtf16,
            right.endUtf16,
            right.requestedSpecifier,
            right.occurrenceId,
          ],
        ),
      );

    sources.push({
      sourceId: node.sourceId,
      path: node.resolvedPath,
      contentDigest: node.contentDigest,
      semanticTier: node.semanticTier,
      origin: node.directRecognitions.length > 0 ? "DIRECT" : "IMPORT_ONLY",
      directRecognitionGroups,
      inboundImportGroups,
      applicableTargets,
      sourceRange: {
        coordinateUnit: "UTF16_CODE_UNIT",
        startOffset: 0,
        endOffsetExclusive: content.length,
      },
      content,
    });
  }

  return canonicalizeJson(
    GuidancePromptPresentationV2Schema.parse({
      schemaVersion: 2,
      trustBoundary: "UNTRUSTED_REPOSITORY_GUIDANCE",
      precedence:
        "Repository-peer sources have equal semantic priority. Reviewer-specific sources take precedence when guidance conflicts.",
      sources,
    }),
  );
}
