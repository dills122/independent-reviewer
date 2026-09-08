import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import {
  captureGitSnapshotV1,
  inspectSnapshotPacketV1,
  type ReviewRequestV1,
  writeSnapshotPacketV1,
} from "../../src/index.js";

const execFileAsync = promisify(execFile);

async function git(repositoryPath: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", repositoryPath, ...args], { encoding: "utf8" });
}

async function arrangeCapture(): Promise<{
  repositoryPath: string;
  request: ReviewRequestV1;
}> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "independent-reviewer-packet-"));
  await git(repositoryPath, "init", "--initial-branch=main");
  await git(repositoryPath, "config", "user.name", "Packet Test");
  await git(repositoryPath, "config", "user.email", "packet@example.invalid");
  await git(repositoryPath, "config", "commit.gpgsign", "false");
  await writeFile(join(repositoryPath, "reviewed.txt"), "before\n");
  await git(repositoryPath, "add", ".");
  await git(repositoryPath, "commit", "-m", "initial");
  await git(repositoryPath, "switch", "-c", "feature/packet");
  await writeFile(join(repositoryPath, "reviewed.txt"), "after\n");

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

describe("snapshot packet store", () => {
  it("writes and validates a private content-addressed packet", async () => {
    const { repositoryPath, request } = await arrangeCapture();
    const packetPath = join(repositoryPath, ".review-runs", "packet-test");
    try {
      const captured = await captureGitSnapshotV1(request);
      await writeSnapshotPacketV1(packetPath, captured, request);

      const inspected = await inspectSnapshotPacketV1(packetPath);
      assert.deepEqual(inspected.manifest, captured.manifest);
      assert.deepEqual(inspected.canonicalInputs, request.canonicalInputs);
      assert.equal(inspected.authorPacket, undefined);
      assert.equal(inspected.blobCount, 2);
      assert.equal(
        (await readFile(join(packetPath, "snapshot-manifest.json"), "utf8")).endsWith("\n"),
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
});
