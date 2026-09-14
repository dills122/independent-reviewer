import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GuidanceCaptureError } from "../../src/guidance/base-markdown-source.js";
import {
  resolveGeminiImportPathV1,
  scanGeminiImportOccurrencesV1,
} from "../../src/guidance/gemini-imports.js";

describe("Gemini @path syntax", () => {
  it("finds prose imports with exact UTF-16 spans while excluding examples", () => {
    const content = [
      "Read @docs/shared.md and @config\\rules.md.",
      "`@inline.md`",
      "```text",
      "@example.md",
      "```",
      "<!-- @hidden.md -->",
    ].join("\n");
    const occurrences = scanGeminiImportOccurrencesV1("GEMINI.md", content);
    assert.deepEqual(
      occurrences.map(({ requestedSpecifier, startUtf16, endUtf16 }) => ({
        requestedSpecifier,
        raw: content.slice(startUtf16, endUtf16),
      })),
      [
        { requestedSpecifier: "docs/shared.md", raw: "@docs/shared.md" },
        { requestedSpecifier: "config/rules.md", raw: "@config\\rules.md" },
      ],
    );
  });

  it("resolves relative BASE paths and rejects repository escape", () => {
    assert.equal(
      resolveGeminiImportPathV1("config/GEMINI.md", "../docs/rules.md"),
      "docs/rules.md",
    );
    assert.throws(
      () => resolveGeminiImportPathV1("GEMINI.md", "../outside.md"),
      (error) =>
        error instanceof GuidanceCaptureError && error.code === "GUIDANCE_IMPORT_UNSUPPORTED",
    );
  });
});
