import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";

import {
  buildReviewBrief,
  captureGitSnapshotV1,
  captureReviewerRulesGuidanceV1,
  verifyReviewBriefIdentity,
  writeSnapshotPacketV1,
} from "../../src/index.js";
import { renderUnifiedDiff } from "../../src/transmission/unified-diff.js";

const execFileAsync = promisify(execFile);
const repositories: string[] = [];

async function git(repositoryPath: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", repositoryPath, ...args], { encoding: "utf8" });
}

async function arrangePacket(before: string | null, after: string | null): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "independent-reviewer-brief-"));
  repositories.push(repositoryPath);
  await git(repositoryPath, "init", "--initial-branch=main");
  await git(repositoryPath, "config", "user.name", "Brief Test");
  await git(repositoryPath, "config", "user.email", "brief@example.invalid");
  await git(repositoryPath, "config", "commit.gpgsign", "false");
  if (before === null) {
    await writeFile(join(repositoryPath, "seed.ts"), "export {};\n");
  } else {
    await writeFile(join(repositoryPath, "reviewed.ts"), before);
  }
  await git(repositoryPath, "add", ".");
  await git(repositoryPath, "commit", "-m", "initial");
  await git(repositoryPath, "switch", "-c", "feature/diff-evidence");
  if (after === null) {
    await unlink(join(repositoryPath, "reviewed.ts"));
  } else {
    await writeFile(join(repositoryPath, "reviewed.ts"), after);
  }

  const request = {
    schemaVersion: 1 as const,
    flowId: "flow_diff_evidence",
    reviewInstance: { number: 1, maximum: 3 },
    repository: {
      path: repositoryPath,
      base: "main",
      workingTree: { mode: "CUMULATIVE" as const, includeUntracked: true },
    },
    canonicalInputs: {
      requirements: [
        {
          id: "input_requirement",
          kind: "REQUIREMENTS" as const,
          title: "Requirement",
          content: "Review the changed behavior.",
          provenance: { type: "INLINE" as const, label: "diff evidence test" },
        },
      ],
      implementationPlan: {
        id: "input_plan",
        kind: "IMPLEMENTATION_PLAN" as const,
        title: "Plan",
        content: "Change the reviewed file.",
        provenance: { type: "INLINE" as const, label: "diff evidence test" },
      },
      projectGuidance: [],
    },
    authorPacket: {
      schemaVersion: 1 as const,
      intent: "Change the requested behavior.",
      successCriteria: ["The changed file remains reviewable."],
      planTraceability: [{ planItem: "Change the file.", implementation: "Updated it." }],
      technicalApproach: "Replace one line.",
      componentWalkthrough: [{ component: "reviewed.ts", changes: "Changed one line." }],
      decisions: [],
      invariants: [],
      claimedVerification: [],
      risks: [],
      knownGaps: [],
      challengePoints: [],
    },
    reviewConfigRef: "config_test",
  };
  const packetPath = join(repositoryPath, ".review-runs", "packet");
  await writeSnapshotPacketV1(packetPath, await captureGitSnapshotV1(request), request);
  return packetPath;
}

async function arrangeStandardsPacket(baseRules?: string): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "independent-reviewer-scope-"));
  repositories.push(repositoryPath);
  await git(repositoryPath, "init", "--initial-branch=main");
  await git(repositoryPath, "config", "user.name", "Brief Test");
  await git(repositoryPath, "config", "user.email", "brief@example.invalid");
  await git(repositoryPath, "config", "commit.gpgsign", "false");
  await writeFile(join(repositoryPath, "reviewed.ts"), "export const value = 1;\n");
  await writeFile(join(repositoryPath, "settings.json"), '{"enabled":false}\n');
  if (baseRules !== undefined) {
    await mkdir(join(repositoryPath, ".independent-reviewer"), { recursive: true });
    await writeFile(join(repositoryPath, ".independent-reviewer", "rules.md"), baseRules);
  }
  await git(repositoryPath, "add", ".");
  await git(repositoryPath, "commit", "-m", "initial");
  await git(repositoryPath, "switch", "-c", "feature/scope");
  await writeFile(join(repositoryPath, "reviewed.ts"), "export const value = 2;\n");
  await writeFile(join(repositoryPath, "settings.json"), '{"enabled":true}\n');

  const request = {
    schemaVersion: 2 as const,
    mode: "STANDARDS" as const,
    flowId: "flow_scope_evidence",
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
          title: "TypeScript standard",
          content: JSON.stringify({
            schemaVersion: 1,
            name: "TypeScript standard",
            source: "Test fixture",
            rules: [
              {
                id: "rule_typescript",
                text: "Review TypeScript changes.",
                enforcement: "REQUIRED",
                paths: ["**/*.ts"],
                exceptions: null,
              },
            ],
          }),
          provenance: { type: "INLINE" as const, label: "scope evidence test" },
        },
      ],
    },
    authorPacket: {
      schemaVersion: 2 as const,
      overview: "Change TypeScript and unrelated configuration.",
      claimedVerification: [],
    },
    reviewConfigRef: "config_test",
  };
  const packetPath = join(repositoryPath, ".review-runs", "packet");
  const captured = await captureGitSnapshotV1(request);
  const guidance =
    baseRules === undefined
      ? undefined
      : await captureReviewerRulesGuidanceV1(repositoryPath, captured.manifest);
  await writeSnapshotPacketV1(packetPath, captured, request, guidance ? { guidance } : undefined);
  return packetPath;
}

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("buildReviewBrief diff evidence", () => {
  it("sends a bounded unified hunk with correct BASE and HEAD coordinates", async () => {
    const beforeLines = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`);
    const afterLines = [...beforeLines];
    afterLines[41] = "line 42 changed";
    const packetPath = await arrangePacket(
      `${beforeLines.join("\n")}\n`,
      `${afterLines.join("\n")}\n`,
    );

    const brief = await buildReviewBrief(packetPath, 32_000);

    assert.equal(brief.initialEvidence.length, 1);
    assert.equal(
      brief.initialEvidence[0]?.content,
      [
        "Change: MODIFIED reviewed.ts",
        "Evidence form: UNIFIED_HUNKS",
        "--- BASE/reviewed.ts",
        "+++ HEAD/reviewed.ts",
        "@@ -39,7 +39,7 @@",
        " line 39",
        " line 40",
        " line 41",
        "-line 42",
        "+line 42 changed",
        " line 43",
        " line 44",
        " line 45",
      ].join("\n"),
    );
  });

  it("uses a zero-line BASE coordinate for an added file", async () => {
    const packetPath = await arrangePacket(null, "first\nsecond\n");

    const brief = await buildReviewBrief(packetPath, 32_000);

    assert.equal(
      brief.initialEvidence[0]?.content,
      [
        "Change: UNTRACKED reviewed.ts",
        "Evidence form: WHOLE_FILE",
        "--- BASE/reviewed.ts",
        "+++ HEAD/reviewed.ts",
        "@@ -0,0 +1,2 @@",
        "+first",
        "+second",
      ].join("\n"),
    );
  });

  it("does not transmit a changed path that no selected standard covers", async () => {
    const packetPath = await arrangeStandardsPacket();

    const brief = await buildReviewBrief(packetPath, 32_000);

    assert.deepEqual(
      brief.initialEvidence.map((evidence) => evidence.path),
      ["reviewed.ts"],
    );
    assert.deepEqual(
      brief.coverageConstraints.filter((constraint) => constraint.type === "OUT_OF_SCOPE"),
      [
        {
          type: "OUT_OF_SCOPE",
          detail: "No selected standard applies to this changed path.",
          paths: ["settings.json"],
        },
      ],
    );
  });

  it("binds whole BASE reviewer guidance and exact provenance into a v3 brief", async () => {
    const rules = "# Hard stops\n\nNever silently fall back. 😀\n";
    const packetPath = await arrangeStandardsPacket(rules);

    const brief = await buildReviewBrief(packetPath, 32_000);

    assert.equal(brief.schemaVersion, 3);
    if (brief.schemaVersion !== 3) throw new Error("Expected guidance-capable standards brief.");
    assert.equal(brief.guidanceGraph.graphId.startsWith("guidance_"), true);
    assert.equal(
      brief.guidanceGraph.guidanceGraphDigest.value,
      brief.guidanceGraph.graphId.slice("guidance_".length),
    );
    const presentation = JSON.parse(brief.guidancePresentation);
    assert.equal(presentation.schemaVersion, 1);
    assert.equal(presentation.sources.length, 1);
    assert.equal(presentation.sources[0].path, ".independent-reviewer/rules.md");
    assert.equal(presentation.sources[0].semanticTier, "REVIEWER_SPECIFIC");
    assert.equal(presentation.sources[0].content, rules);
    assert.deepEqual(presentation.sources[0].sourceRange, {
      coordinateUnit: "UTF16_CODE_UNIT",
      startOffset: 0,
      endOffsetExclusive: rules.length,
    });
    assert.deepEqual(
      presentation.sources[0].applicableTargets.map(
        (target: { path: string; side: string; role: string }) => ({
          path: target.path,
          side: target.side,
          role: target.role,
        }),
      ),
      [
        { path: "reviewed.ts", side: "HEAD", role: "PRIMARY" },
        { path: "settings.json", side: "HEAD", role: "PRIMARY" },
      ],
    );
    assert.equal(verifyReviewBriefIdentity(brief), true);
    assert.equal(
      verifyReviewBriefIdentity({
        ...brief,
        guidancePresentation: `${brief.guidancePresentation} `,
      }),
      false,
    );
  });
});

describe("renderUnifiedDiff", () => {
  it("preserves a line-ending-only change as review evidence", async () => {
    const rendered = await renderUnifiedDiff("value\r\n", "value\n", "reviewed.ts", "reviewed.ts");

    assert.match(rendered.content, /-value\r\n\+value/);
  });

  it("keeps many sparse edits bounded instead of degrading to a whole-file replacement", async () => {
    const changedLines = new Set(Array.from({ length: 264 }, (_, index) => index * 75));
    const before = Array.from({ length: 20_000 }, (_, index) => `line ${index + 1}`);
    const after = before.map((line, index) =>
      changedLines.has(index) ? `changed ${index + 1}` : line,
    );

    const rendered = await renderUnifiedDiff(
      `${before.join("\n")}\n`,
      `${after.join("\n")}\n`,
      "reviewed.ts",
      "reviewed.ts",
    );

    assert.equal(rendered.form, "UNIFIED_HUNKS");
    assert.ok(Buffer.byteLength(rendered.content, "utf8") < 350_000);
    assert.ok((rendered.content.match(/^@@ /gm) ?? []).length > 100);
  });

  it("keeps separated changes in separate three-line-context hunks", async () => {
    const before = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
    const after = [...before];
    after[9] = "line 10 changed";
    after[89] = "line 90 changed";

    const rendered = await renderUnifiedDiff(
      `${before.join("\n")}\n`,
      `${after.join("\n")}\n`,
      "reviewed.ts",
      "reviewed.ts",
    );

    assert.equal(rendered.form, "UNIFIED_HUNKS");
    assert.match(rendered.content, /@@ -7,7 \+7,7 @@/);
    assert.match(rendered.content, /@@ -87,7 \+87,7 @@/);
    assert.doesNotMatch(rendered.content, /line 50/);
  });

  it("uses whole-file evidence for a small changed file", async () => {
    const rendered = await renderUnifiedDiff(
      "first\nsecond\nthird\n",
      "first\nchanged\nthird\n",
      "reviewed.ts",
      "reviewed.ts",
    );

    assert.equal(rendered.form, "WHOLE_FILE");
    assert.match(rendered.content, /@@ -1,3 \+1,3 @@/);
    assert.match(rendered.content, / first\n-second\n\+changed\n third/);
  });

  it("uses whole-file evidence when most lines changed", async () => {
    const before = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
    const after = before.map((line, index) => (index < 20 ? line : `changed ${index + 1}`));

    const rendered = await renderUnifiedDiff(
      `${before.join("\n")}\n`,
      `${after.join("\n")}\n`,
      "reviewed.ts",
      "reviewed.ts",
    );

    assert.equal(rendered.form, "WHOLE_FILE");
    assert.match(rendered.content, /@@ -1,60 \+1,60 @@/);
    assert.match(rendered.content, / line 1/);
    assert.match(rendered.content, /\+changed 60/);
  });

  it("preserves a missing-final-newline change", async () => {
    const rendered = await renderUnifiedDiff(
      "first\nlast",
      "first\nlast\n",
      "reviewed.ts",
      "reviewed.ts",
    );

    assert.match(rendered.content, /-last\n\\ No newline at end of file\n\+last/);
  });

  it("uses whole-file evidence for highly divergent files", async () => {
    const before = Array.from({ length: 400 }, (_, index) => `before ${index + 1}`);
    const after = Array.from({ length: 400 }, (_, index) => `after ${index + 1}`);

    const rendered = await renderUnifiedDiff(
      `${before.join("\n")}\n`,
      `${after.join("\n")}\n`,
      "reviewed.ts",
      "reviewed.ts",
    );

    assert.equal(rendered.form, "WHOLE_FILE");
    assert.match(rendered.content, /@@ -1,400 \+1,400 @@/);
    assert.match(rendered.content, /-before 400/);
    assert.match(rendered.content, /\+after 400/);
  });
});
