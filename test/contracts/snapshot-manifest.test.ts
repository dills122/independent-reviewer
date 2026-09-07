import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { SNAPSHOT_MANIFEST_V1_JSON_SCHEMA, SnapshotManifestV1Schema } from "../../src/index.js";

async function readFixture(): Promise<unknown> {
  const contents = await readFile(
    resolve("test", "fixtures", "snapshot-manifest.valid.json"),
    "utf8",
  );
  return JSON.parse(contents) as unknown;
}

describe("SnapshotManifestV1Schema", () => {
  it("accepts a stable manifest with modified, renamed, and untracked paths", async () => {
    const manifest = SnapshotManifestV1Schema.parse(await readFixture());

    assert.equal(manifest.paths.length, 3);
    assert.deepEqual(manifest.workingTree.includedUntrackedPaths, ["test/new-contract.test.ts"]);
  });

  it("rejects traversal outside the snapshot root", async () => {
    const fixture = structuredClone(await readFixture()) as {
      paths: Array<{ path: string }>;
    };
    const firstPath = fixture.paths[0];
    assert.ok(firstPath);
    firstPath.path = "../outside.txt";

    assert.equal(SnapshotManifestV1Schema.safeParse(fixture).success, false);
  });

  it("requires renamed paths to identify their previous location", async () => {
    const fixture = structuredClone(await readFixture()) as {
      paths: Array<Record<string, unknown>>;
    };
    const renamed = fixture.paths.find((path) => path.changeType === "RENAMED");
    assert.ok(renamed);
    delete renamed.previousPath;

    assert.equal(SnapshotManifestV1Schema.safeParse(fixture).success, false);
  });

  it("rejects a manifest whose capture state changed", async () => {
    const fixture = structuredClone(await readFixture()) as {
      raceCheck: { afterStateDigest: { value: string } };
    };
    fixture.raceCheck.afterStateDigest.value = "4".repeat(64);

    assert.equal(SnapshotManifestV1Schema.safeParse(fixture).success, false);
  });

  it("requires the untracked-path ledger to match untracked entries", async () => {
    const fixture = structuredClone(await readFixture()) as {
      workingTree: { includedUntrackedPaths: string[] };
    };
    fixture.workingTree.includedUntrackedPaths = [];

    assert.equal(SnapshotManifestV1Schema.safeParse(fixture).success, false);
  });

  it("rejects duplicate paths in the change manifest", async () => {
    const fixture = structuredClone(await readFixture()) as {
      paths: unknown[];
    };
    const firstPath = fixture.paths[0];
    assert.ok(firstPath);
    fixture.paths.push(firstPath);

    assert.equal(SnapshotManifestV1Schema.safeParse(fixture).success, false);
  });

  it("matches the committed JSON Schema artifact", async () => {
    const contents = await readFile(resolve("schemas", "snapshot-manifest-v1.schema.json"), "utf8");

    assert.deepEqual(JSON.parse(contents), SNAPSHOT_MANIFEST_V1_JSON_SCHEMA);
  });
});
