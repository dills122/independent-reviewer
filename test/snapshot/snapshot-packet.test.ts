import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import {
  buildReviewerRulesGuidanceGraphV1,
  captureGitSnapshotV1,
  captureReviewerRulesGuidanceV1,
  finalizeReviewContextMapV1,
  inspectSnapshotPacketV1,
  type ReviewContextMapIdentityInputV1,
  type ReviewContextMapV1,
  type ReviewRequestV1,
  sha256Utf8,
  writeSnapshotPacketV1,
} from "../../src/index.js";

const execFileAsync = promisify(execFile);

async function git(repositoryPath: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", repositoryPath, ...args], { encoding: "utf8" });
}

async function arrangeCapture(baseRules?: string): Promise<{
  repositoryPath: string;
  request: ReviewRequestV1;
}> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "independent-reviewer-packet-"));
  await git(repositoryPath, "init", "--initial-branch=main");
  await git(repositoryPath, "config", "user.name", "Packet Test");
  await git(repositoryPath, "config", "user.email", "packet@example.invalid");
  await git(repositoryPath, "config", "commit.gpgsign", "false");
  await writeFile(
    join(repositoryPath, "reviewed.ts"),
    'const marker = "😀";\nexport function reviewed() { return "😀1"; }\n',
  );
  if (baseRules !== undefined) {
    await mkdir(join(repositoryPath, ".independent-reviewer"), { recursive: true });
    await writeFile(join(repositoryPath, ".independent-reviewer", "rules.md"), baseRules);
  }
  await git(repositoryPath, "add", ".");
  await git(repositoryPath, "commit", "-m", "initial");
  await git(repositoryPath, "switch", "-c", "feature/packet");
  await writeFile(
    join(repositoryPath, "reviewed.ts"),
    'const marker = "😀";\nexport function reviewed() { return "😀2"; }\n',
  );

  return {
    repositoryPath,
    request: {
      schemaVersion: 1,
      flowId: "flow_packet_test",
      reviewInstance: { number: 1, maximum: 3 },
      repository: {
        path: repositoryPath,
        base: "main",
        workingTree: { mode: "CUMULATIVE", includeUntracked: true },
      },
      canonicalInputs: {
        requirements: [
          {
            id: "input_requirement",
            kind: "REQUIREMENTS",
            title: "Requirement",
            content: "Review the captured change.",
            provenance: { type: "INLINE", label: "packet test" },
          },
        ],
        implementationPlan: {
          id: "input_plan",
          kind: "IMPLEMENTATION_PLAN",
          title: "Plan",
          content: "Write an inspectable packet.",
          provenance: { type: "INLINE", label: "packet test" },
        },
        projectGuidance: [],
      },
      reviewConfigRef: "config_test",
    },
  };
}

async function rewriteContextMap(
  packetPath: string,
  mutate: (draft: ReviewContextMapIdentityInputV1) => void,
): Promise<void> {
  const contextMapPath = join(packetPath, "review-context-map.json");
  const persisted = JSON.parse(await readFile(contextMapPath, "utf8")) as ReviewContextMapV1;
  const { contextMapDigest: _digest, ...draft } = persisted;
  mutate(draft);
  const contextMap = finalizeReviewContextMapV1(draft);
  await writeFile(contextMapPath, `${JSON.stringify(contextMap)}\n`);

  const metadataPath = join(packetPath, "packet-metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
  metadata.contextMapDigest = contextMap.contextMapDigest;
  await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
}

function declarationRange(draft: ReviewContextMapIdentityInputV1) {
  const declaration = draft.regions.find(
    (region) => region.kind === "DECLARATION" && region.side === "HEAD",
  );
  assert.ok(declaration?.range);
  return declaration.range;
}

describe("snapshot packet store", () => {
  it("writes and verifies a graph-bound reviewer-guidance packet", async () => {
    const { repositoryPath, request } = await arrangeCapture(
      "# Review rules\n\nNo hidden fallback.\n",
    );
    const packetPath = join(repositoryPath, ".review-runs", "packet-guidance");
    try {
      const captured = await captureGitSnapshotV1(request);
      const guidance = await captureReviewerRulesGuidanceV1(repositoryPath, captured.manifest);
      await writeSnapshotPacketV1(packetPath, captured, request, { guidance });

      const inspected = await inspectSnapshotPacketV1(packetPath);
      const metadata = JSON.parse(await readFile(join(packetPath, "packet-metadata.json"), "utf8"));
      assert.equal(metadata.schemaVersion, 4);
      assert.deepEqual(metadata.guidanceGraphDigest, inspected.guidanceGraphDigest);
      assert.equal(
        inspected.guidanceGraph?.nodes[0]?.resolvedPath,
        ".independent-reviewer/rules.md",
      );
      assert.equal(inspected.blobCount, 3);

      const digest = inspected.guidanceGraph?.nodes[0]?.contentDigest.value;
      assert.ok(digest);
      await unlink(join(packetPath, "blobs", digest));
      await assert.rejects(() => inspectSnapshotPacketV1(packetPath), /guidance blob/i);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("rejects a self-consistent guidance graph replacement against packet metadata", async () => {
    const { repositoryPath, request } = await arrangeCapture("# Original rules\n");
    const packetPath = join(repositoryPath, ".review-runs", "packet-guidance");
    try {
      const captured = await captureGitSnapshotV1(request);
      const guidance = await captureReviewerRulesGuidanceV1(repositoryPath, captured.manifest);
      await writeSnapshotPacketV1(packetPath, captured, request, { guidance });
      const replacement = buildReviewerRulesGuidanceGraphV1(
        captured.manifest,
        sha256Utf8("# Replacement rules\n"),
      );
      await writeFile(join(packetPath, "guidance-graph.json"), `${JSON.stringify(replacement)}\n`);

      await assert.rejects(
        () => inspectSnapshotPacketV1(packetPath),
        /metadata guidance graph digest/i,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("writes and validates a private content-addressed packet", async () => {
    const { repositoryPath, request } = await arrangeCapture();
    const packetPath = join(repositoryPath, ".review-runs", "packet-test");
    try {
      const captured = await captureGitSnapshotV1(request);
      await writeSnapshotPacketV1(packetPath, captured, request);

      const inspected = await inspectSnapshotPacketV1(packetPath);
      assert.deepEqual(inspected.manifest, captured.manifest);
      assert.equal(
        inspected.contextMap.snapshotDigest.value,
        captured.manifest.snapshotDigest.value,
      );
      assert.equal(inspected.contextMap.producers[0]?.producerId, "producer_snapshot_manifest");
      assert.equal(
        inspected.contextMap.regions.some(
          (region) => region.kind === "DECLARATION" && region.displayName === "reviewed",
        ),
        true,
      );
      assert.deepEqual(inspected.canonicalInputs, request.canonicalInputs);
      assert.equal(inspected.authorPacket, undefined);
      assert.equal(inspected.reviewConfigRef, "config_test");
      assert.equal(inspected.blobCount, 2);
      assert.equal(
        (await readFile(join(packetPath, "snapshot-manifest.json"), "utf8")).endsWith("\n"),
        true,
      );
      assert.equal(
        (await readFile(join(packetPath, "review-context-map.json"), "utf8")).endsWith("\n"),
        true,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("rejects a packet whose captured blob was changed", async () => {
    const { repositoryPath, request } = await arrangeCapture();
    const packetPath = join(repositoryPath, ".review-runs", "packet-test");
    try {
      const captured = await captureGitSnapshotV1(request);
      await writeSnapshotPacketV1(packetPath, captured, request);
      const digest = captured.blobs.keys().next().value;
      assert.ok(digest);
      await writeFile(join(packetPath, "blobs", digest), "tampered\n");

      await assert.rejects(() => inspectSnapshotPacketV1(packetPath), /digest/i);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("rejects a packet whose context map was changed", async () => {
    const { repositoryPath, request } = await arrangeCapture();
    const packetPath = join(repositoryPath, ".review-runs", "packet-test");
    try {
      const captured = await captureGitSnapshotV1(request);
      await writeSnapshotPacketV1(packetPath, captured, request);
      const contextMapPath = join(packetPath, "review-context-map.json");
      const contextMap = JSON.parse(await readFile(contextMapPath, "utf8")) as {
        regions: Array<{ byteLength: number }>;
      };
      const firstRegion = contextMap.regions[0];
      assert.ok(firstRegion);
      firstRegion.byteLength += 1;
      await writeFile(contextMapPath, `${JSON.stringify(contextMap)}\n`);

      await assert.rejects(() => inspectSnapshotPacketV1(packetPath), /context map.*digest/i);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("rejects a validly re-digested context map that omits captured file coverage", async () => {
    const { repositoryPath, request } = await arrangeCapture();
    const packetPath = join(repositoryPath, ".review-runs", "packet-test");
    try {
      const captured = await captureGitSnapshotV1(request);
      await writeSnapshotPacketV1(packetPath, captured, request);
      const contextMapPath = join(packetPath, "review-context-map.json");
      const persisted = JSON.parse(await readFile(contextMapPath, "utf8")) as Record<
        string,
        unknown
      >;
      const { contextMapDigest: _digest, ...draft } = persisted;
      const regions = (draft.regions as Array<{ kind: string }>).filter(
        (region) => region.kind !== "FILE",
      );
      const relations = (
        draft.relations as Array<{
          sourceRegionId: string;
          targetRegionId: string;
        }>
      ).filter(
        (relation) =>
          regions.some(
            (region) =>
              "regionId" in region &&
              (region.regionId === relation.sourceRegionId ||
                region.regionId === relation.targetRegionId),
          ) === false,
      );
      const contextMap = finalizeReviewContextMapV1({ ...draft, regions, relations });
      await writeFile(contextMapPath, `${JSON.stringify(contextMap)}\n`);
      const metadataPath = join(packetPath, "packet-metadata.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
      metadata.contextMapDigest = contextMap.contextMapDigest;
      await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);

      await assert.rejects(() => inspectSnapshotPacketV1(packetPath), /file coverage/i);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("rejects a re-digested UTF-16 range outside its frozen source", async () => {
    const { repositoryPath, request } = await arrangeCapture();
    const packetPath = join(repositoryPath, ".review-runs", "packet-test");
    try {
      const captured = await captureGitSnapshotV1(request);
      await writeSnapshotPacketV1(packetPath, captured, request);
      await rewriteContextMap(packetPath, (draft) => {
        const range = declarationRange(draft);
        range.endOffsetExclusive += 10_000;
        range.endLine += 10_000;
      });

      await assert.rejects(() => inspectSnapshotPacketV1(packetPath), /source range/i);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("rejects a re-digested range whose UTF-8 byte length is false", async () => {
    const { repositoryPath, request } = await arrangeCapture();
    const packetPath = join(repositoryPath, ".review-runs", "packet-test");
    try {
      const captured = await captureGitSnapshotV1(request);
      await writeSnapshotPacketV1(packetPath, captured, request);
      await rewriteContextMap(packetPath, (draft) => {
        declarationRange(draft).contentByteLength += 1;
      });

      await assert.rejects(() => inspectSnapshotPacketV1(packetPath), /source range/i);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("rejects re-digested line and column positions that disagree with source offsets", async () => {
    const { repositoryPath, request } = await arrangeCapture();
    const packetPath = join(repositoryPath, ".review-runs", "packet-test");
    try {
      const captured = await captureGitSnapshotV1(request);
      await writeSnapshotPacketV1(packetPath, captured, request);
      await rewriteContextMap(packetPath, (draft) => {
        const range = declarationRange(draft);
        range.startLine = 1;
        range.startColumn += 1;
      });

      await assert.rejects(() => inspectSnapshotPacketV1(packetPath), /source range/i);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("rejects a re-digested UTF-8 range ending inside a multibyte code point", async () => {
    const { repositoryPath, request } = await arrangeCapture();
    const packetPath = join(repositoryPath, ".review-runs", "packet-test");
    try {
      const captured = await captureGitSnapshotV1(request);
      await writeSnapshotPacketV1(packetPath, captured, request);
      const source = 'const marker = "😀";\nexport function reviewed() { return "😀2"; }\n';
      await rewriteContextMap(packetPath, (draft) => {
        const range = declarationRange(draft);
        const startOffset = Buffer.byteLength(source.slice(0, range.startOffset), "utf8");
        const emojiIndex = source.indexOf("😀", range.startOffset);
        assert.notEqual(emojiIndex, -1);
        const insideEmoji = Buffer.byteLength(source.slice(0, emojiIndex), "utf8") + 1;
        range.coordinateUnit = "UTF8_BYTE";
        range.startOffset = startOffset;
        range.endOffsetExclusive = insideEmoji;
        range.contentByteLength = insideEmoji - startOffset;
        range.endLine = 2;
        range.endColumn = insideEmoji - Buffer.byteLength('const marker = "😀";\n', "utf8");
      });

      await assert.rejects(() => inspectSnapshotPacketV1(packetPath), /source range/i);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("accepts an exact re-digested UTF-8 source range", async () => {
    const { repositoryPath, request } = await arrangeCapture();
    const packetPath = join(repositoryPath, ".review-runs", "packet-test");
    try {
      const captured = await captureGitSnapshotV1(request);
      await writeSnapshotPacketV1(packetPath, captured, request);
      const source = 'const marker = "😀";\nexport function reviewed() { return "😀2"; }\n';
      const lineStart = source.indexOf("export function");
      await rewriteContextMap(packetPath, (draft) => {
        const range = declarationRange(draft);
        const startUtf16 = range.startOffset;
        const endUtf16 = range.endOffsetExclusive;
        const startUtf8 = Buffer.byteLength(source.slice(0, startUtf16), "utf8");
        const endUtf8 = Buffer.byteLength(source.slice(0, endUtf16), "utf8");
        range.coordinateUnit = "UTF8_BYTE";
        range.startOffset = startUtf8;
        range.endOffsetExclusive = endUtf8;
        range.contentByteLength = endUtf8 - startUtf8;
        range.startColumn = Buffer.byteLength(source.slice(lineStart, startUtf16), "utf8");
        range.endColumn = Buffer.byteLength(source.slice(lineStart, endUtf16), "utf8");
      });

      await inspectSnapshotPacketV1(packetPath);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
  it("cleans up staging and keeps the existing packet when the write cannot land", async () => {
    const { repositoryPath, request } = await arrangeCapture();
    const packetRoot = join(repositoryPath, ".review-runs");
    const packetPath = join(packetRoot, "packet-test");
    try {
      const captured = await captureGitSnapshotV1(request);
      await writeSnapshotPacketV1(packetPath, captured, request);

      await assert.rejects(
        () => writeSnapshotPacketV1(packetPath, captured, request),
        /already exists/,
      );

      assert.deepEqual(await readdir(packetRoot), ["packet-test"]);
      assert.equal((await inspectSnapshotPacketV1(packetPath)).blobCount, 2);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("writes a packet even when an interrupted run left staging debris behind", async () => {
    const { repositoryPath, request } = await arrangeCapture();
    const packetRoot = join(repositoryPath, ".review-runs");
    const packetPath = join(packetRoot, "packet-test");
    try {
      const captured = await captureGitSnapshotV1(request);
      await mkdir(join(`${packetPath}.partial-00000000-0000-4000-8000-000000000000`, "blobs"), {
        recursive: true,
        mode: 0o700,
      });

      await writeSnapshotPacketV1(packetPath, captured, request);

      assert.equal((await inspectSnapshotPacketV1(packetPath)).blobCount, 2);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
