import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTreeSitterContextAnalyzerV1, sha256Utf8 } from "../../src/index.js";

describe("TreeSitterContextAnalyzerV1", () => {
  it("extracts declaration regions for JavaScript, TypeScript, Python, Go, and Java", async () => {
    const analyzer = await createTreeSitterContextAnalyzerV1();
    try {
      const fixtures = [
        ["src/service.js", "export function résumé(value) { return value + 1; }", "résumé"],
        ["src/service.ts", "export function résumé(value: number) { return value + 1; }", "résumé"],
        ["src/service.py", "def résumé(value: int):\n    return value + 1\n", "résumé"],
        [
          "src/service.go",
          "package sample\nfunc Résumé(value int) int { return value + 1 }\n",
          "Résumé",
        ],
        [
          "src/Service.java",
          "class Café { int résumé(int value) { return value + 1; } }",
          "résumé",
        ],
      ] as const;

      for (const [path, source, name] of fixtures) {
        const result = await analyzer.analyze({
          path,
          source,
          fileDigest: sha256Utf8(source),
          side: "HEAD",
          origin: "CHANGED_PATH",
          role: "SOURCE",
        });

        assert.equal(result.producer.status, "COMPLETE");
        assert.equal(
          result.regions.some((region) => region.displayName === name),
          true,
        );
        assert.equal(
          result.regions.every((region) => region.range?.coordinateUnit === "UTF16_CODE_UNIT"),
          true,
        );
      }
    } finally {
      analyzer.dispose();
    }
  });

  it("records UTF-16 offsets, UTF-8 byte lengths, and recoverable syntax uncertainty", async () => {
    const analyzer = await createTreeSitterContextAnalyzerV1();
    try {
      const source =
        "const emoji = '😀';\nexport function café() { return emoji; }\nconst broken = {\n";
      const result = await analyzer.analyze({
        path: "src/unicode.ts",
        source,
        fileDigest: sha256Utf8(source),
        side: "HEAD",
        origin: "CHANGED_PATH",
        role: "SOURCE",
      });
      const declaration = result.regions.find((region) => region.displayName === "café");

      assert.equal(result.producer.status, "PARTIAL");
      assert.match(result.producer.diagnostics[0] ?? "", /syntax error/i);
      assert.ok(declaration?.range);
      assert.equal(declaration.range.coordinateUnit, "UTF16_CODE_UNIT");
      assert.equal(
        declaration.range.contentByteLength,
        Buffer.byteLength(
          source.slice(declaration.range.startOffset, declaration.range.endOffsetExclusive),
          "utf8",
        ),
      );
    } finally {
      analyzer.dispose();
    }
  });

  it("extracts common function-valued and language-specific declaration forms", async () => {
    const analyzer = await createTreeSitterContextAnalyzerV1();
    try {
      const fixtures = [
        [
          "src/handlers.js",
          "export const arrowHandler = (value) => value + 1;\nconst functionHandler = function (value) { return value + 1; };\n",
          ["arrowHandler", "functionHandler"],
        ],
        [
          "src/handlers.ts",
          "export const arrowHandler: (value: number) => number = (value) => value + 1;\nconst functionHandler = function (value: number) { return value + 1; };\nabstract class BaseHandler {}\nenum HandlerMode { Fast }\n",
          ["arrowHandler", "functionHandler", "BaseHandler", "HandlerMode"],
        ],
        [
          "src/handlers.tsx",
          "export const Component = (props: { label: string }) => <span>{props.label}</span>;\n",
          ["Component"],
        ],
        ["src/identifier.go", "package sample\ntype Identifier = string\n", ["Identifier"]],
        [
          "src/Result.java",
          "record Result(int value) { int doubled() { return value * 2; } }\n",
          ["Result", "doubled"],
        ],
      ] as const;

      for (const [path, source, expectedNames] of fixtures) {
        const result = await analyzer.analyze({
          path,
          source,
          fileDigest: sha256Utf8(source),
          side: "HEAD",
          origin: "CHANGED_PATH",
          role: "SOURCE",
        });
        const names = result.regions.map((region) => region.displayName);

        assert.equal(result.producer.status, "COMPLETE");
        assert.match(result.producer.producerVersion, /declarations-v2/);
        assert.match(result.producer.producerVersion, /bounded-v1/);
        for (const expectedName of expectedNames) assert(names.includes(expectedName));
      }
    } finally {
      analyzer.dispose();
    }
  });

  it("bounds dense declaration output and reports retained file-level fallback", async () => {
    const analyzer = await createTreeSitterContextAnalyzerV1();
    try {
      const source = Array.from({ length: 20_000 }, (_, index) => `const f${index}=()=>0;`).join(
        "\n",
      );
      assert.equal(Buffer.byteLength(source, "utf8") < 512 * 1024, true);

      const result = await analyzer.analyze({
        path: "src/dense.js",
        source,
        fileDigest: sha256Utf8(source),
        side: "HEAD",
        origin: "CHANGED_PATH",
        role: "SOURCE",
      });

      assert.equal(result.producer.status, "PARTIAL");
      assert.equal(result.regions.length, 512);
      assert.match(result.producer.diagnostics.join("\n"), /truncated at 512 regions/i);
      assert.match(result.producer.diagnostics.join("\n"), /file-level fallback/i);
    } finally {
      analyzer.dispose();
    }
  });

  it("does not parse oversized source and reports retained file-level fallback", async () => {
    const analyzer = await createTreeSitterContextAnalyzerV1();
    try {
      const source = "// padding\n".repeat(60_000);
      assert.equal(Buffer.byteLength(source, "utf8") > 512 * 1024, true);

      const result = await analyzer.analyze({
        path: "src/oversized.js",
        source,
        fileDigest: sha256Utf8(source),
        side: "HEAD",
        origin: "CHANGED_PATH",
        role: "SOURCE",
      });

      assert.equal(result.producer.status, "PARTIAL");
      assert.deepEqual(result.regions, []);
      assert.match(result.producer.diagnostics.join("\n"), /exceeding the 524288-byte limit/i);
      assert.match(result.producer.diagnostics.join("\n"), /file-level fallback/i);
    } finally {
      analyzer.dispose();
    }
  });

  it("returns an explicit unsupported result without hiding universal fallback", async () => {
    const analyzer = await createTreeSitterContextAnalyzerV1();
    try {
      const result = await analyzer.analyze({
        path: "src/service.rb",
        source: "def call; end\n",
        fileDigest: sha256Utf8("def call; end\n"),
        side: "HEAD",
        origin: "CHANGED_PATH",
        role: "SOURCE",
      });

      assert.equal(result.producer.status, "UNSUPPORTED");
      assert.deepEqual(result.regions, []);
    } finally {
      analyzer.dispose();
    }
  });

  it("rejects source that does not match its frozen digest", async () => {
    const analyzer = await createTreeSitterContextAnalyzerV1();
    try {
      await assert.rejects(
        analyzer.analyze({
          path: "src/service.py",
          source: "def changed(): pass\n",
          fileDigest: sha256Utf8("def original(): pass\n"),
          side: "HEAD",
          origin: "CHANGED_PATH",
          role: "SOURCE",
        }),
        /frozen content digest/i,
      );
    } finally {
      analyzer.dispose();
    }
  });
});
