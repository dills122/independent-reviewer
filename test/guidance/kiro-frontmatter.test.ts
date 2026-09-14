import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GuidanceCaptureError } from "../../src/guidance/base-markdown-source.js";
import { parseKiroSteeringFrontmatterV1 } from "../../src/guidance/kiro-frontmatter.js";

describe("Kiro steering frontmatter", () => {
  it("defaults missing inclusion to always", () => {
    assert.deepEqual(parseKiroSteeringFrontmatterV1(".kiro/steering/all.md", "# All\n"), {
      inclusion: "always",
    });
  });

  it("accepts fileMatch string and array native shapes", () => {
    assert.deepEqual(
      parseKiroSteeringFrontmatterV1(
        ".kiro/steering/source.md",
        "---\ninclusion: fileMatch\nfileMatchPattern: src/**\n---\n# Source\n",
      ),
      { inclusion: "fileMatch", fileMatchPatterns: ["src/**"] },
    );
    assert.deepEqual(
      parseKiroSteeringFrontmatterV1(
        ".kiro/steering/code.md",
        "---\ninclusion: fileMatch\nfileMatchPattern: [src/**, test/**]\n---\n# Code\n",
      ),
      { inclusion: "fileMatch", fileMatchPatterns: ["src/**", "test/**"] },
    );
  });

  it("retains manual and auto as typed modes", () => {
    for (const inclusion of ["manual", "auto"] as const) {
      assert.deepEqual(
        parseKiroSteeringFrontmatterV1(
          `.kiro/steering/${inclusion}.md`,
          `---\ninclusion: ${inclusion}\n---\n# Dynamic\n`,
        ),
        { inclusion },
      );
    }
  });

  it("rejects malformed or inconsistent recognized fields", () => {
    for (const content of [
      "---\ninclusion: fileMatch\n---\n# Missing pattern\n",
      "---\ninclusion: always\nfileMatchPattern: src/**\n---\n",
      "---\ninclusion: sometimes\n---\n",
      "---\ninclusion: fileMatch\nfileMatchPattern: []\n---\n",
    ]) {
      assert.throws(
        () => parseKiroSteeringFrontmatterV1(".kiro/steering/bad.md", content),
        (error) => error instanceof GuidanceCaptureError,
      );
    }
  });
});
