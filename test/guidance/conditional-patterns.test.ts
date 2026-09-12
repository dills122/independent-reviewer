import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GuidanceCaptureError } from "../../src/guidance/base-markdown-source.js";
import { compileGuidancePatternsV1 } from "../../src/guidance/conditional-patterns.js";

describe("compileGuidancePatternsV1", () => {
  it("matches the bounded product glob dialect on normalized repository paths", () => {
    const matches = compileGuidancePatternsV1(".claude/rules/tests.md", [
      "{src,test}/**/*.{ts,tsx}",
    ]);

    assert.equal(matches("src/api/client.ts"), true);
    assert.equal(matches("test/.fixtures/view.tsx"), true);
    assert.equal(matches("src/api/client.js"), false);
    assert.equal(matches("other/client.ts"), false);
  });

  it("rejects unsupported or malformed syntax", () => {
    for (const pattern of [
      "/src/**",
      "../src/**",
      "src\\**",
      "src/+(a|aa)",
      "src/[abc",
      "src/{a,b",
      "src\n/**",
    ]) {
      assert.throws(
        () => compileGuidancePatternsV1(".claude/rules/bad.md", [pattern]),
        (error) =>
          error instanceof GuidanceCaptureError && error.code === "GUIDANCE_INVALID_PATTERN",
      );
    }
  });

  it("rejects brace group and expansion products before whole-pattern expansion", () => {
    const tooManyGroups = `${"{a,b}".repeat(9)}/**`;
    const excessiveProduct = `${"{a,b,c}".repeat(6)}/**`;

    for (const pattern of [tooManyGroups, excessiveProduct]) {
      assert.throws(
        () => compileGuidancePatternsV1(".claude/rules/large.md", [pattern]),
        (error) =>
          error instanceof GuidanceCaptureError && error.code === "GUIDANCE_INVALID_PATTERN",
      );
    }
  });

  it("enforces per-source pattern and compiled-alternative limits", () => {
    assert.throws(
      () =>
        compileGuidancePatternsV1(
          ".claude/rules/many.md",
          Array.from({ length: 65 }, (_, index) => `path-${index}/**`),
        ),
      (error) => error instanceof GuidanceCaptureError && error.code === "GUIDANCE_INVALID_PATTERN",
    );
    assert.throws(
      () =>
        compileGuidancePatternsV1(
          ".claude/rules/many.md",
          Array.from({ length: 64 }, (_, index) => `path-${index}/{0..16}/**`),
        ),
      (error) => error instanceof GuidanceCaptureError && error.code === "GUIDANCE_INVALID_PATTERN",
    );
  });
});
