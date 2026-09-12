import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveGitAttributesV1 } from "../../src/snapshot/git-capture.js";

/** Builds the NUL-separated path/attribute/value triples `check-attr -z` emits. */
function attributeStdout(
  entries: ReadonlyArray<readonly [path: string, attribute: string, value: string]>,
): Uint8Array {
  return Buffer.from(`${entries.flat().join("\0")}\0`, "utf8");
}

function vendored(paths: readonly string[]): Uint8Array {
  return attributeStdout(paths.map((path) => [path, "linguist-vendored", "set"] as const));
}

describe("resolveGitAttributesV1", () => {
  it("records the attributes Git reports", async () => {
    const { resolved, unresolved } = await resolveGitAttributesV1(
      "/repo",
      ["a.ts", "b.ts"],
      async () =>
        attributeStdout([
          ["a.ts", "linguist-vendored", "set"],
          ["a.ts", "linguist-generated", "unspecified"],
          ["b.ts", "linguist-documentation", "true"],
        ]),
    );
    assert.deepEqual(resolved.get("a.ts"), { vendored: true });
    assert.deepEqual(resolved.get("b.ts"), { documentation: true });
    assert.deepEqual(unresolved, []);
  });

  it("isolates a failing path instead of losing its whole batch", async () => {
    // Regression for #95: a failing batch was skipped with `catch { continue; }`, so up to 200
    // paths silently lost their .gitattributes answers and nothing recorded it.
    const paths = Array.from({ length: 64 }, (_, index) => `file-${index}.ts`);
    const poison = "file-37.ts";
    const calls: number[] = [];

    const { resolved, unresolved } = await resolveGitAttributesV1("/repo", paths, async (batch) => {
      calls.push(batch.length);
      return batch.includes(poison) ? undefined : vendored(batch);
    });

    assert.deepEqual(unresolved, [poison]);
    for (const path of paths) {
      assert.equal(resolved.has(path), path !== poison, path);
    }
    // Bisecting, not one call per path: 64 paths isolate one failure in far fewer than 64 calls.
    assert.ok(calls.length < paths.length, `expected bisecting, saw ${calls.length} calls`);
  });

  it("reports every path of a batch it cannot split further", async () => {
    const paths = ["a.ts", "b.ts", "c.ts"];
    const { resolved, unresolved } = await resolveGitAttributesV1(
      "/repo",
      paths,
      async () => undefined,
    );
    assert.deepEqual(unresolved.sort(), [...paths].sort());
    assert.equal(resolved.size, 0);
  });

  it("bounds the calls a repository-wide failure can cost", async () => {
    const paths = Array.from({ length: 200 }, (_, index) => `file-${index}.ts`);
    let calls = 0;
    const { unresolved } = await resolveGitAttributesV1("/repo", paths, async () => {
      calls += 1;
      return undefined;
    });

    assert.deepEqual(unresolved.sort(), [...paths].sort());
    // Without a retry budget a total failure would bisect to one call per path plus the interior
    // nodes of the tree; the budget keeps it to a fixed cost.
    assert.ok(calls <= 70, `expected a bounded call count, saw ${calls}`);
  });

  it("keeps unrelated batches whole when one batch fails entirely", async () => {
    const failing = Array.from({ length: 4 }, (_, index) => `bad-${index}.ts`);
    const working = Array.from({ length: 4 }, (_, index) => `good-${index}.ts`);
    const { resolved, unresolved } = await resolveGitAttributesV1(
      "/repo",
      [...failing, ...working],
      async (batch) =>
        batch.some((path) => path.startsWith("bad-")) ? undefined : vendored(batch),
    );

    assert.deepEqual(unresolved.sort(), [...failing].sort());
    for (const path of working) assert.equal(resolved.get(path)?.vendored, true, path);
  });
});
