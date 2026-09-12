import type { GuidanceGraphV1 } from "../contracts/index.js";
import { assertClaudeImportOccurrencesMatchSourceV1 } from "./claude-imports.js";

type GuidanceNodeV1 = GuidanceGraphV1["nodes"][number];

/** Re-parses frozen source bytes so graph occurrence spans cannot be forged or omitted. */
export async function assertGuidanceImportOccurrencesV1(
  graph: GuidanceGraphV1,
  readSource: (node: GuidanceNodeV1) => Promise<Uint8Array>,
): Promise<void> {
  const nodes = new Map(graph.nodes.map((node) => [node.sourceId, node]));
  const occurrences = new Map(
    graph.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]),
  );
  const importEnabledClaudeSources = new Set(
    graph.nodes
      .filter((node) =>
        node.directRecognitions.some(
          ({ familyId, sourceKind }) => familyId === "CLAUDE" && sourceKind !== "CLAUDE_RULE",
        ),
      )
      .map(({ sourceId }) => sourceId),
  );

  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges) {
      const occurrence = occurrences.get(edge.occurrenceId);
      if (
        occurrence?.familyId !== "CLAUDE" ||
        !importEnabledClaudeSources.has(occurrence.importerSourceId) ||
        importEnabledClaudeSources.has(edge.importedSourceId)
      )
        continue;
      importEnabledClaudeSources.add(edge.importedSourceId);
      changed = true;
    }
  }

  for (const occurrence of graph.occurrences) {
    if (
      occurrence.familyId === "CLAUDE" &&
      !importEnabledClaudeSources.has(occurrence.importerSourceId)
    )
      throw new Error(`Claude occurrence ${occurrence.occurrenceId} has an unsupported importer.`);
  }

  for (const sourceId of [...importEnabledClaudeSources].sort()) {
    const node = nodes.get(sourceId);
    if (!node) throw new Error(`Guidance source ${sourceId} is missing.`);
    const bytes = await readSource(node);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`Guidance source ${node.resolvedPath} is not valid UTF-8.`);
    }
    assertClaudeImportOccurrencesMatchSourceV1(
      node.resolvedPath,
      content,
      graph.occurrences.filter(
        (occurrence) =>
          occurrence.familyId === "CLAUDE" && occurrence.importerSourceId === sourceId,
      ),
    );
  }
}
