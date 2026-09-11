import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  finalizeReviewContextMapV1,
  REVIEW_CONTEXT_MAP_V1_JSON_SCHEMA,
  ReviewContextMapV1Schema,
  verifyReviewContextMapIdentityV1,
} from "../../src/index.js";

const SNAPSHOT_DIGEST = {
  algorithm: "SHA256" as const,
  value: "a".repeat(64),
};

function contextMapDraft() {
  return {
    schemaVersion: 1 as const,
    contextMapId: "context_fixture",
    snapshotDigest: SNAPSHOT_DIGEST,
    producers: [
      {
        producerId: "producer_tree_sitter",
        producerVersion: "0.25.0",
        status: "COMPLETE" as const,
        diagnostics: [],
      },
    ],
    regions: [
      {
        regionId: "region_changed_head",
        origin: "CHANGED_PATH" as const,
        path: "src/service.py",
        side: "HEAD" as const,
        fileDigest: { algorithm: "SHA256" as const, value: "b".repeat(64) },
        byteLength: 120,
        role: "SOURCE" as const,
        languageId: "python",
        kind: "FILE" as const,
        producerId: "producer_tree_sitter",
      },
      {
        regionId: "region_support_head",
        origin: "SUPPORTING_CONTEXT" as const,
        path: "src/contracts.py",
        side: "HEAD" as const,
        fileDigest: { algorithm: "SHA256" as const, value: "c".repeat(64) },
        byteLength: 80,
        role: "SOURCE" as const,
        languageId: "python",
        kind: "DECLARATION" as const,
        range: {
          coordinateUnit: "UTF16_CODE_UNIT" as const,
          startOffset: 0,
          endOffsetExclusive: 78,
          contentByteLength: 80,
          startLine: 1,
          startColumn: 0,
          endLine: 4,
          endColumn: 0,
        },
        producerId: "producer_tree_sitter",
        displayName: "Request",
      },
    ],
    relations: [
      {
        relationId: "relation_service_contract",
        sourceRegionId: "region_changed_head",
        targetRegionId: "region_support_head",
        kind: "DEPENDS_ON" as const,
        certainty: "SYNTACTIC" as const,
        producerId: "producer_tree_sitter",
        producerKind: "PYTHON_IMPORT",
      },
    ],
  };
}

describe("ReviewContextMapV1", () => {
  it("finalizes a language-neutral, digest-bound context map", () => {
    const map = finalizeReviewContextMapV1(contextMapDraft());

    assert.equal(map.contextMapDigest.algorithm, "SHA256");
    assert.equal(map.regions[0]?.languageId, "python");
    assert.equal(verifyReviewContextMapIdentityV1(map), true);
  });

  it("keeps identity stable across producer, region, and relation order", () => {
    const first = contextMapDraft();
    const second = structuredClone(first);
    second.regions.reverse();

    assert.deepEqual(
      finalizeReviewContextMapV1(first).contextMapDigest,
      finalizeReviewContextMapV1(second).contextMapDigest,
    );
  });

  it("rejects dangling relations and unknown producers", () => {
    const dangling = contextMapDraft();
    const danglingRelation = dangling.relations[0];
    assert.ok(danglingRelation);
    danglingRelation.targetRegionId = "region_missing";
    assert.equal(
      ReviewContextMapV1Schema.safeParse({
        ...dangling,
        contextMapDigest: SNAPSHOT_DIGEST,
      }).success,
      false,
    );

    const unknownProducer = contextMapDraft();
    const unknownProducerRegion = unknownProducer.regions[0];
    assert.ok(unknownProducerRegion);
    unknownProducerRegion.producerId = "producer_missing";
    assert.equal(
      ReviewContextMapV1Schema.safeParse({
        ...unknownProducer,
        contextMapDigest: SNAPSHOT_DIGEST,
      }).success,
      false,
    );
  });

  it("detects content and analyzer drift after finalization", () => {
    const map = finalizeReviewContextMapV1(contextMapDraft());
    const changedRegion = map.regions[0];
    assert.ok(changedRegion);
    changedRegion.byteLength += 1;
    assert.equal(verifyReviewContextMapIdentityV1(map), false);

    const analyzerDrift = finalizeReviewContextMapV1(contextMapDraft());
    const producer = analyzerDrift.producers[0];
    assert.ok(producer);
    producer.producerVersion = "0.26.0";
    assert.equal(verifyReviewContextMapIdentityV1(analyzerDrift), false);
  });

  it("matches the committed JSON Schema artifact", async () => {
    const schema = JSON.parse(
      await readFile(resolve("schemas", "review-context-map-v1.schema.json"), "utf8"),
    );
    assert.deepEqual(schema, REVIEW_CONTEXT_MAP_V1_JSON_SCHEMA);
  });
});
