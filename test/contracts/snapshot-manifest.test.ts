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

  it("rejects content kinds paired with incompatible Git modes", async () => {
    const incompatiblePairs = [
      { kind: "TEXT", gitMode: "120000" },
      { kind: "BINARY", gitMode: "160000" },
      { kind: "SYMLINK", gitMode: "100644" },
      { kind: "SUBMODULE", gitMode: "100755" },
    ];

    for (const pair of incompatiblePairs) {
      const fixture = structuredClone(await readFixture()) as {
        paths: Array<{ after: null | { kind: string; gitMode: string } }>;
      };
      const modified = fixture.paths.find((path) => path.after);
      assert.ok(modified?.after);
      modified.after.kind = pair.kind;
      modified.after.gitMode = pair.gitMode;

      assert.equal(
        SnapshotManifestV1Schema.safeParse(fixture).success,
        false,
        `${pair.kind} must reject ${pair.gitMode}`,
      );
    }
  });

  it("requires TYPE_CHANGED entries to change Git object category", async () => {
    const fixture = structuredClone(await readFixture()) as {
      paths: Array<{ changeType: string }>;
    };
    const modified = fixture.paths.find((path) => path.changeType === "MODIFIED");
    assert.ok(modified);
    modified.changeType = "TYPE_CHANGED";

    assert.equal(SnapshotManifestV1Schema.safeParse(fixture).success, false);
  });

  it("forbids MODIFIED entries from changing Git object category", async () => {
    const fixture = structuredClone(await readFixture()) as {
      paths: Array<{
        changeType: string;
        after: null | { kind: string; gitMode: string };
      }>;
    };
    const modified = fixture.paths.find((path) => path.changeType === "MODIFIED");
    assert.ok(modified?.after);
    modified.after.kind = "SYMLINK";
    modified.after.gitMode = "120000";

    assert.equal(SnapshotManifestV1Schema.safeParse(fixture).success, false);
  });

  it("rejects a MODIFIED entry whose before and after states are identical", async () => {
    const fixture = structuredClone(await readFixture()) as {
      paths: Array<{ changeType: string; before: unknown; after: unknown }>;
    };
    const modified = fixture.paths.find((path) => path.changeType === "MODIFIED");
    assert.ok(modified);
    modified.after = structuredClone(modified.before);

    assert.equal(SnapshotManifestV1Schema.safeParse(fixture).success, false);
  });

  it("accepts a MODIFIED entry containing only a regular-file mode change", async () => {
    const fixture = structuredClone(await readFixture()) as {
      paths: Array<{
        changeType: string;
        before: null | { gitMode: string };
        after: null | { gitMode: string };
      }>;
    };
    const modified = fixture.paths.find((path) => path.changeType === "MODIFIED");
    assert.ok(modified?.before && modified.after);
    modified.after = structuredClone(modified.before);
    modified.after.gitMode = "100755";

    assert.equal(SnapshotManifestV1Schema.safeParse(fixture).success, true);
  });

  it("requires base and head commits to use the same Git object format", async () => {
    const fixture = structuredClone(await readFixture()) as {
      source: { headCommit: string };
    };
    fixture.source.headCommit = "b".repeat(64);

    assert.equal(SnapshotManifestV1Schema.safeParse(fixture).success, false);
  });

  it("requires a persisted branch name rather than a revision expression", async () => {
    const fixture = structuredClone(await readFixture()) as {
      source: { branch: string | null };
    };
    fixture.source.branch = "bad..name";

    assert.equal(SnapshotManifestV1Schema.safeParse(fixture).success, false);
  });

  it("rejects a relocation whose old and new paths are identical", async () => {
    const fixture = structuredClone(await readFixture()) as {
      paths: Array<{ changeType: string; path: string; previousPath?: string }>;
    };
    const renamed = fixture.paths.find((path) => path.changeType === "RENAMED");
    assert.ok(renamed);
    renamed.previousPath = renamed.path;

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

  it("exports a materialized artifact schema with an explicit instance maximum", () => {
    const schema = SNAPSHOT_MANIFEST_V1_JSON_SCHEMA as {
      properties?: { reviewInstance?: { required?: string[] } };
    };

    assert.ok(schema.properties?.reviewInstance?.required?.includes("maximum"));
  });
});
