import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GuidanceCaptureError } from "../../src/guidance/base-markdown-source.js";
import { parseCursorFrontmatterV1 } from "../../src/guidance/cursor-frontmatter.js";

describe("parseCursorFrontmatterV1", () => {
  it("distinguishes Cursor always, auto-attached, agent-requested, and manual modes", () => {
    assert.equal(
      parseCursorFrontmatterV1("always.mdc", "---\nalwaysApply: true\n---\n# Rule\n").mode,
      "always",
    );
    assert.equal(
      parseCursorFrontmatterV1("auto.mdc", "---\nglobs: src/**\n---\n# Rule\n").mode,
      "autoAttached",
    );
    assert.equal(
      parseCursorFrontmatterV1(
        "agent.mdc",
        "---\ndescription: Use when reviewing APIs\n---\n# Rule\n",
      ).mode,
      "agentRequested",
    );
    assert.equal(parseCursorFrontmatterV1("manual.mdc", "# Rule\n").mode, "manual");
  });

  it("rejects leading unterminated YAML frontmatter", () => {
    assert.throws(
      () => parseCursorFrontmatterV1("bad.mdc", "---\nalwaysApply: true\n# Rule\n"),
      (error) =>
        error instanceof GuidanceCaptureError && error.code === "GUIDANCE_INVALID_FRONTMATTER",
    );
  });
});
