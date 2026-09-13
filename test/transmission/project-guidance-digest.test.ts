import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { NeutralReviewBriefV1 } from "../../src/contracts/index.js";
import {
  compactProjectGuidanceV1,
  type ProjectGuidanceRuleV1,
} from "../../src/transmission/project-guidance-digest.js";

type GuidanceInputV1 = NeutralReviewBriefV1["canonicalInputs"]["projectGuidance"][number];

function guidance(id: string, content: string): GuidanceInputV1 {
  return {
    id,
    kind: "PROJECT_GUIDANCE",
    title: `Guidance ${id}`,
    content,
    provenance: { type: "INLINE", label: id },
  };
}

describe("compactProjectGuidanceV1", () => {
  it("gives every guidance source an order-independent byte share", () => {
    const large = guidance(
      "input_large",
      Array.from({ length: 30 }, (_, index) => `- large rule ${index}`).join("\n"),
    );
    const small = guidance("input_small", "- keep this rule");

    for (const inputs of [
      [large, small],
      [small, large],
    ]) {
      const byId = new Map(compactProjectGuidanceV1(inputs, 400).map((entry) => [entry.id, entry]));
      assert.equal(byId.get("input_large")?.truncated, true);
      assert.equal(byId.get("input_small")?.truncated, false);
      assert.deepEqual(
        byId.get("input_small")?.rules.map((rule) => rule.text),
        ["keep this rule"],
      );
    }
  });

  it("accounts for UTF-8 bytes at the exact boundary", () => {
    const input = guidance("input_unicode", "- 🚀");
    const rule: ProjectGuidanceRuleV1 = {
      ruleId: "input_unicode:R1",
      section: input.title,
      text: "🚀",
    };
    const exactBytes = Buffer.byteLength(JSON.stringify(rule), "utf8");

    assert.equal(compactProjectGuidanceV1([input], exactBytes)[0]?.truncated, false);
    assert.equal(compactProjectGuidanceV1([input], exactBytes - 1)[0]?.truncated, true);
  });

  it("groups continuation lines with an explicit cursor", () => {
    const [entry] = compactProjectGuidanceV1(
      [guidance("input_grouped", "## Safety\n- First rule\ncontinued detail\n- Second rule")],
      1_000,
    );

    assert.deepEqual(
      entry?.rules.map(({ section, text }) => ({ section, text })),
      [
        { section: "Safety", text: "Safety" },
        { section: "Safety", text: "First rule continued detail" },
        { section: "Safety", text: "Second rule" },
      ],
    );
  });
});
