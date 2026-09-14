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

export interface KiroFileReferenceOccurrenceV1 {
  requestedSpecifier: string;
  startUtf16: number;
  endUtf16: number;
}

function importError(
  code: "GUIDANCE_IMPORT_OCCURRENCE_LIMIT" | "GUIDANCE_IMPORT_UNSUPPORTED",
  path: string,
): never {
  throw new GuidanceCaptureError(
    code,
    path,
    `${path} has invalid or over-limit Kiro file references.`,
  );
}

/** Finds Kiro `#[[file:...]]` references in prose, excluding literal Markdown nodes. */
export function scanKiroFileReferenceOccurrencesV1(
  path: string,
  content: string,
): KiroFileReferenceOccurrenceV1[] {
  const root: Root = unified().use(remarkParse).parse(content);
  const occurrences: KiroFileReferenceOccurrenceV1[] = [];
  const walk = (node: MarkdownNodeV1) => {
    if (node.type === "code" || node.type === "inlineCode" || node.type === "html") return;
    if (node.type === "text") {
      const nodeStart = node.position?.start.offset;
      const nodeEnd = node.position?.end.offset;
      if (nodeStart === undefined || nodeEnd === undefined)
        importError("GUIDANCE_IMPORT_UNSUPPORTED", path);
      const rawText = content.slice(nodeStart, nodeEnd);
      for (const match of rawText.matchAll(/#\[\[file:([^\]\r\n]+)\]\]/gu)) {
        const rawSpecifier = match[1];
        if (!rawSpecifier) continue;
        const requestedSpecifier = rawSpecifier.replaceAll("\\", "/");
        if (
          requestedSpecifier.length > MAX_IMPORT_SPECIFIER_UTF16_V1 ||
          /[\r\n\0]/u.test(requestedSpecifier)
        ) {
          importError("GUIDANCE_IMPORT_UNSUPPORTED", path);
        }
        const startUtf16 = nodeStart + (match.index ?? 0);
        occurrences.push({
          requestedSpecifier,
          startUtf16,
          endUtf16: startUtf16 + match[0].length,
        });
        if (occurrences.length > MAX_IMPORT_OCCURRENCES_PER_SOURCE_V1)
          importError("GUIDANCE_IMPORT_OCCURRENCE_LIMIT", path);
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root as MarkdownNodeV1);
  return occurrences;
}

/** Resolves one Kiro file reference relative to its frozen containing file. */
export function resolveKiroFileReferencePathV1(
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
