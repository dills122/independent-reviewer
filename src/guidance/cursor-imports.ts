import {
  type ClaudeImportOccurrenceV1,
  resolveClaudeImportPathV1,
  scanClaudeImportOccurrencesV1,
} from "./claude-imports.js";

export type CursorImportOccurrenceV1 = ClaudeImportOccurrenceV1;

/** Finds supported Cursor @filename references using the shared bounded Markdown scanner. */
export function scanCursorImportOccurrencesV1(
  path: string,
  content: string,
): CursorImportOccurrenceV1[] {
  return scanClaudeImportOccurrencesV1(path, content);
}

/** Resolves one Cursor @filename against its containing frozen BASE source. */
export function resolveCursorImportPathV1(
  importerPath: string,
  requestedSpecifier: string,
): string {
  return resolveClaudeImportPathV1(importerPath, requestedSpecifier);
}
