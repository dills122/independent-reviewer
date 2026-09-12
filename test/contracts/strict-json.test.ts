import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  parseStrictJsonV1,
  readStrictJsonFileV1,
  readStrictJsonLinesFileV1,
  StrictJsonErrorV1,
  type StrictJsonErrorCode,
} from "../../src/contracts/strict-json.js";

function assertStrictJsonError(
  action: () => unknown,
  expected: {
    readonly code: StrictJsonErrorCode;
    readonly line: number;
    readonly column?: number;
    readonly physicalLine?: number;
    readonly absentText?: string;
  },
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof StrictJsonErrorV1);
    assert.equal(error.code, expected.code);
    assert.equal(error.line, expected.line);
    if (expected.column !== undefined) {
      assert.equal(error.column, expected.column);
    }
    assert.equal(error.physicalLine, expected.physicalLine);
    if (expected.absentText !== undefined) {
      assert.equal(error.message.includes(expected.absentText), false);
    }
    return true;
  });
}

describe("parseStrictJsonV1", () => {
  it("accepts strict JSON and separate objects parsed in separate calls", () => {
    assert.deepEqual(parseStrictJsonV1('{"same":1}', { maxBytes: 64, source: "fixture" }), {
      same: 1,
    });
    assert.deepEqual(parseStrictJsonV1('{"same":2}', { maxBytes: 64, source: "fixture" }), {
      same: 2,
    });
  });

  it("rejects duplicate properties at the root and in nested objects and arrays", () => {
    assertStrictJsonError(
      () => parseStrictJsonV1('{"x":1,"x":2}', { maxBytes: 64, source: "fixture" }),
      {
        code: "JSON_DUPLICATE_PROPERTY",
        line: 1,
        column: 8,
      },
    );
    assertStrictJsonError(
      () => parseStrictJsonV1('{"outer":{"x":1,"x":2}}', { maxBytes: 64, source: "fixture" }),
      { code: "JSON_DUPLICATE_PROPERTY", line: 1, column: 17 },
    );
    assertStrictJsonError(
      () => parseStrictJsonV1('[{"x":1,"x":2},{"x":3}]', { maxBytes: 64, source: "fixture" }),
      { code: "JSON_DUPLICATE_PROPERTY", line: 1, column: 9 },
    );
  });

  it("detects escape-equivalent decoded property names", () => {
    assertStrictJsonError(
      () => parseStrictJsonV1('{"a":1,"\\u0061":2}', { maxBytes: 64, source: "fixture" }),
      {
        code: "JSON_DUPLICATE_PROPERTY",
        line: 1,
        column: 8,
      },
    );
  });

  it("preserves __proto__ as an own data property without prototype mutation", () => {
    const parsed = parseStrictJsonV1('{"__proto__":{"polluted":true}}', {
      maxBytes: 64,
      source: "fixture",
    }) as Record<string, unknown>;

    assert.equal(Object.hasOwn(parsed, "__proto__"), true);
    assert.deepEqual(Object.getOwnPropertyDescriptor(parsed, "__proto__")?.value, {
      polluted: true,
    });
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  });

  it("rejects comments, trailing commas, empty input, malformed input, and multiple roots", () => {
    for (const input of ['{"x":1 // hidden\n}', '{"x":1,}', "", '{"x":', "{} {}"]) {
      assertStrictJsonError(() => parseStrictJsonV1(input, { maxBytes: 128, source: "fixture" }), {
        code: "JSON_SYNTAX",
        line: 1,
        ...(input === "{} {}" ? { column: 4 } : input === "" ? { column: 1 } : {}),
      });
    }
  });

  it("reports one-based parser locations without leaking source contents", () => {
    const sentinel = "DO_NOT_ECHO_SENTINEL";

    assertStrictJsonError(
      () =>
        parseStrictJsonV1(`{\n  "${sentinel}": 1,\n  "${sentinel}": 2\n}`, {
          maxBytes: 256,
          source: "fixture",
        }),
      {
        code: "JSON_DUPLICATE_PROPERTY",
        line: 3,
        column: 3,
        absentText: sentinel,
      },
    );
    assertStrictJsonError(
      () =>
        parseStrictJsonV1(`{\n  "ok": ${sentinel}\n}`, {
          maxBytes: 256,
          source: "fixture",
        }),
      {
        code: "JSON_SYNTAX",
        line: 2,
        column: 9,
        absentText: sentinel,
      },
    );
  });

  it("enforces the UTF-8 byte cap for multibyte text", () => {
    assert.deepEqual(parseStrictJsonV1('"€"', { maxBytes: 5, source: "fixture" }), "€");
    assertStrictJsonError(() => parseStrictJsonV1('"€"', { maxBytes: 4, source: "fixture" }), {
      code: "JSON_TOO_LARGE",
      line: 1,
      column: 1,
    });
  });

  it("rejects unsafe source labels and invalid byte caps as caller errors", () => {
    assert.throws(
      () => parseStrictJsonV1("{}", { maxBytes: 2, source: "unsafe\nlabel" }),
      TypeError,
    );
    assert.throws(() => parseStrictJsonV1("{}", { maxBytes: 0, source: "fixture" }), RangeError);
  });

  it("converts parser recursion exhaustion into a safe syntax error", () => {
    const deeplyNested = `${"[".repeat(20_000)}0${"]".repeat(20_000)}`;

    assertStrictJsonError(
      () =>
        parseStrictJsonV1(deeplyNested, {
          maxBytes: Buffer.byteLength(deeplyNested, "utf8"),
          source: "deep fixture",
        }),
      {
        code: "JSON_SYNTAX",
        line: 1,
        column: 1,
      },
    );
  });
});

describe("bounded strict JSON file readers", () => {
  it("accepts an exact-cap file and rejects an over-cap file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "strict-json-"));
    try {
      const exactPath = join(directory, "exact.json");
      const overPath = join(directory, "over.json");
      await writeFile(exactPath, "{}", "utf8");
      await writeFile(overPath, "{} ", "utf8");

      assert.deepEqual(
        await readStrictJsonFileV1(exactPath, { maxBytes: 2, source: "exact fixture" }),
        {},
      );
      await assert.rejects(
        readStrictJsonFileV1(overPath, { maxBytes: 2, source: "over fixture" }),
        (error: unknown) => error instanceof StrictJsonErrorV1 && error.code === "JSON_TOO_LARGE",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds JSONL total bytes and each physical line", async () => {
    const directory = await mkdtemp(join(tmpdir(), "strict-jsonl-"));
    try {
      const path = join(directory, "values.jsonl");
      await writeFile(path, '{"a":1}\n{"b":2}\n', "utf8");

      assert.deepEqual(
        await readStrictJsonLinesFileV1(path, {
          maxTotalBytes: 16,
          maxLineBytes: 7,
          source: "JSONL fixture",
        }),
        [{ a: 1 }, { b: 2 }],
      );
      await assert.rejects(
        readStrictJsonLinesFileV1(path, {
          maxTotalBytes: 15,
          maxLineBytes: 7,
          source: "JSONL fixture",
        }),
        (error: unknown) => error instanceof StrictJsonErrorV1 && error.code === "JSON_TOO_LARGE",
      );
      await assert.rejects(
        readStrictJsonLinesFileV1(path, {
          maxTotalBytes: 16,
          maxLineBytes: 6,
          source: "JSONL fixture",
        }),
        (error: unknown) =>
          error instanceof StrictJsonErrorV1 &&
          error.code === "JSON_TOO_LARGE" &&
          error.physicalLine === 1,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports the physical JSONL line for syntax and duplicate failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "strict-jsonl-location-"));
    try {
      const malformedPath = join(directory, "malformed.jsonl");
      const duplicatePath = join(directory, "duplicate.jsonl");
      await writeFile(malformedPath, '{"ok":true}\n{"broken":}\n', "utf8");
      await writeFile(duplicatePath, '{"ok":true}\n{"x":1,"x":2}\n', "utf8");

      await assert.rejects(
        readStrictJsonLinesFileV1(malformedPath, {
          maxTotalBytes: 64,
          maxLineBytes: 32,
          source: "malformed JSONL fixture",
        }),
        (error: unknown) =>
          error instanceof StrictJsonErrorV1 &&
          error.code === "JSON_SYNTAX" &&
          error.line === 1 &&
          error.column === 11 &&
          error.physicalLine === 2,
      );
      await assert.rejects(
        readStrictJsonLinesFileV1(duplicatePath, {
          maxTotalBytes: 64,
          maxLineBytes: 32,
          source: "duplicate JSONL fixture",
        }),
        (error: unknown) =>
          error instanceof StrictJsonErrorV1 &&
          error.code === "JSON_DUPLICATE_PROPERTY" &&
          error.line === 1 &&
          error.column === 8 &&
          error.physicalLine === 2,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(path)
        : Promise.resolve(path.endsWith(".ts") ? [path] : []);
    }),
  );
  return nested.flat();
}

it("keeps native JSON.parse limited to reviewed same-process values", async () => {
  const occurrences: string[] = [];
  for (const path of await sourceFiles("src")) {
    const contents = await readFile(path, "utf8");
    for (const _match of contents.matchAll(/\bJSON\.parse\s*\(/gu)) occurrences.push(path);
  }

  assert.deepEqual(occurrences.sort(), [
    "src/contracts/canonical-json.ts",
    "src/contracts/standards-review.ts",
    "src/contracts/standards-review.ts",
    "src/contracts/strict-json.ts",
  ]);
});
