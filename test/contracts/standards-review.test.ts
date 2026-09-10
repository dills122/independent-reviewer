import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ReviewRequestV1Schema } from "../../src/contracts/review-request.js";
import {
  StandardsProfileV1Schema,
  StandardsReviewRequestV2Schema,
} from "../../src/contracts/standards-review.js";

export const profile = {
  schemaVersion: 1,
  name: "Project conventions",
  source: "CONTRIBUTING.md",
  rules: [
    {
      id: "rule_layering",
      text: "UI modules must not import persistence modules.",
      enforcement: "REQUIRED",
      paths: ["src/**/*.ts"],
      exceptions: null,
    },
  ],
};

test("standards request needs code, standards and author input, not a business plan", async () => {
  const legacy = JSON.parse(await readFile("test/fixtures/review-request.valid.json", "utf8"));
  const request = {
    ...legacy,
    schemaVersion: 2,
    mode: "STANDARDS",
    canonicalInputs: {
      standards: [
        {
          id: "input_standards",
          kind: "PROJECT_GUIDANCE",
          title: profile.name,
          content: JSON.stringify(profile),
          provenance: { type: "INLINE", label: "Selected project rules" },
        },
      ],
    },
    authorPacket: {
      schemaVersion: 2,
      overview: "Author explains the layering decision.",
      claimedVerification: [],
    },
  };
  assert.equal(StandardsReviewRequestV2Schema.parse(request).mode, "STANDARDS");
  assert.equal(ReviewRequestV1Schema.safeParse(request).success, false);
  const { authorPacket: _, ...missingAuthor } = request;
  assert.equal(StandardsReviewRequestV2Schema.safeParse(missingAuthor).success, false);
  assert.equal(
    StandardsReviewRequestV2Schema.safeParse({ ...request, canonicalInputs: { standards: [] } })
      .success,
    false,
  );
  assert.equal(ReviewRequestV1Schema.safeParse(legacy).success, true);
});

test("selected standards reject duplicate rule identities and empty applicability", () => {
  assert.equal(
    StandardsProfileV1Schema.safeParse({ ...profile, rules: [...profile.rules, ...profile.rules] })
      .success,
    false,
  );
  assert.equal(
    StandardsProfileV1Schema.safeParse({ ...profile, rules: [{ ...profile.rules[0], paths: [] }] })
      .success,
    false,
  );
});
