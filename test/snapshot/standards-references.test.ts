import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { buildReviewBrief, captureGitSnapshotV1, writeSnapshotPacketV1 } from "../../src/index.js";
import { StandardsReviewBriefV2Schema } from "../../src/contracts/neutral-review-brief.js";

const exec = promisify(execFile);

async function git(repositoryPath: string, ...args: string[]): Promise<void> {
  await exec("git", ["-C", repositoryPath, ...args]);
}

function standardsRequest(repositoryPath: string, referencePath = "API_NAMES.md") {
  const profile = {
    schemaVersion: 2,
    name: "API naming",
    source: "Repository standards",
    rules: [
      {
        id: "rule_api_names",
        text: "Exported API names must appear in the authoritative registry.",
        enforcement: "REQUIRED",
        paths: ["**/*.ts"],
        exceptions: null,
      },
    ],
    references: [
      {
        id: "reference_api_names",
        path: referencePath,
        purpose: "Authoritative public API name registry.",
        authority: "BASE",
      },
    ],
    referenceBindings: [
      { ruleId: "rule_api_names", referenceId: "reference_api_names", required: true },
    ],
  };
  return {
    schemaVersion: 2 as const,
    mode: "STANDARDS" as const,
    flowId: "flow_reference_capture",
    reviewInstance: { number: 1, maximum: 3 },
    repository: {
      path: repositoryPath,
      base: "main",
      workingTree: { mode: "CUMULATIVE" as const, includeUntracked: true },
    },
    canonicalInputs: {
      standards: [
        {
          id: "input_standard",
          kind: "PROJECT_GUIDANCE" as const,
          title: "API naming",
          content: JSON.stringify(profile),
          provenance: { type: "INLINE" as const, label: "test standard" },
        },
      ],
    },
    authorPacket: {
      schemaVersion: 2 as const,
      overview: "Change one API export.",
      claimedVerification: [],
    },
    reviewConfigRef: "config_test",
  };
}

async function repository(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "standards-reference-"));
  await git(path, "init", "--initial-branch=main");
  await git(path, "config", "user.name", "Reference Test");
  await git(path, "config", "user.email", "reference@example.invalid");
  await git(path, "config", "commit.gpgsign", "false");
  await writeFile(join(path, "API_NAMES.md"), "- calculateTotal\n");
  await writeFile(join(path, "prices.ts"), "export const calculateTotal = () => 1;\n");
  await git(path, "add", ".");
  await git(path, "commit", "-m", "base");
  await git(path, "switch", "-c", "feature/reference");
  return path;
}

test("captures unchanged declared reference as supporting context", async () => {
  const repo = await repository();
  try {
    await writeFile(join(repo, "prices.ts"), "export const calculateTax = () => 1;\n");
    const request = standardsRequest(repo);
    const captured = await captureGitSnapshotV1(request);

    assert.deepEqual(
      captured.manifest.referencedSources.map(({ path }) => path),
      ["API_NAMES.md"],
    );
    assert.deepEqual(captured.manifest.referencedSources[0]?.importedBy, []);
    assert.deepEqual(captured.manifest.referencedSources[0]?.standardReferenceIds, [
      "reference_api_names",
    ]);

    const packetPath = join(repo, ".review-runs", "packet");
    await writeSnapshotPacketV1(packetPath, captured, request);
    const brief = await buildReviewBrief(packetPath, 64_000);
    if (brief.schemaVersion !== 2) throw new Error("Expected standards brief.");
    assert.equal(brief.referencedSources[0]?.path, "API_NAMES.md");
    assert.deepEqual(brief.referencedSources[0]?.importedBy, []);
    assert.deepEqual(brief.referencedSources[0]?.standardReferenceIds, ["reference_api_names"]);
    assert.match(brief.referencedSources[0]?.content ?? "", /calculateTotal/);
    assert.deepEqual(brief.referenceEvidence, [
      {
        referenceId: "reference_api_names",
        path: "API_NAMES.md",
        roles: ["SUPPORTING_REFERENCE"],
        captureStatus: "CAPTURED",
        authoritySide: "BASE",
        required: true,
        boundRuleIds: ["rule_api_names"],
      },
    ]);
    assert.equal(
      StandardsReviewBriefV2Schema.safeParse({
        ...brief,
        referenceEvidence: [{ ...brief.referenceEvidence[0], captureStatus: "UNAVAILABLE" }],
      }).success,
      false,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("promotes a changed declared Markdown reference to review target", async () => {
  const repo = await repository();
  try {
    await writeFile(join(repo, "prices.ts"), "export const calculateTax = () => 1;\n");
    await writeFile(join(repo, "API_NAMES.md"), "- calculateTax\n");
    const request = standardsRequest(repo);
    const captured = await captureGitSnapshotV1(request);
    const reference = captured.manifest.paths.find(({ path }) => path === "API_NAMES.md");

    assert.equal(reference?.role, "DOCUMENTATION");
    assert.equal(reference?.changeType, "MODIFIED");
    assert.equal(
      captured.manifest.exclusions.some(({ path }) => path === "API_NAMES.md"),
      false,
    );

    const packetPath = join(repo, ".review-runs", "packet");
    await writeSnapshotPacketV1(packetPath, captured, request);
    const brief = await buildReviewBrief(packetPath, 64_000);
    assert.equal(
      brief.initialEvidence.some(({ path }) => path === "API_NAMES.md"),
      true,
    );
    assert.deepEqual(brief.schemaVersion === 2 ? brief.referenceEvidence[0]?.roles : [], [
      "REVIEW_TARGET",
      "SUPPORTING_REFERENCE",
    ]);
    assert.equal(
      brief.schemaVersion === 2 ? brief.referenceEvidence[0]?.captureStatus : undefined,
      "CAPTURED",
    );
    assert.match(
      brief.initialEvidence.find(({ path }) => path === "API_NAMES.md")?.content ?? "",
      /calculateTotal[\s\S]*calculateTax/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("records unavailable required BASE reference as blocking coverage", async () => {
  const repo = await repository();
  try {
    await writeFile(join(repo, "prices.ts"), "export const calculateTax = () => 1;\n");
    const request = standardsRequest(repo, "MISSING_NAMES.md");
    const captured = await captureGitSnapshotV1(request);
    const omission = captured.manifest.omissions.find(({ scope }) => scope === "MISSING_NAMES.md");

    assert.equal(omission?.reason, "CAPTURE_FAILED");
    assert.match(omission?.detail ?? "", /required BASE reference/i);

    const packetPath = join(repo, ".review-runs", "packet");
    await writeSnapshotPacketV1(packetPath, captured, request);
    const brief = await buildReviewBrief(packetPath, 64_000);
    assert.equal(
      brief.schemaVersion === 2 ? brief.referenceEvidence[0]?.captureStatus : undefined,
      "OMITTED",
    );
    assert.equal(
      brief.coverageConstraints.some(
        ({ type, detail }) => type === "OMITTED_CONTENT" && detail.includes("MISSING_NAMES.md"),
      ),
      true,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("caller exclusion wins over a required reference and remains visible", async () => {
  const repo = await repository();
  try {
    await writeFile(join(repo, "prices.ts"), "export const calculateTax = () => 1;\n");
    const request = standardsRequest(repo);
    const captured = await captureGitSnapshotV1(request, {
      excludedFileSystemPaths: [join(repo, "API_NAMES.md")],
    });

    assert.equal(captured.manifest.referencedSources.length, 0);
    assert.match(
      captured.manifest.omissions.find(({ scope }) => scope === "API_NAMES.md")?.detail ?? "",
      /caller exclusion/i,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("required reference secret content is never persisted", async () => {
  const repo = await repository();
  try {
    const marker = "AKIAABCDEFGHIJKLMNOP";
    await git(repo, "switch", "main");
    await writeFile(join(repo, "API_NAMES.md"), `- ${marker}\n`);
    await git(repo, "add", "API_NAMES.md");
    await git(repo, "commit", "-m", "secret fixture baseline");
    await git(repo, "switch", "-C", "feature/reference");
    await writeFile(join(repo, "prices.ts"), "export const calculateTax = () => 1;\n");
    const captured = await captureGitSnapshotV1(standardsRequest(repo));

    assert.equal(captured.manifest.referencedSources.length, 0);
    assert.match(
      captured.manifest.omissions.find(({ scope }) => scope === "API_NAMES.md")?.detail ?? "",
      /content policy.*AWS access key id/i,
    );
    assert.equal(
      [...captured.blobs.values()].some((bytes) => Buffer.from(bytes).includes(marker)),
      false,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
