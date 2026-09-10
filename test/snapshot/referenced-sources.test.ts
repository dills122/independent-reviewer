import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  candidateReferencedPathsV1,
  relativeImportSpecifiersV1,
  resolveReferencedPathsV1,
} from "../../src/snapshot/referenced-sources.js";

describe("relativeImportSpecifiersV1", () => {
  it("collects relative specifiers from every import form once", () => {
    const source = [
      `import { taxCents } from "./tax.js";`,
      `import type { CartLine } from './cart.js';`,
      `export { helper } from "../shared/helper.js";`,
      `const lazy = await import("./lazy.js");`,
      `const legacy = require("./legacy.cjs");`,
      `import "./side-effect.js";`,
      `import { duplicate } from "./tax.js";`,
    ].join("\n");

    assert.deepEqual(relativeImportSpecifiersV1(source), [
      "./tax.js",
      "./cart.js",
      "../shared/helper.js",
      "./lazy.js",
      "./legacy.cjs",
      "./side-effect.js",
    ]);
  });

  it("ignores package and absolute specifiers", () => {
    const source = [
      `import { readFile } from "node:fs/promises";`,
      `import zod from "zod";`,
      `import { x } from "@scope/package";`,
      `import { y } from "/etc/passwd";`,
    ].join("\n");

    assert.deepEqual(relativeImportSpecifiersV1(source), []);
  });
});

describe("candidateReferencedPathsV1", () => {
  it("maps a compiled specifier back to its TypeScript source first", () => {
    const candidates = candidateReferencedPathsV1("src/checkout.ts", "./tax.js");

    assert.equal(candidates[0], "src/tax.ts");
    assert.ok(candidates.includes("src/tax.js"));
    // A specifier carrying a file extension never names a directory, so no index candidate is
    // offered and the nonsense "src/tax.js/index.ts" is never produced.
    assert.ok(!candidates.some((candidate) => candidate.includes("/index.")));
    assert.ok(!candidates.some((candidate) => candidate.includes(".js/")));
  });

  it("offers every resolvable extension for an extensionless specifier", () => {
    const candidates = candidateReferencedPathsV1("src/a/b.ts", "../c");

    assert.equal(candidates[0], "src/c.ts");
    assert.ok(candidates.includes("src/c/index.ts"));
  });

  it("refuses a specifier that escapes the repository root", () => {
    assert.deepEqual(candidateReferencedPathsV1("src/checkout.ts", "../../outside.js"), []);
  });
});

describe("resolveReferencedPathsV1", () => {
  it("takes the first candidate the snapshot can read and never repeats one", () => {
    const present = new Set(["src/tax.ts", "src/cart.ts"]);
    const source = [
      `import { taxCents } from "./tax.js";`,
      `import { cartSubtotalCents } from "./cart.js";`,
      `import { missing } from "./missing.js";`,
      `import { taxCents as again } from "./tax.js";`,
    ].join("\n");

    assert.deepEqual(
      resolveReferencedPathsV1("src/checkout.ts", source, (path) => present.has(path)),
      ["src/tax.ts", "src/cart.ts"],
    );
  });

  it("resolves two specifiers naming the same file only once", () => {
    const present = new Set(["src/tax.ts"]);
    const source = `import { a } from "./tax.js";\nimport { b } from "./tax";`;

    assert.deepEqual(
      resolveReferencedPathsV1("src/checkout.ts", source, (path) => present.has(path)),
      ["src/tax.ts"],
    );
  });
});
