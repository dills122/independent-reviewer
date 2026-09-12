import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GuidanceCaptureError } from "../../src/guidance/base-markdown-source.js";
import {
  assertClaudeImportOccurrencesMatchSourceV1,
  resolveClaudeImportPathV1,
  scanClaudeImportOccurrencesV1,
} from "../../src/guidance/claude-imports.js";

describe("Claude @path syntax", () => {
  it("finds file tokens with exact UTF-16 spans and normalizes separators", () => {
    const content =
      "See @README and @package.json.\n- workflow @../docs/git.md\n- windows @docs\\checks.md\n";
    const occurrences = scanClaudeImportOccurrencesV1("config/CLAUDE.md", content);

    assert.deepEqual(
      occurrences.map(({ requestedSpecifier, startUtf16, endUtf16 }) => ({
        requestedSpecifier,
        startUtf16,
        endUtf16,
        raw: content.slice(startUtf16, endUtf16),
      })),
      [
        { requestedSpecifier: "README", startUtf16: 4, endUtf16: 11, raw: "@README" },
        {
          requestedSpecifier: "package.json",
          startUtf16: 16,
          endUtf16: 29,
          raw: "@package.json",
        },
        {
          requestedSpecifier: "../docs/git.md",
          startUtf16: 42,
          endUtf16: 57,
          raw: "@../docs/git.md",
        },
        {
          requestedSpecifier: "docs/checks.md",
          startUtf16: 68,
          endUtf16: 83,
          raw: "@docs\\checks.md",
        },
      ],
    );
  });

  it("does not treat examples, inline code, HTML comments, or email addresses as imports", () => {
    const content = [
      "`@inline.md`",
      "```text",
      "@example.md",
      "```",
      "<!-- @hidden.md -->",
      "owner@example.com",
      "Real @docs/live.md",
    ].join("\n");

    assert.deepEqual(
      scanClaudeImportOccurrencesV1("CLAUDE.md", content).map(
        ({ requestedSpecifier }) => requestedSpecifier,
      ),
      ["docs/live.md"],
    );
  });

  it("resolves relative to the containing file while rejecting external paths", () => {
    assert.equal(
      resolveClaudeImportPathV1("config/CLAUDE.md", "../docs/rules.md"),
      "docs/rules.md",
    );
    assert.equal(resolveClaudeImportPathV1("CLAUDE.md", "AGENTS.md"), "AGENTS.md");

    for (const specifier of ["../../outside.md", "/etc/passwd", "~/private.md", "https://x.test/a"])
      assert.throws(
        () => resolveClaudeImportPathV1("config/CLAUDE.md", specifier),
        (error) =>
          error instanceof GuidanceCaptureError && error.code === "GUIDANCE_IMPORT_UNSUPPORTED",
      );
  });

  it("enforces the per-source occurrence limit", () => {
    const content = Array.from({ length: 33 }, (_, index) => `@docs/${index}.md`).join("\n");
    assert.throws(
      () => scanClaudeImportOccurrencesV1("CLAUDE.md", content),
      (error) =>
        error instanceof GuidanceCaptureError && error.code === "GUIDANCE_IMPORT_OCCURRENCE_LIMIT",
    );
  });

  it("rejects persisted occurrence spans that do not match frozen source syntax", () => {
    const content = "Read @docs/live.md\n";
    const [occurrence] = scanClaudeImportOccurrencesV1("CLAUDE.md", content);
    assert.ok(occurrence);
    assert.doesNotThrow(() =>
      assertClaudeImportOccurrencesMatchSourceV1("CLAUDE.md", content, [occurrence]),
    );
    assert.throws(
      () =>
        assertClaudeImportOccurrencesMatchSourceV1("CLAUDE.md", content, [
          { ...occurrence, startUtf16: occurrence.startUtf16 + 1 },
        ]),
      (error) =>
        error instanceof GuidanceCaptureError && error.code === "GUIDANCE_IMPORT_UNSUPPORTED",
    );
  });
});
