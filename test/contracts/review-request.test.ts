import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  NEUTRAL_REVIEW_BRIEF_V1_JSON_SCHEMA,
  REVIEW_REQUEST_V1_JSON_SCHEMA,
  ReviewRequestV1Schema,
  SNAPSHOT_MANIFEST_V1_JSON_SCHEMA,
} from "../../src/index.js";

async function readFixture(name: string): Promise<unknown> {
  const contents = await readFile(resolve("test", "fixtures", name), "utf8");
  return JSON.parse(contents) as unknown;
}

describe("ReviewRequestV1Schema", () => {
  it("accepts the valid fixture and materializes cumulative working-tree defaults", async () => {
    const request = ReviewRequestV1Schema.parse(await readFixture("review-request.valid.json"));

    assert.deepEqual(request.repository.workingTree, {
      mode: "CUMULATIVE",
      includeUntracked: true,
    });
    assert.equal(request.authorPacket?.schemaVersion, 1);
  });

  it("accepts preparation without an author packet", async () => {
    const fixture = await readFixture("review-request.valid.json");
    assert.ok(fixture && typeof fixture === "object" && !Array.isArray(fixture));
    const { authorPacket: _authorPacket, ...withoutAuthor } = fixture as Record<string, unknown>;

    const request = ReviewRequestV1Schema.parse(withoutAuthor);

    assert.equal(request.authorPacket, undefined);
  });

  it("rejects a review-instance number above its declared maximum", async () => {
    const result = ReviewRequestV1Schema.safeParse(
      await readFixture("review-request.invalid.json"),
    );

    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(
        result.error.issues.some((issue) => issue.path.join(".") === "reviewInstance.number"),
      );
    }
  });

  it("rejects unknown fields instead of silently stripping them", async () => {
    const fixture = await readFixture("review-request.valid.json");
    assert.ok(fixture && typeof fixture === "object" && !Array.isArray(fixture));

    const result = ReviewRequestV1Schema.safeParse({ ...fixture, unexpected: true });

    assert.equal(result.success, false);
  });

  it("enforces the declared identifier prefix for each request field", async () => {
    const fixture = await readFixture("review-request.valid.json");
    assert.ok(fixture && typeof fixture === "object" && !Array.isArray(fixture));
    const changed = { ...fixture, flowId: "config_not_a_flow" };

    const result = ReviewRequestV1Schema.safeParse(changed);

    assert.equal(result.success, false);
  });

  it("rejects an implementation plan mislabeled as another canonical-input kind", async () => {
    const fixture = await readFixture("review-request.valid.json");
    assert.ok(fixture && typeof fixture === "object" && !Array.isArray(fixture));
    const changed = structuredClone(fixture) as {
      canonicalInputs: { implementationPlan: { kind: string } };
    };
    changed.canonicalInputs.implementationPlan.kind = "REQUIREMENTS";

    const result = ReviewRequestV1Schema.safeParse(changed);

    assert.equal(result.success, false);
  });

  it("rejects duplicate canonical-input identifiers", async () => {
    const fixture = structuredClone(await readFixture("review-request.valid.json")) as {
      canonicalInputs: {
        requirements: Array<{ id: string }>;
        implementationPlan: { id: string };
      };
    };
    const requirement = fixture.canonicalInputs.requirements[0];
    assert.ok(requirement);
    fixture.canonicalInputs.implementationPlan.id = requirement.id;

    assert.equal(ReviewRequestV1Schema.safeParse(fixture).success, false);
  });

  it("exports a strict draft 2020-12 JSON Schema", () => {
    assert.equal(
      REVIEW_REQUEST_V1_JSON_SCHEMA.$id,
      "urn:independent-reviewer:schema:review-request:v1",
    );
    assert.equal(
      REVIEW_REQUEST_V1_JSON_SCHEMA.$schema,
      "https://json-schema.org/draft/2020-12/schema",
    );
    assert.equal(REVIEW_REQUEST_V1_JSON_SCHEMA.additionalProperties, false);
    const schemaVersion = REVIEW_REQUEST_V1_JSON_SCHEMA.properties?.schemaVersion;
    assert.ok(schemaVersion && typeof schemaVersion === "object");
    assert.equal((schemaVersion as Record<string, unknown>).const, 1);
  });

  it("describes caller input without requiring fields that receive defaults", () => {
    const repository = REVIEW_REQUEST_V1_JSON_SCHEMA.properties?.repository;
    const canonicalInputs = REVIEW_REQUEST_V1_JSON_SCHEMA.properties?.canonicalInputs;
    assert.ok(repository && typeof repository === "object");
    assert.ok(canonicalInputs && typeof canonicalInputs === "object");

    const repositoryRequired = (repository as Record<string, unknown>).required;
    const canonicalInputsRequired = (canonicalInputs as Record<string, unknown>).required;
    assert.ok(Array.isArray(repositoryRequired));
    assert.ok(Array.isArray(canonicalInputsRequired));
    assert.equal(repositoryRequired.includes("workingTree"), false);
    assert.equal(canonicalInputsRequired.includes("projectGuidance"), false);
  });

  it("marks exported JSON Schemas as structural rather than semantic validators", () => {
    for (const schema of [
      REVIEW_REQUEST_V1_JSON_SCHEMA,
      SNAPSHOT_MANIFEST_V1_JSON_SCHEMA,
      NEUTRAL_REVIEW_BRIEF_V1_JSON_SCHEMA,
    ]) {
      const comment = (schema as Record<string, unknown>).$comment;
      assert.equal(typeof comment, "string");
      assert.match(String(comment), /structural constraints only/i);
      assert.match(String(comment), /semantic validation/i);
    }
  });

  it("matches the committed JSON Schema artifact", async () => {
    const contents = await readFile(resolve("schemas", "review-request-v1.schema.json"), "utf8");

    assert.deepEqual(JSON.parse(contents), REVIEW_REQUEST_V1_JSON_SCHEMA);
  });
});
