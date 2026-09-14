import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SnapshotPathV1Schema } from "../../src/contracts/snapshot-manifest.js";
import { GuidanceCaptureError } from "../../src/guidance/base-markdown-source.js";
import { scanClaudeImportOccurrencesV1 } from "../../src/guidance/claude-imports.js";
import { compileGuidancePatternsV1 } from "../../src/guidance/conditional-patterns.js";
import { scanCopilotImportOccurrencesV1 } from "../../src/guidance/copilot-imports.js";
import { parseCursorFrontmatterV1 } from "../../src/guidance/cursor-frontmatter.js";
import { scanCursorImportOccurrencesV1 } from "../../src/guidance/cursor-imports.js";
import { parseGuidanceFrontmatterV1 } from "../../src/guidance/frontmatter.js";
import { scanGeminiImportOccurrencesV1 } from "../../src/guidance/gemini-imports.js";
import { parseGeminiSettingsV1 } from "../../src/guidance/gemini-settings.js";
import { parseKiroSteeringFrontmatterV1 } from "../../src/guidance/kiro-frontmatter.js";
import { scanKiroFileReferenceOccurrencesV1 } from "../../src/guidance/kiro-imports.js";

function expectCaptureError(action: () => unknown, code: GuidanceCaptureError["code"]): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof GuidanceCaptureError && error.code === code,
  );
}

function jsonDocumentAtBytes(byteLength: number): string {
  const prefix = '{"padding":"';
  const suffix = '"}';
  const fixedBytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  return `${prefix}${"x".repeat(byteLength - fixedBytes)}${suffix}`;
}

function yamlFrontmatterAtBytes(byteLength: number): string {
  const prefix = "---\npadding: ";
  const suffix = "\n---";
  const fixedBytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  return `${prefix}${"x".repeat(byteLength - fixedBytes)}${suffix}`;
}

function utf8TextAtBytes(byteLength: number): string {
  return `${"é".repeat(Math.floor(byteLength / 2))}${byteLength % 2 === 0 ? "" : "x"}`;
}

function nestedYaml(mappingLevels: number, sequenceLeaf: boolean): string {
  const mappings = Array.from(
    { length: mappingLevels },
    (_, index) => `${"  ".repeat(index)}k${index}:`,
  ).join("\n");
  const leaf = sequenceLeaf ? " [value]" : " value";
  return `---\n${mappings}${leaf}\n---\n`;
}

function wideObjectJson(properties: number): string {
  return `{${Array.from({ length: properties }, (_, index) => `"k${index}":0`).join(",")}}`;
}

function wideMappingFrontmatter(properties: number): string {
  return `---\n${Array.from({ length: properties }, (_, index) => `k${index}: v`).join("\n")}\n---\n`;
}

describe("Slice 3 parser-cap boundaries", () => {
  it("accepts normalized repository paths through 4,096 UTF-16 units", () => {
    assert.equal(SnapshotPathV1Schema.parse("x".repeat(4_095)).length, 4_095);
    assert.equal(SnapshotPathV1Schema.parse("x".repeat(4_096)).length, 4_096);
    assert.equal(SnapshotPathV1Schema.safeParse("x".repeat(4_097)).success, false);
  });

  for (const scanner of [
    { family: "Claude", scan: scanClaudeImportOccurrencesV1, wrap: (value: string) => `@${value}` },
    { family: "Gemini", scan: scanGeminiImportOccurrencesV1, wrap: (value: string) => `@${value}` },
    {
      family: "Kiro",
      scan: scanKiroFileReferenceOccurrencesV1,
      wrap: (value: string) => `#[[file:${value}]]`,
    },
    {
      family: "Copilot",
      scan: scanCopilotImportOccurrencesV1,
      wrap: (value: string) => `@${value}`,
    },
    { family: "Cursor", scan: scanCursorImportOccurrencesV1, wrap: (value: string) => `@${value}` },
  ] as const) {
    it(`${scanner.family} accepts import specifiers through 1,024 UTF-16 units`, () => {
      assert.equal(
        scanner.scan("rules.md", scanner.wrap("x".repeat(1_023)))[0]?.requestedSpecifier.length,
        1_023,
      );
      assert.equal(
        scanner.scan("rules.md", scanner.wrap("x".repeat(1_024)))[0]?.requestedSpecifier.length,
        1_024,
      );
      expectCaptureError(
        () => scanner.scan("rules.md", scanner.wrap("x".repeat(1_025))),
        "GUIDANCE_IMPORT_UNSUPPORTED",
      );
    });
  }

  it("accepts 8 Gemini context basenames of up to 128 UTF-8 bytes", () => {
    const settings = (names: string[]) => JSON.stringify({ context: { fileName: names } });
    assert.equal(
      parseGeminiSettingsV1(
        ".gemini/settings.json",
        settings(Array.from({ length: 7 }, (_, index) => `GEMINI-${index}.md`)),
      ).contextFileNames.length,
      7,
    );
    assert.equal(
      parseGeminiSettingsV1(
        ".gemini/settings.json",
        settings(Array.from({ length: 8 }, (_, index) => `GEMINI-${index}.md`)),
      ).contextFileNames.length,
      8,
    );
    expectCaptureError(
      () =>
        parseGeminiSettingsV1(
          ".gemini/settings.json",
          settings(Array.from({ length: 9 }, (_, index) => `GEMINI-${index}.md`)),
        ),
      "GUIDANCE_UNSUPPORTED_KIND",
    );

    for (const byteLength of [127, 128]) {
      const [name] = parseGeminiSettingsV1(
        ".gemini/settings.json",
        settings([utf8TextAtBytes(byteLength)]),
      ).contextFileNames;
      assert.equal(Buffer.byteLength(name ?? ""), byteLength);
    }
    expectCaptureError(
      () => parseGeminiSettingsV1(".gemini/settings.json", settings([utf8TextAtBytes(129)])),
      "GUIDANCE_UNSUPPORTED_KIND",
    );
  });

  it("accepts Gemini settings through 64 KiB, depth 16, and 256 JSON nodes", () => {
    for (const byteLength of [65_535, 65_536]) {
      const content = jsonDocumentAtBytes(byteLength);
      assert.equal(Buffer.byteLength(content), byteLength);
      assert.doesNotThrow(() => parseGeminiSettingsV1(".gemini/settings.json", content));
    }
    expectCaptureError(
      () => parseGeminiSettingsV1(".gemini/settings.json", jsonDocumentAtBytes(65_537)),
      "GUIDANCE_UNSUPPORTED_KIND",
    );

    const nestedJson = (arrayLevels: number) =>
      `{"padding":${"[".repeat(arrayLevels)}0${"]".repeat(arrayLevels)}}`;
    assert.doesNotThrow(() => parseGeminiSettingsV1(".gemini/settings.json", nestedJson(12)));
    assert.doesNotThrow(() => parseGeminiSettingsV1(".gemini/settings.json", nestedJson(13)));
    expectCaptureError(
      () => parseGeminiSettingsV1(".gemini/settings.json", nestedJson(14)),
      "GUIDANCE_UNSUPPORTED_KIND",
    );

    assert.equal(
      parseGeminiSettingsV1(".gemini/settings.json", wideObjectJson(84)).unknownSettingOffsets
        .length,
      84,
    );
    assert.equal(
      parseGeminiSettingsV1(".gemini/settings.json", wideObjectJson(85)).unknownSettingOffsets
        .length,
      85,
    );
    expectCaptureError(
      () => parseGeminiSettingsV1(".gemini/settings.json", wideObjectJson(86)),
      "GUIDANCE_UNSUPPORTED_KIND",
    );
  });

  for (const parser of [
    {
      family: "Claude",
      path: ".claude/rules/cap.md",
      parse: parseGuidanceFrontmatterV1,
    },
    {
      family: "Kiro",
      path: ".kiro/steering/cap.md",
      parse: parseKiroSteeringFrontmatterV1,
    },
    { family: "Cursor", path: ".cursor/rules/cap.mdc", parse: parseCursorFrontmatterV1 },
  ] as const) {
    it(`${parser.family} accepts frontmatter through 16 KiB, depth 16, and 256 YAML nodes`, () => {
      for (const byteLength of [16_383, 16_384]) {
        const content = yamlFrontmatterAtBytes(byteLength);
        assert.equal(Buffer.byteLength(content), byteLength);
        assert.doesNotThrow(() => parser.parse(parser.path, content));
      }
      expectCaptureError(
        () => parser.parse(parser.path, yamlFrontmatterAtBytes(16_385)),
        "GUIDANCE_INVALID_FRONTMATTER",
      );

      assert.doesNotThrow(() => parser.parse(parser.path, nestedYaml(7, false)));
      assert.doesNotThrow(() => parser.parse(parser.path, nestedYaml(7, true)));
      expectCaptureError(
        () => parser.parse(parser.path, nestedYaml(8, false)),
        "GUIDANCE_INVALID_FRONTMATTER",
      );

      assert.doesNotThrow(() => parser.parse(parser.path, wideMappingFrontmatter(84)));
      assert.doesNotThrow(() => parser.parse(parser.path, wideMappingFrontmatter(85)));
      expectCaptureError(
        () => parser.parse(parser.path, wideMappingFrontmatter(86)),
        "GUIDANCE_INVALID_FRONTMATTER",
      );
    });
  }

  it("accepts 64 conditional patterns of up to 512 UTF-8 bytes", () => {
    for (const count of [63, 64]) {
      assert.doesNotThrow(() =>
        compileGuidancePatternsV1(
          "rules.md",
          Array.from({ length: count }, (_, index) => `path-${index}/**`),
        ),
      );
    }
    expectCaptureError(
      () =>
        compileGuidancePatternsV1(
          "rules.md",
          Array.from({ length: 65 }, (_, index) => `path-${index}/**`),
        ),
      "GUIDANCE_INVALID_PATTERN",
    );

    for (const byteLength of [511, 512]) {
      assert.doesNotThrow(() =>
        compileGuidancePatternsV1("rules.md", [utf8TextAtBytes(byteLength)]),
      );
    }
    expectCaptureError(
      () => compileGuidancePatternsV1("rules.md", [utf8TextAtBytes(513)]),
      "GUIDANCE_INVALID_PATTERN",
    );
  });

  it("accepts 8 brace groups and expansion product 256", () => {
    const product255 = "{a,b,c}{d,e,f,g,h}{i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y}";
    const product256 = "{a,b}".repeat(8);
    const product270 = "{a,b}{c,d,e}{f,g,h}{i,j,k}{l,m,n,o,p}";
    assert.doesNotThrow(() => compileGuidancePatternsV1("rules.md", [`${"{a,b}".repeat(7)}/**`]));
    assert.doesNotThrow(() => compileGuidancePatternsV1("rules.md", [`${product256}/**`]));
    expectCaptureError(
      () => compileGuidancePatternsV1("rules.md", [`${"{a,b}".repeat(9)}/**`]),
      "GUIDANCE_INVALID_PATTERN",
    );

    assert.doesNotThrow(() => compileGuidancePatternsV1("rules.md", [`path/${product255}/**`]));
    assert.doesNotThrow(() => compileGuidancePatternsV1("rules.md", [`path/${product256}/**`]));
    expectCaptureError(
      () => compileGuidancePatternsV1("rules.md", [`path/${product270}/**`]),
      "GUIDANCE_INVALID_PATTERN",
    );
  });

  it("accepts 1,024 compiled matcher alternatives", () => {
    const product255 = "{a,b,c}{d,e,f,g,h}{i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y}";
    const product256 = "{a,b}".repeat(8);
    const expandedPattern = (index: number, product: string) => `path-${index}/${product}/**`;
    assert.doesNotThrow(() =>
      compileGuidancePatternsV1("rules.md", [
        expandedPattern(0, product256),
        expandedPattern(1, product256),
        expandedPattern(2, product256),
        expandedPattern(3, product255),
      ]),
    );
    assert.doesNotThrow(() =>
      compileGuidancePatternsV1(
        "rules.md",
        Array.from({ length: 4 }, (_, index) => expandedPattern(index, product256)),
      ),
    );
    expectCaptureError(
      () =>
        compileGuidancePatternsV1("rules.md", [
          ...Array.from({ length: 4 }, (_, index) => expandedPattern(index, product256)),
          "one-more/**",
        ]),
      "GUIDANCE_INVALID_PATTERN",
    );
  });
});
