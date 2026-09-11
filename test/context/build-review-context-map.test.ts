import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildReviewContextMapV1,
  finalizeSnapshotManifestV1,
  sha256BytesDigestV1,
} from "../../src/index.js";

const digest = (character: string) => ({
  algorithm: "SHA256" as const,
  value: character.repeat(64),
});

describe("buildReviewContextMapV1", () => {
  it("shares one BASE region when a copied source is also modified", async () => {
    const beforeBytes = Buffer.from("export function value() { return 1; }\n");
    const afterBytes = Buffer.from("export function value() { return 2; }\n");
    const beforeDigest = sha256BytesDigestV1(beforeBytes);
    const afterDigest = sha256BytesDigestV1(afterBytes);
    const blobs = new Map([
      [beforeDigest.value, beforeBytes],
      [afterDigest.value, afterBytes],
    ]);
    const content = (contentDigest: typeof beforeDigest, bytes: Uint8Array) => ({
      kind: "TEXT" as const,
      digest: contentDigest,
      byteLength: bytes.byteLength,
      gitMode: "100644" as const,
      isGenerated: false,
    });
    const manifest = finalizeSnapshotManifestV1({
      schemaVersion: 1,
      snapshotId: "snapshot_copy_context",
      flowId: "flow_copy_context",
      reviewInstance: { number: 1, maximum: 1 },
      source: {
        repositoryId: "repo_copy_context",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        branch: "codex/copy-context",
      },
      workingTree: {
        hasStagedChanges: false,
        hasUnstagedChanges: false,
        includedUntrackedPaths: [],
      },
      paths: [
        {
          changeType: "COPIED" as const,
          path: "src/copied.ts",
          previousPath: "src/original.ts",
          role: "SOURCE" as const,
          before: content(beforeDigest, beforeBytes),
          after: content(beforeDigest, beforeBytes),
        },
        {
          changeType: "MODIFIED" as const,
          path: "src/original.ts",
          role: "SOURCE" as const,
          before: content(beforeDigest, beforeBytes),
          after: content(afterDigest, afterBytes),
        },
      ],
      exclusions: [],
      omissions: [],
      referencedSources: [],
      canonicalInputs: [],
      policies: { capture: "capture-v2", transmission: "transmission-v1" },
      raceCheck: {
        attempts: 1,
        status: "STABLE",
        beforeStateDigest: digest("c"),
        afterStateDigest: digest("c"),
      },
    });

    const map = await buildReviewContextMapV1(manifest, blobs);
    const sharedBase = map.regions.filter(
      (region) => region.path === "src/original.ts" && region.side === "BASE",
    );

    assert.equal(sharedBase.filter((region) => region.kind === "FILE").length, 1);
    assert.equal(sharedBase.filter((region) => region.kind === "DECLARATION").length, 1);
  });

  it("bounds packet-wide syntax enrichment while retaining every file fallback", async () => {
    const blobs = new Map<string, Uint8Array>();
    const paths = Array.from({ length: 5 }, (_, fileIndex) => {
      const source = Array.from(
        { length: 600 },
        (_, declarationIndex) =>
          `export function f${fileIndex}_${declarationIndex}() { return ${declarationIndex}; }`,
      ).join("\n");
      const bytes = Buffer.from(`${source}\n`);
      const contentDigest = sha256BytesDigestV1(bytes);
      blobs.set(contentDigest.value, bytes);
      return {
        changeType: "ADDED" as const,
        path: `src/dense-${fileIndex}.js`,
        role: "SOURCE" as const,
        before: null,
        after: {
          kind: "TEXT" as const,
          digest: contentDigest,
          byteLength: bytes.byteLength,
          gitMode: "100644" as const,
          isGenerated: false,
        },
      };
    });
    const manifest = finalizeSnapshotManifestV1({
      schemaVersion: 1,
      snapshotId: "snapshot_context_bound",
      flowId: "flow_context_bound",
      reviewInstance: { number: 1, maximum: 1 },
      source: {
        repositoryId: "repo_context_bound",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        branch: "codex/context-bound",
      },
      workingTree: {
        hasStagedChanges: false,
        hasUnstagedChanges: false,
        includedUntrackedPaths: [],
      },
      paths,
      exclusions: [],
      omissions: [],
      referencedSources: [],
      canonicalInputs: [],
      policies: { capture: "capture-v2", transmission: "transmission-v1" },
      raceCheck: {
        attempts: 1,
        status: "STABLE",
        beforeStateDigest: digest("c"),
        afterStateDigest: digest("c"),
      },
    });

    const map = await buildReviewContextMapV1(manifest, blobs);
    const declarations = map.regions.filter((region) => region.kind === "DECLARATION");

    assert.equal(map.regions.filter((region) => region.kind === "FILE").length, paths.length);
    assert.equal(declarations.length <= 1_024, true);
    assert.equal(
      map.producers.some(
        (producer) =>
          producer.status === "PARTIAL" &&
          producer.diagnostics.some((diagnostic) =>
            /stopped at .*serialized bytes/i.test(diagnostic),
          ),
      ),
      true,
    );
  });
});
