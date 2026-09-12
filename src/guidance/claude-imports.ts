import { posix } from "node:path";

import type { Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { SnapshotPathV1Schema } from "../contracts/index.js";
import { GuidanceCaptureError } from "./base-markdown-source.js";

const MAX_IMPORT_SPECIFIER_UTF16_V1 = 1_024;
const MAX_IMPORT_OCCURRENCES_PER_SOURCE_V1 = 32;

interface MarkdownNodeV1 {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNodeV1[];
}

export interface ClaudeImportOccurrenceV1 {
  requestedSpecifier: string;
  startUtf16: number;
  endUtf16: number;
}

function occurrenceKey(occurrence: ClaudeImportOccurrenceV1): string {
  return JSON.stringify([
    occurrence.requestedSpecifier,
    occurrence.startUtf16,
    occurrence.endUtf16,
  ]);
}

function importError(
  code: "GUIDANCE_IMPORT_OCCURRENCE_LIMIT" | "GUIDANCE_IMPORT_UNSUPPORTED",
  path: string,
): never {
  throw new GuidanceCaptureError(code, path, `${path} has invalid or over-limit @path imports.`);
}

/** Finds Claude @path tokens in prose while excluding literal/example Markdown nodes. */
export function scanClaudeImportOccurrencesV1(
  path: string,
  content: string,
): ClaudeImportOccurrenceV1[] {
  const root: Root = unified().use(remarkParse).parse(content);
  const occurrences: ClaudeImportOccurrenceV1[] = [];
  const walk = (node: MarkdownNodeV1) => {
    if (node.type === "code" || node.type === "inlineCode" || node.type === "html") return;
    if (node.type === "text") {
      const nodeStart = node.position?.start.offset;
      const nodeEnd = node.position?.end.offset;
      if (nodeStart === undefined || nodeEnd === undefined)
        importError("GUIDANCE_IMPORT_UNSUPPORTED", path);
      const rawText = content.slice(nodeStart, nodeEnd);
      const pattern = /(^|[^\p{L}\p{N}._~\\/-])@([\p{L}\p{N}._~\\/:+-]+)/gu;
      for (const match of rawText.matchAll(pattern)) {
        const boundary = match[1] ?? "";
        const rawSpecifier = (match[2] ?? "").replace(/[.,;:!?]+$/u, "");
        if (rawSpecifier.length === 0) continue;
        const startUtf16 = nodeStart + (match.index ?? 0) + boundary.length;
        const endUtf16 = startUtf16 + 1 + rawSpecifier.length;
        const requestedSpecifier = rawSpecifier.replaceAll("\\", "/");
        if (requestedSpecifier.length > MAX_IMPORT_SPECIFIER_UTF16_V1)
          importError("GUIDANCE_IMPORT_UNSUPPORTED", path);
        occurrences.push({ requestedSpecifier, startUtf16, endUtf16 });
        if (occurrences.length > MAX_IMPORT_OCCURRENCES_PER_SOURCE_V1)
          importError("GUIDANCE_IMPORT_OCCURRENCE_LIMIT", path);
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root as MarkdownNodeV1);
  return occurrences;
}

/** Verifies persisted Claude occurrence records against the exact frozen importer bytes. */
export function assertClaudeImportOccurrencesMatchSourceV1(
  path: string,
  content: string,
  occurrences: readonly ClaudeImportOccurrenceV1[],
): void {
  const expected = scanClaudeImportOccurrencesV1(path, content).map(occurrenceKey).sort();
  const actual = occurrences.map(occurrenceKey).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    importError("GUIDANCE_IMPORT_UNSUPPORTED", path);
}

/** Resolves one normalized Claude specifier relative to its containing repository file. */
export function resolveClaudeImportPathV1(
  importerPath: string,
  requestedSpecifier: string,
): string {
  if (
    requestedSpecifier.length === 0 ||
    requestedSpecifier.length > MAX_IMPORT_SPECIFIER_UTF16_V1 ||
    requestedSpecifier.startsWith("~") ||
    posix.isAbsolute(requestedSpecifier) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(requestedSpecifier) ||
    /[\r\n\0]/u.test(requestedSpecifier)
  ) {
    importError("GUIDANCE_IMPORT_UNSUPPORTED", importerPath);
  }
  const resolved = posix.normalize(posix.join(posix.dirname(importerPath), requestedSpecifier));
  if (resolved === ".." || resolved.startsWith("../"))
    importError("GUIDANCE_IMPORT_UNSUPPORTED", importerPath);
  try {
    return SnapshotPathV1Schema.parse(resolved);
  } catch {
    importError("GUIDANCE_IMPORT_UNSUPPORTED", importerPath);
  }
}
