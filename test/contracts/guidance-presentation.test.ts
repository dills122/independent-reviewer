import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CanonicalGuidancePresentationSchema,
  CanonicalGuidancePresentationV1Schema,
  canonicalizeJson,
  type GuidancePromptPresentationV2,
  GuidancePromptPresentationV2Schema,
} from "../../src/index.js";

const precedence =
  "Repository-peer sources have equal semantic priority. Reviewer-specific sources take precedence when guidance conflicts.";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected fixture value.");
  return value;
}

function presentationV2(): GuidancePromptPresentationV2 {
  return {
    schemaVersion: 2 as const,
    trustBoundary: "UNTRUSTED_REPOSITORY_GUIDANCE" as const,
    precedence,
    sources: [
      {
        sourceId: "guidance_source_rules",
        path: ".independent-reviewer/rules.md",
        contentDigest: { algorithm: "SHA256" as const, value: "a".repeat(64) },
        semanticTier: "REVIEWER_SPECIFIC" as const,
        origin: "DIRECT" as const,
        directRecognitionGroups: [
          {
            familyId: "INDEPENDENT_REVIEWER" as const,
            sourceKind: "REVIEWER_RULES" as const,
            nativeOrder: 0,
            discoveredPath: ".independent-reviewer/rules.md",
            applicableTargetIndexes: [0, 1],
          },
        ],
        inboundImportGroups: [],
        applicableTargets: [
          {
            targetId: "guidance_target_first",
            path: "first.ts",
            side: "HEAD" as const,
            role: "PRIMARY" as const,
          },
          {
            targetId: "guidance_target_second",
            path: "second.ts",
            side: "HEAD" as const,
            role: "PRIMARY" as const,
          },
        ],
        sourceRange: {
          coordinateUnit: "UTF16_CODE_UNIT" as const,
          startOffset: 0 as const,
          endOffsetExclusive: 7,
        },
        content: "# Rules",
      },
    ],
  };
}

describe("CanonicalGuidancePresentationV1Schema", () => {
  it("rejects duplicate properties before canonical presentation validation", () => {
    const presentation =
      `{"precedence":${JSON.stringify(precedence)},` +
      `"schemaVersion":1,"schemaVersion":1,"sources":[],` +
      '"trustBoundary":"UNTRUSTED_REPOSITORY_GUIDANCE"}';

    const result = CanonicalGuidancePresentationV1Schema.safeParse(presentation);

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error.issues[0]?.message ?? "", /JSON_DUPLICATE_PROPERTY/);
    }
  });

  it("remains accepted through the versioned canonical presentation union", () => {
    const presentation = canonicalizeJson({
      precedence,
      schemaVersion: 1,
      sources: [],
      trustBoundary: "UNTRUSTED_REPOSITORY_GUIDANCE",
    });

    assert.equal(CanonicalGuidancePresentationSchema.safeParse(presentation).success, true);
  });
});

describe("GuidancePromptPresentationV2Schema", () => {
  it("accepts compact indexed provenance", () => {
    assert.equal(GuidancePromptPresentationV2Schema.safeParse(presentationV2()).success, true);
  });

  it("rejects ambiguous or incomplete direct target mappings", () => {
    const cases = [
      (presentation: ReturnType<typeof presentationV2>) => {
        required(required(presentation.sources[0]).applicableTargets[1]).targetId =
          "guidance_target_first";
      },
      (presentation: ReturnType<typeof presentationV2>) => {
        required(
          required(presentation.sources[0]).directRecognitionGroups[0],
        ).applicableTargetIndexes = [0, 0];
      },
      (presentation: ReturnType<typeof presentationV2>) => {
        required(
          required(presentation.sources[0]).directRecognitionGroups[0],
        ).applicableTargetIndexes = [0, 2];
      },
      (presentation: ReturnType<typeof presentationV2>) => {
        required(
          required(presentation.sources[0]).directRecognitionGroups[0],
        ).applicableTargetIndexes = [0];
      },
      (presentation: ReturnType<typeof presentationV2>) => {
        const groups = required(presentation.sources[0]).directRecognitionGroups;
        groups.push(structuredClone(required(groups[0])));
      },
      (presentation: ReturnType<typeof presentationV2>) => {
        required(required(presentation.sources[0]).directRecognitionGroups[0]).familyId = "CODEX";
      },
      (presentation: ReturnType<typeof presentationV2>) => {
        required(presentation.sources[0]).semanticTier = "REPOSITORY_PEER";
      },
    ];

    for (const mutate of cases) {
      const presentation = presentationV2();
      mutate(presentation);
      assert.equal(GuidancePromptPresentationV2Schema.safeParse(presentation).success, false);
    }
  });

  it("rejects invalid imported provenance and globally reused identities", () => {
    const presentation = presentationV2();
    const importer = required(presentation.sources[0]);
    importer.semanticTier = "REPOSITORY_PEER";
    const importerGroup = required(importer.directRecognitionGroups[0]);
    importerGroup.familyId = "COPILOT";
    importerGroup.sourceKind = "COPILOT_REPOSITORY";
    const imported = {
      sourceId: "guidance_source_imported",
      path: "imported.md",
      contentDigest: { algorithm: "SHA256" as const, value: "b".repeat(64) },
      semanticTier: "REPOSITORY_PEER" as const,
      origin: "IMPORT_ONLY" as const,
      directRecognitionGroups: [],
      inboundImportGroups: [
        {
          occurrenceId: "guidance_occurrence_first",
          familyId: "COPILOT" as const,
          syntaxKind: "COPILOT_AT_PATH" as const,
          importerSourceId: importer.sourceId,
          requestedSpecifier: "imported.md",
          startUtf16: 1,
          endUtf16: 2,
          edges: [
            { edgeId: "guidance_edge_first", applicableTargetIndex: 0 },
            { edgeId: "guidance_edge_second", applicableTargetIndex: 1 },
          ],
        },
      ],
      applicableTargets: structuredClone(importer.applicableTargets),
      sourceRange: {
        coordinateUnit: "UTF16_CODE_UNIT" as const,
        startOffset: 0 as const,
        endOffsetExclusive: 10,
      },
      content: "# Imported",
    };
    presentation.sources.push(imported);
    assert.equal(GuidancePromptPresentationV2Schema.safeParse(presentation).success, true);

    for (const mutate of [
      (value: typeof presentation) => {
        required(required(value.sources[1]).inboundImportGroups[0]).importerSourceId =
          "guidance_source_missing";
      },
      (value: typeof presentation) => {
        required(required(value.sources[1]).inboundImportGroups[0]).endUtf16 = 1;
      },
      (value: typeof presentation) => {
        required(required(value.sources[1]).inboundImportGroups[0]).familyId = "KIRO";
      },
      (value: typeof presentation) => {
        const direct = required(required(value.sources[0]).directRecognitionGroups[0]);
        direct.familyId = "CODEX";
        direct.sourceKind = "CODEX_AGENTS";
      },
      (value: typeof presentation) => {
        required(required(value.sources[1]).applicableTargets[0]).path = "conflicting.ts";
      },
      (value: typeof presentation) => {
        const importedSource = required(value.sources[1]);
        importedSource.applicableTargets.splice(1, 1);
        required(importedSource.inboundImportGroups[0]).edges.splice(1, 1);
      },
      (value: typeof presentation) => {
        const group = required(required(value.sources[1]).inboundImportGroups[0]);
        required(group.edges[0]).applicableTargetIndex = 1;
      },
      (value: typeof presentation) => {
        const duplicate = structuredClone(required(value.sources[1]));
        duplicate.sourceId = "guidance_source_imported_again";
        duplicate.path = "imported-again.md";
        duplicate.contentDigest.value = "c".repeat(64);
        value.sources.push(duplicate);
      },
    ]) {
      const invalid = structuredClone(presentation);
      mutate(invalid);
      assert.equal(GuidancePromptPresentationV2Schema.safeParse(invalid).success, false);
    }
  });
});
