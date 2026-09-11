import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import type { ReviewBrief } from "../../src/contracts/index.js";
import {
  buildFallbackReviewContextMapV1,
  computeCanonicalInputDigestV1,
  computeInitialEvidenceContentDigestV1,
  finalizeReviewBrief,
  finalizeReviewContextMapV1,
  finalizeSnapshotManifestV1,
  planReviewUnitsV1,
  REVIEW_UNIT_PLAN_V1_JSON_SCHEMA,
  verifyReviewUnitPlanIdentityV1,
} from "../../src/index.js";

const digest = (character: string) => ({
  algorithm: "SHA256" as const,
  value: character.repeat(64),
});

function briefFixture(
  options: { additionalEvidence?: boolean; transmitSupportingContext?: boolean } = {},
): ReviewBrief {
  const canonicalInputs = {
    requirements: [
      {
        id: "input_requirement" as const,
        kind: "REQUIREMENTS" as const,
        title: "Correctness",
        content: "Changed code must preserve its contract.",
        provenance: { type: "INLINE" as const, label: "fixture" },
      },
    ],
    implementationPlan: {
      id: "input_plan" as const,
      kind: "IMPLEMENTATION_PLAN" as const,
      title: "Plan",
      content: "Change service safely.",
      provenance: { type: "INLINE" as const, label: "fixture" },
    },
    projectGuidance: [],
  };
  const requirement = canonicalInputs.requirements[0];
  assert.ok(requirement);
  const snapshotManifest = finalizeSnapshotManifestV1({
    schemaVersion: 1,
    snapshotId: "snapshot_planner_fixture",
    flowId: "flow_planner_fixture",
    reviewInstance: { number: 1, maximum: 1 },
    source: {
      repositoryId: "repo_planner_fixture",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      branch: "codex/planner-fixture",
    },
    workingTree: {
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      includedUntrackedPaths: [],
    },
    paths: [
      {
        changeType: "MODIFIED",
        path: "src/service.py",
        role: "SOURCE",
        before: {
          kind: "TEXT",
          digest: digest("3"),
          byteLength: 90,
          gitMode: "100644",
          isGenerated: false,
        },
        after: {
          kind: "TEXT",
          digest: digest("4"),
          byteLength: 120,
          gitMode: "100644",
          isGenerated: false,
        },
      },
    ],
    exclusions: [],
    omissions: [],
    referencedSources: [
      {
        path: "src/contracts.py",
        content: {
          kind: "TEXT",
          digest: digest("5"),
          byteLength: 80,
          gitMode: "100644",
          isGenerated: false,
        },
        importedBy: ["src/service.py"],
      },
    ],
    canonicalInputs: [
      {
        id: requirement.id,
        kind: requirement.kind,
        digest: computeCanonicalInputDigestV1(requirement),
        provenance: requirement.provenance,
      },
      {
        id: canonicalInputs.implementationPlan.id,
        kind: canonicalInputs.implementationPlan.kind,
        digest: computeCanonicalInputDigestV1(canonicalInputs.implementationPlan),
        provenance: canonicalInputs.implementationPlan.provenance,
      },
    ],
    policies: { capture: "capture-v2", transmission: "transmission-v1" },
    raceCheck: {
      attempts: 1,
      status: "STABLE",
      beforeStateDigest: digest("6"),
      afterStateDigest: digest("6"),
    },
  });
  const evidenceContent = "Change: MODIFIED src/service.py\n@@ -1 +1 @@\n-old\n+new";
  const secondEvidenceContent = "Change: MODIFIED src/service.py\n@@ -10 +10 @@\n-before\n+after";
  return finalizeReviewBrief({
    schemaVersion: 1,
    briefId: "brief_planner_fixture",
    objective: { text: "Review changed code.", canonicalInputIds: ["input_requirement"] },
    successCriteria: [
      { text: "Changed code is correct.", canonicalInputIds: ["input_requirement"] },
    ],
    canonicalInputs,
    snapshotManifest,
    initialEvidence: [
      {
        type: "DIFF_HUNK",
        evidenceId: "evidence_service_change",
        path: "src/service.py",
        hunkId: "hunk_service_change",
        content: evidenceContent,
        digest: computeInitialEvidenceContentDigestV1(evidenceContent),
      },
      ...(options.additionalEvidence
        ? [
            {
              type: "DIFF_HUNK" as const,
              evidenceId: "evidence_service_second_change",
              path: "src/service.py",
              hunkId: "hunk_service_second_change",
              content: secondEvidenceContent,
              digest: computeInitialEvidenceContentDigestV1(secondEvidenceContent),
            },
          ]
        : []),
    ],
    referencedSources:
      options.transmitSupportingContext === false
        ? []
        : [
            {
              path: "src/contracts.py",
              importedBy: ["src/service.py"],
              content: "1 | contract",
            },
          ],
    coverageConstraints: [],
  });
}

function contextMapFixture() {
  return finalizeReviewContextMapV1({
    schemaVersion: 1,
    contextMapId: "context_planner_fixture",
    snapshotDigest: briefFixture().snapshotManifest.snapshotDigest,
    producers: [
      {
        producerId: "producer_fixture",
        producerVersion: "1",
        status: "COMPLETE",
        diagnostics: [],
      },
    ],
    regions: [
      {
        regionId: "region_service_head",
        origin: "CHANGED_PATH",
        path: "src/service.py",
        side: "HEAD",
        fileDigest: digest("4"),
        byteLength: 120,
        role: "SOURCE",
        languageId: "python",
        kind: "FILE",
        producerId: "producer_fixture",
      },
      {
        regionId: "region_contract_head",
        origin: "SUPPORTING_CONTEXT",
        path: "src/contracts.py",
        side: "HEAD",
        fileDigest: digest("5"),
        byteLength: 80,
        role: "SOURCE",
        languageId: "python",
        kind: "FILE",
        producerId: "producer_fixture",
      },
      {
        regionId: "region_service_function",
        origin: "CHANGED_PATH",
        path: "src/service.py",
        side: "HEAD",
        fileDigest: digest("4"),
        byteLength: 120,
        role: "SOURCE",
        languageId: "python",
        kind: "DECLARATION",
        range: {
          coordinateUnit: "UTF16_CODE_UNIT",
          startOffset: 0,
          endOffsetExclusive: 20,
          contentByteLength: 20,
          startLine: 1,
          startColumn: 0,
          endLine: 2,
          endColumn: 0,
        },
        producerId: "producer_fixture",
        displayName: "service",
      },
    ],
    relations: [
      {
        relationId: "relation_service_contract",
        sourceRegionId: "region_service_head",
        targetRegionId: "region_contract_head",
        kind: "DEPENDS_ON",
        certainty: "SYNTACTIC",
        producerId: "producer_fixture",
        producerKind: "PYTHON_IMPORT",
      },
      {
        relationId: "relation_service_contract_alternative",
        sourceRegionId: "region_service_head",
        targetRegionId: "region_contract_head",
        kind: "REFERENCES",
        certainty: "SYNTACTIC",
        producerId: "producer_fixture",
        producerKind: "PYTHON_REFERENCE",
      },
      {
        relationId: "relation_service_encloses_function",
        sourceRegionId: "region_service_head",
        targetRegionId: "region_service_function",
        kind: "ENCLOSES",
        certainty: "SYNTACTIC",
        producerId: "producer_fixture",
      },
    ],
  });
}

describe("planReviewUnitsV1", () => {
  it("builds universal file regions and captured dependency relations without a parser", () => {
    const brief = briefFixture();
    const map = buildFallbackReviewContextMapV1(brief.snapshotManifest);

    assert.deepEqual(
      map.regions.map((region) => [region.origin, region.path, region.side]),
      [
        ["SUPPORTING_CONTEXT", "src/contracts.py", "HEAD"],
        ["CHANGED_PATH", "src/service.py", "BASE"],
        ["CHANGED_PATH", "src/service.py", "HEAD"],
      ],
    );
    assert.equal(map.relations[0]?.kind, "DEPENDS_ON");
    assert.equal(map.relations[0]?.certainty, "SYNTACTIC");
    assert.equal(
      verifyReviewUnitPlanIdentityV1(
        planReviewUnitsV1(brief, map, {
          policyVersion: "review-unit-planner-v1",
          maxSupportingBytesPerUnit: 1_024,
        }),
      ),
      true,
    );
  });

  it("creates one deterministic unit per changed evidence target with direct support", () => {
    const brief = briefFixture({ additionalEvidence: true });
    const map = contextMapFixture();
    const plan = planReviewUnitsV1(brief, map, {
      policyVersion: "review-unit-planner-v1",
      maxSupportingBytesPerUnit: 1_024,
    });

    assert.equal(plan.units.length, 1);
    assert.deepEqual(plan.units[0]?.targetPaths, ["src/service.py"]);
    assert.deepEqual(plan.units[0]?.primaryEvidenceIds, [
      "evidence_service_change",
      "evidence_service_second_change",
    ]);
    assert.deepEqual(plan.units[0]?.primaryRegionIds, ["region_service_function"]);
    assert.deepEqual(plan.units[0]?.supportingRegionIds, ["region_contract_head"]);
    assert.deepEqual(plan.units[0]?.relationIds, ["relation_service_contract"]);
    assert.equal(verifyReviewUnitPlanIdentityV1(plan), true);
  });

  it("records budget overflow instead of silently dropping related context", () => {
    const plan = planReviewUnitsV1(briefFixture(), contextMapFixture(), {
      policyVersion: "review-unit-planner-v1",
      maxSupportingBytesPerUnit: 40,
    });

    assert.deepEqual(plan.units[0]?.supportingRegionIds, []);
    assert.match(plan.units[0]?.limitations[0] ?? "", /80 bytes.*40-byte/i);
  });

  it("does not attach supporting regions absent from transmitted evidence", () => {
    const plan = planReviewUnitsV1(
      briefFixture({ transmitSupportingContext: false }),
      contextMapFixture(),
      {
        policyVersion: "review-unit-planner-v1",
        maxSupportingBytesPerUnit: 1_024,
      },
    );

    assert.deepEqual(plan.units[0]?.supportingRegionIds, []);
    assert.deepEqual(plan.units[0]?.relationIds, []);
    assert.match(plan.units[0]?.limitations[0] ?? "", /not transmitted/i);
  });

  it("is independent of context-map input order", () => {
    const brief = briefFixture();
    const firstMap = contextMapFixture();
    const reversedDraft = {
      ...firstMap,
      contextMapId: "context_reordered_fixture",
      regions: [...firstMap.regions].reverse(),
      relations: [...firstMap.relations].reverse(),
    };
    const { contextMapDigest: _digest, ...draft } = reversedDraft;
    const secondMap = finalizeReviewContextMapV1(draft);

    const options = {
      policyVersion: "review-unit-planner-v1",
      maxSupportingBytesPerUnit: 1_024,
    };
    assert.deepEqual(
      planReviewUnitsV1(brief, firstMap, options).planDigest,
      planReviewUnitsV1(brief, secondMap, options).planDigest,
    );
  });

  it("rejects a context map from another snapshot", () => {
    const original = contextMapFixture();
    const { contextMapDigest: _digest, ...draft } = original;
    const map = finalizeReviewContextMapV1({ ...draft, snapshotDigest: digest("9") });

    assert.throws(
      () =>
        planReviewUnitsV1(briefFixture(), map, {
          policyVersion: "review-unit-planner-v1",
          maxSupportingBytesPerUnit: 1_024,
        }),
      /snapshot/i,
    );
  });

  it("rejects a context map changed after finalization", () => {
    const map = contextMapFixture();
    const region = map.regions[1];
    assert.ok(region);
    region.byteLength += 1;

    assert.throws(
      () =>
        planReviewUnitsV1(briefFixture(), map, {
          policyVersion: "review-unit-planner-v1",
          maxSupportingBytesPerUnit: 1_024,
        }),
      /identity/i,
    );
  });

  it("rejects a brief changed after finalization", () => {
    const brief = briefFixture();
    brief.objective.text = "Changed after finalization.";

    assert.throws(
      () =>
        planReviewUnitsV1(brief, contextMapFixture(), {
          policyVersion: "review-unit-planner-v1",
          maxSupportingBytesPerUnit: 1_024,
        }),
      /brief identity/i,
    );
  });

  it("matches the committed JSON Schema artifact", async () => {
    const schema = JSON.parse(
      await readFile(resolve("schemas", "review-unit-plan-v1.schema.json"), "utf8"),
    );
    assert.deepEqual(schema, REVIEW_UNIT_PLAN_V1_JSON_SCHEMA);
  });
});
