import {
  type ClaudeImportOccurrenceV1,
  resolveClaudeImportPathV1,
  scanClaudeImportOccurrencesV1,
} from "./claude-imports.js";

export type CopilotImportOccurrenceV1 = ClaudeImportOccurrenceV1;

/** Finds supported Copilot @path references using the shared bounded Markdown scanner. */
export function scanCopilotImportOccurrencesV1(
  path: string,
  content: string,
): CopilotImportOccurrenceV1[] {
  return scanClaudeImportOccurrencesV1(path, content);
}

/** Resolves one Copilot @path against its containing frozen BASE source. */
export function resolveCopilotImportPathV1(
  importerPath: string,
  requestedSpecifier: string,
): string {
  return resolveClaudeImportPathV1(importerPath, requestedSpecifier);
}
