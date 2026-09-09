import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  logicalLineCountV1,
  resolveSnapshotSourceContentV1,
  type SnapshotContentV1,
  type SnapshotPathEntryV1,
} from "../../src/index.js";

function textContent(marker: string): SnapshotContentV1 {
  return {
    kind: "TEXT",
    digest: { algorithm: "SHA256", value: marker.padEnd(64, "0") },
    byteLength: 1,
    gitMode: "100644",
    isGenerated: false,
  };
}

const before = textContent("a");
const after = textContent("b");

function entry(changeType: SnapshotPathEntryV1["changeType"]): SnapshotPathEntryV1 {
  switch (changeType) {
    case "ADDED":
    case "UNTRACKED":
      return { path: "new.md", changeType, before: null, after };
    case "DELETED":
      return { path: "gone.md", changeType, before, after: null };
    case "RENAMED":
    case "COPIED":
      return { path: "new-name.md", previousPath: "old-name.md", changeType, before, after };
    default:
      return { path: "same.md", changeType, before, after };
  }
}

describe("resolveSnapshotSourceContentV1", () => {
  const cases: ReadonlyArray<
    readonly [
      SnapshotPathEntryV1["changeType"],
      string,
      "BASE" | "HEAD",
      SnapshotContentV1 | undefined,
    ]
  > = [
    ["ADDED", "new.md", "HEAD", after],
    ["ADDED", "new.md", "BASE", undefined],
    ["UNTRACKED", "new.md", "HEAD", after],
    ["UNTRACKED", "new.md", "BASE", undefined],
    ["DELETED", "gone.md", "BASE", before],
    ["DELETED", "gone.md", "HEAD", undefined],
    ["MODIFIED", "same.md", "BASE", before],
    ["MODIFIED", "same.md", "HEAD", after],
    ["TYPE_CHANGED", "same.md", "BASE", before],
    ["TYPE_CHANGED", "same.md", "HEAD", after],
    ["RENAMED", "old-name.md", "BASE", before],
    // A rename leaves nothing behind at the previous path.
    ["RENAMED", "old-name.md", "HEAD", undefined],
    ["RENAMED", "new-name.md", "HEAD", after],
    ["RENAMED", "new-name.md", "BASE", undefined],
    // A copy retains its source, so the previous path resolves on both sides.
    ["COPIED", "old-name.md", "BASE", before],
    ["COPIED", "old-name.md", "HEAD", before],
    ["COPIED", "new-name.md", "HEAD", after],
    ["COPIED", "new-name.md", "BASE", undefined],
  ];

  for (const [changeType, path, side, expected] of cases) {
    it(`resolves ${changeType} ${path} on ${side}`, () => {
      assert.deepEqual(resolveSnapshotSourceContentV1([entry(changeType)], path, side), expected);
    });
  }

  it("prefers the entry that owns the path over a relocation source", () => {
    const ownedAfter = textContent("c");
    const paths: SnapshotPathEntryV1[] = [
      { path: "new-name.md", previousPath: "old-name.md", changeType: "COPIED", before, after },
      { path: "old-name.md", changeType: "MODIFIED", before, after: ownedAfter },
    ];

    assert.deepEqual(resolveSnapshotSourceContentV1(paths, "old-name.md", "HEAD"), ownedAfter);
    assert.deepEqual(
      resolveSnapshotSourceContentV1([...paths].reverse(), "old-name.md", "HEAD"),
      ownedAfter,
    );
  });
});

describe("logicalLineCountV1", () => {
  it("counts addressable lines", () => {
    assert.equal(logicalLineCountV1(""), 0);
    assert.equal(logicalLineCountV1("a"), 1);
    assert.equal(logicalLineCountV1("a\n"), 1);
    assert.equal(logicalLineCountV1("\n"), 1);
    assert.equal(logicalLineCountV1("a\r\nb"), 2);
    assert.equal(logicalLineCountV1("a\r\nb\r\n"), 2);
  });
});
