import {
  type ClaudeImportOccurrenceV1,
  resolveClaudeImportPathV1,
  scanClaudeImportOccurrencesV1,
} from "./claude-imports.js";

export type GeminiImportOccurrenceV1 = ClaudeImportOccurrenceV1;

/** Gemini uses the same bounded prose `@path` token shape in v1. */
export function scanGeminiImportOccurrencesV1(
  path: string,
  content: string,
): GeminiImportOccurrenceV1[] {
  return scanClaudeImportOccurrencesV1(path, content);
}

/** Resolves one Gemini import relative to its frozen containing file. */
export function resolveGeminiImportPathV1(
  importerPath: string,
  requestedSpecifier: string,
): string {
  return resolveClaudeImportPathV1(importerPath, requestedSpecifier);
}
