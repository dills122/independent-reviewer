import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GuidanceCaptureError } from "../../src/guidance/base-markdown-source.js";
import {
  resolveKiroFileReferencePathV1,
  scanKiroFileReferenceOccurrencesV1,
} from "../../src/guidance/kiro-imports.js";

describe("Kiro file reference syntax", () => {
  it("finds file references with exact UTF-16 spans while excluding examples", () => {
    const content = [
      "Read #[[file:../docs/shared.md]] now.",
      "`#[[file:inline.md]]`",
      "<!-- #[[file:hidden.md]] -->",
    ].join("\n");
    const occurrences = scanKiroFileReferenceOccurrencesV1(".kiro/steering/source.md", content);
    assert.deepEqual(
      occurrences.map(({ requestedSpecifier, startUtf16, endUtf16 }) => ({
        requestedSpecifier,
        raw: content.slice(startUtf16, endUtf16),
      })),
      [{ requestedSpecifier: "../docs/shared.md", raw: "#[[file:../docs/shared.md]]" }],
    );
  });

  it("resolves relative BASE paths and rejects repository escape", () => {
    assert.equal(
      resolveKiroFileReferencePathV1(".kiro/steering/source.md", "../../docs/shared.md"),
      "docs/shared.md",
    );
    assert.throws(
      () => resolveKiroFileReferencePathV1(".kiro/steering/source.md", "../../../outside.md"),
      (error) =>
        error instanceof GuidanceCaptureError && error.code === "GUIDANCE_IMPORT_UNSUPPORTED",
    );
  });
});
