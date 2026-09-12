import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ReviewRequestV1Schema } from "../../src/contracts/review-request.js";
import {
  StandardsReviewBriefV2Schema,
  StandardsReviewBriefV3Schema,
} from "../../src/contracts/neutral-review-brief.js";
import {
  contractJsonSchema,
  StandardsCanonicalInputsV2Schema,
  StandardsProfileSchema,
  StandardsProfileV1Schema,
  STANDARDS_PROFILE_V2_JSON_SCHEMA,
  StandardsProfileV2Schema,
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

function standardsInput(id: string, content: string) {
  return {
    id,
    kind: "PROJECT_GUIDANCE" as const,
    title: id,
    content,
    provenance: { type: "INLINE" as const, label: id },
  };
}

test("standards input reports strict JSON and schema failures distinctly with field paths", () => {
  const duplicateJson = StandardsCanonicalInputsV2Schema.safeParse({
    standards: [
      standardsInput(
        "input_duplicate_json",
        JSON.stringify(profile).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      ),
    ],
  });
  assert.equal(duplicateJson.success, false);
  if (duplicateJson.success) return;
  assert.match(duplicateJson.error.issues[0]?.message ?? "", /JSON_DUPLICATE_PROPERTY/);

  const malformedJson = StandardsCanonicalInputsV2Schema.safeParse({
    standards: [standardsInput("input_malformed_json", "{")],
  });
  assert.equal(malformedJson.success, false);
  if (malformedJson.success) return;
  assert.match(malformedJson.error.issues[0]?.message ?? "", /JSON_SYNTAX/);

  const invalidProfile = StandardsCanonicalInputsV2Schema.safeParse({
    standards: [
      standardsInput(
        "input_invalid_profile",
        JSON.stringify({
          ...profile,
          rules: [{ ...profile.rules[0], paths: [] }],
        }),
      ),
    ],
  });
  assert.equal(invalidProfile.success, false);
  if (invalidProfile.success) return;
  assert.deepEqual(invalidProfile.error.issues[0]?.path, [
    "standards",
    0,
    "content",
    "rules",
    0,
    "paths",
  ]);
  assert.doesNotMatch(invalidProfile.error.issues[0]?.message ?? "", /JSON_/);
});

test("standards conflicts name the identifier and first defining input", () => {
  const result = StandardsCanonicalInputsV2Schema.safeParse({
    standards: [
      standardsInput("input_first", JSON.stringify(profile)),
      standardsInput("input_second", JSON.stringify({ ...profile, name: "Second profile" })),
    ],
  });

  assert.equal(result.success, false);
  if (result.success) return;
  assert.deepEqual(result.error.issues[0]?.path, ["standards", 1, "content"]);
  assert.match(result.error.issues[0]?.message ?? "", /rule_layering/);
  assert.match(result.error.issues[0]?.message ?? "", /input_first/);
  assert.match(result.error.issues[0]?.message ?? "", /index 0/);
});

test("a conflicting profile does not poison a later blameless profile", () => {
  const ruleA = { ...profile.rules[0], id: "rule_a" };
  const ruleB = { ...profile.rules[0], id: "rule_b" };
  const result = StandardsCanonicalInputsV2Schema.safeParse({
    standards: [
      standardsInput("input_p0", JSON.stringify({ ...profile, rules: [ruleA] })),
      standardsInput("input_p1", JSON.stringify({ ...profile, rules: [ruleB, ruleA] })),
      standardsInput("input_p2", JSON.stringify({ ...profile, rules: [ruleB] })),
    ],
  });

  assert.equal(result.success, false);
  if (result.success) return;
  assert.deepEqual(
    result.error.issues.map((issue) => issue.path),
    [["standards", 1, "content"]],
  );
});

test("standards profile v2 binds typed BASE references to rules", () => {
  const versioned = {
    ...profile,
    schemaVersion: 2,
    references: [
      {
        id: "reference_api_names",
        path: "API_NAMES.md",
        purpose: "Authoritative public API name registry.",
        authority: "BASE",
      },
    ],
    referenceBindings: [
      { ruleId: "rule_layering", referenceId: "reference_api_names", required: true },
    ],
  };

  assert.equal(StandardsProfileV2Schema.safeParse(versioned).success, true);
  assert.equal(StandardsProfileSchema.safeParse(versioned).success, true);
  assert.equal(StandardsProfileV1Schema.safeParse(versioned).success, false);
  assert.equal(
    StandardsProfileV2Schema.safeParse({
      ...versioned,
      referenceBindings: [
        { ruleId: "rule_missing", referenceId: "reference_api_names", required: true },
      ],
    }).success,
    false,
  );
  assert.equal(
    StandardsProfileV2Schema.safeParse({
      ...versioned,
      referenceBindings: [...versioned.referenceBindings, ...versioned.referenceBindings],
    }).success,
    false,
  );
});

test("standards profile and brief v2 match committed JSON Schemas", async () => {
  assert.deepEqual(
    JSON.parse(await readFile("schemas/standards-profile-v2.schema.json", "utf8")),
    STANDARDS_PROFILE_V2_JSON_SCHEMA,
  );
  assert.deepEqual(
    JSON.parse(await readFile("schemas/standards-review-brief-v2.schema.json", "utf8")),
    contractJsonSchema(StandardsReviewBriefV2Schema, "standards-review-brief:v2"),
  );
  assert.deepEqual(
    JSON.parse(await readFile("schemas/standards-review-brief-v3.schema.json", "utf8")),
    contractJsonSchema(StandardsReviewBriefV3Schema, "standards-review-brief:v3"),
  );
});
