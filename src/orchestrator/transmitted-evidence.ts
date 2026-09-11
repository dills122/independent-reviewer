import parseDiff from "parse-diff";

import type { ReviewBrief } from "../contracts/neutral-review-brief.js";
import type { ReviewFindingV1 } from "../contracts/review-results.js";

interface VisibleSourceV1 {
  path: string;
  side: "BASE" | "HEAD";
  lines: ReadonlySet<number>;
  text: string;
}

function sourcePath(label: string | undefined, side: VisibleSourceV1["side"], fallback: string) {
  const prefix = `${side}/`;
  return label?.startsWith(prefix) ? label.slice(prefix.length) : fallback;
}

function sourceText(content: string): string {
  return content.slice(1);
}

function visibleSources(brief: ReviewBrief): VisibleSourceV1[] {
  return brief.initialEvidence.flatMap((evidence): VisibleSourceV1[] => {
    if (evidence.type === "SOURCE_CONTEXT") {
      return [
        {
          path: evidence.path,
          side: evidence.side,
          lines: new Set(
            Array.from(
              { length: evidence.endLine - evidence.startLine + 1 },
              (_, index) => evidence.startLine + index,
            ),
          ),
          text: evidence.content,
        },
      ];
    }

    return parseDiff(evidence.content).flatMap((file): VisibleSourceV1[] => {
      const baseLines = new Set<number>();
      const headLines = new Set<number>();
      const baseText: string[] = [];
      const headText: string[] = [];
      for (const chunk of file.chunks) {
        for (const change of chunk.changes) {
          if (change.type === "normal") {
            baseLines.add(change.ln1);
            headLines.add(change.ln2);
            baseText.push(sourceText(change.content));
            headText.push(sourceText(change.content));
          } else if (change.type === "del") {
            baseLines.add(change.ln);
            baseText.push(sourceText(change.content));
          } else {
            headLines.add(change.ln);
            headText.push(sourceText(change.content));
          }
        }
      }
      return [
        {
          path: sourcePath(file.from, "BASE", evidence.path),
          side: "BASE",
          lines: baseLines,
          text: baseText.join("\n"),
        },
        {
          path: sourcePath(file.to, "HEAD", evidence.path),
          side: "HEAD",
          lines: headLines,
          text: headText.join("\n"),
        },
      ];
    });
  });
}

/** Paths visible in transmitted evidence, including the BASE source of a rename or copy. */
export function transmittedEvidencePathsV1(brief: ReviewBrief): string[] {
  const paths = new Set(brief.initialEvidence.map((evidence) => evidence.path));
  for (const entry of brief.snapshotManifest.paths) {
    if (paths.has(entry.path) && "previousPath" in entry) {
      paths.add(entry.previousPath);
    }
  }
  return [...paths].sort();
}

/** Rejects source coordinates the provider could not have read from the frozen payload. */
export function assertFindingsUseTransmittedEvidenceV1(
  findings: Array<Pick<ReviewFindingV1, "evidence">>,
  brief: ReviewBrief,
): void {
  const sources = visibleSources(brief);
  for (const finding of findings) {
    for (const evidence of finding.evidence) {
      const matching = sources.filter(
        (source) => source.path === evidence.path && source.side === evidence.side,
      );
      const visible =
        evidence.anchor === "LINE_RANGE"
          ? matching.some((source) => {
              const requestedLines = evidence.endLine - evidence.startLine + 1;
              if (requestedLines > source.lines.size) return false;
              for (let line = evidence.startLine; line <= evidence.endLine; line += 1) {
                if (!source.lines.has(line)) return false;
              }
              return true;
            })
          : matching.some((source) => source.text.includes(evidence.symbol));
      if (!visible) {
        const anchor =
          evidence.anchor === "LINE_RANGE"
            ? `${evidence.startLine}-${evidence.endLine}`
            : evidence.symbol;
        throw new Error(
          `Finding evidence is not included in transmitted evidence: ${evidence.path}:${evidence.side}:${anchor}`,
        );
      }
    }
  }
}
