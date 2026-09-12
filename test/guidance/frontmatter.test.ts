import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GuidanceCaptureError } from "../../src/guidance/base-markdown-source.js";
import { parseGuidanceFrontmatterV1 } from "../../src/guidance/frontmatter.js";

describe("parseGuidanceFrontmatterV1", () => {
  it("uses remark and YAML to parse bounded paths while ignoring unknown metadata", () => {
    const parsed = parseGuidanceFrontmatterV1(
      ".claude/rules/tests.md",
      "---\npaths:\n  - 'src/**/*.ts'\n  - 'test/{unit,integration}/**'\ndescription: Test rules\n---\n# Rules\n",
    );

    assert.deepEqual(parsed, { paths: ["src/**/*.ts", "test/{unit,integration}/**"] });
  });

  it("returns no paths when frontmatter is absent", () => {
    assert.deepEqual(parseGuidanceFrontmatterV1("CLAUDE.md", "# Rules\n"), {});
  });

  it("rejects malformed recognized frontmatter and invalid paths shapes", () => {
    for (const content of [
      "---\npaths: [src/**\n# Rules\n",
      "---\npaths: src/**\n---\n",
      "---\npaths: [src/**, '']\n---\n",
      "---\npaths: [src/**]\npaths: [test/**]\n---\n",
    ]) {
      assert.throws(
        () => parseGuidanceFrontmatterV1(".claude/rules/bad.md", content),
        (error) =>
          error instanceof GuidanceCaptureError && error.code === "GUIDANCE_INVALID_FRONTMATTER",
      );
    }
  });

  it("rejects aliases, merge keys, and custom tags", () => {
    for (const content of [
      "---\nbase: &base [src/**]\npaths: *base\n---\n",
      "---\nbase: &base\n  paths: [src/**]\n<<: *base\n---\n",
      "---\npaths: !custom [src/**]\n---\n",
    ]) {
      assert.throws(
        () => parseGuidanceFrontmatterV1(".claude/rules/unsafe.md", content),
        (error) =>
          error instanceof GuidanceCaptureError && error.code === "GUIDANCE_INVALID_FRONTMATTER",
      );
    }
  });

  it("enforces byte, depth, and YAML-node limits before returning data", () => {
    const oversized = `---\ndescription: ${"x".repeat(16 * 1024)}\n---\n`;
    const deep = `---\n${Array.from({ length: 17 }, (_, index) => `${"  ".repeat(index)}k${index}:`).join("\n")} value\n---\n`;
    const wide = `---\n${Array.from({ length: 129 }, (_, index) => `k${index}: v`).join("\n")}\n---\n`;

    for (const content of [oversized, deep, wide]) {
      assert.throws(
        () => parseGuidanceFrontmatterV1(".claude/rules/large.md", content),
        (error) =>
          error instanceof GuidanceCaptureError && error.code === "GUIDANCE_INVALID_FRONTMATTER",
      );
    }
  });
});
