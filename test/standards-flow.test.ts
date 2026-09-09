import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runCliV1 } from "../src/cli.js";
import type { ReviewProviderV1 } from "../src/provider/review-provider.js";
import { inspectSnapshotPacket } from "../src/snapshot/snapshot-packet.js";

const exec = promisify(execFile);
const digest = { algorithm: "SHA256" as const, value: "a".repeat(64) };

async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), "standards-flow-"));
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args]);
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await writeFile(join(repo, "code.ts"), "export const value = 1;\n");
  await writeFile(join(repo, ".gitignore"), ".review-runs/\n");
  await git("add", ".");
  await git("commit", "-m", "base");
  await writeFile(join(repo, "code.ts"), "export const v = 1;\n");
  const rules = {
    schemaVersion: 1,
    name: "Naming",
    source: "Project standard",
    rules: [
      {
        id: "rule_names",
        text: "Exported constants must have descriptive names.",
        enforcement: "REQUIRED",
        paths: ["**/*.ts"],
        exceptions: null,
      },
    ],
  };
  const request = {
    schemaVersion: 2,
    mode: "STANDARDS",
    flowId: "flow_test",
    reviewInstance: { number: 1, maximum: 3 },
    repository: { path: repo, base: "main" },
    canonicalInputs: {
      standards: [
        {
          id: "input_standard",
          kind: "PROJECT_GUIDANCE",
          title: "Naming",
          content: JSON.stringify(rules),
          provenance: { type: "INLINE", label: "Project standard" },
        },
      ],
    },
    authorPacket: {
      schemaVersion: 2,
      overview: "AUTHOR_PRIVATE: short names are my preference.",
      claimedVerification: [],
    },
    reviewConfigRef: "config_test",
  };
  const config = {
    schemaVersion: 2,
    configId: "config_test",
    model: "mock/reviewer",
    providerRouting: {
      order: ["test/fp4"],
      maxPrice: { prompt: 0.03, completion: 0.14, request: 0 },
    },
    budgets: {
      maxInitialEvidenceBytes: 32000,
      maxConversationBytes: 200000,
      maxOutputTokensPerCall: 2000,
      maxTotalTokens: 300000,
      maxTotalCostUsd: 1,
      timeoutMs: 10000,
    },
  };
  const requestPath = join(repo, "request.json");
  const configPath = join(repo, "config.json");
  await writeFile(requestPath, JSON.stringify(request));
  await writeFile(configPath, JSON.stringify(config));
  return { repo, requestPath, configPath, packet: join(repo, ".review-runs", "run") };
}

for (const scenario of [
  "required",
  "unknown",
  "clean",
  "exception",
  "recommended",
  "unavailable",
  "inapplicable",
  "conflict",
])
  test(`standards CLI protocol: ${scenario}`, async () => {
    const invalidRule = scenario === "unknown";
    const noFindings = scenario === "clean" || scenario === "unavailable";
    const removed = noFindings || scenario === "exception";
    const expectedExit = ["unknown", "inapplicable", "conflict"].includes(scenario)
      ? 1
      : scenario === "unavailable"
        ? 3
        : scenario === "required"
          ? 2
          : 0;
    const f = await fixture();
    const fixtureRequest = JSON.parse(await readFile(f.requestPath, "utf8"));
    const profile = JSON.parse(fixtureRequest.canonicalInputs.standards[0].content);
    if (scenario === "recommended") profile.rules[0].enforcement = "RECOMMENDED";
    if (scenario === "exception") {
      profile.rules[0].exceptions = "Keep names required by an established public API.";
      fixtureRequest.authorPacket.overview += " This exported name is fixed by the public API.";
    }
    if (scenario === "inapplicable") profile.rules[0].paths = ["lib/**"];
    if (scenario === "conflict")
      profile.rules.push({ ...profile.rules[0], text: "Use short names." });
    fixtureRequest.canonicalInputs.standards[0].content = JSON.stringify(profile);
    await writeFile(f.requestPath, JSON.stringify(fixtureRequest));
    if (scenario === "clean") await writeFile(join(f.repo, "code.ts"), "export const value = 2;\n");
    const output: string[] = [];
    const errors: string[] = [];
    let calls = 0;
    const provider: ReviewProviderV1 = {
      auditRequest: () => ({
        providerPolicyVersion: "test",
        wireBodyDigest: digest,
        wireBodyBytes: 1,
        credentialFreeWireRequestDigest: digest,
      }),
      async complete(request) {
        calls++;
        const brief = JSON.parse(request.messages[1]!.content);
        const evidence = [
          {
            path: "code.ts",
            anchor: "LINE_RANGE",
            side: "HEAD",
            startLine: 1,
            endLine: 1,
            detail: "Export v",
          },
        ];
        const finding = {
          ruleIds: [invalidRule ? "rule_unknown" : "rule_names"],
          severity: scenario === "recommended" ? "RECOMMENDED" : "REQUIRED",
          title: "Describe the exported constant",
          problem: "The public name v does not convey its purpose.",
          impact: "Callers must inspect implementation to understand the value.",
          correction: "Use a descriptive exported name.",
          evidence,
        };
        const common = {
          schemaVersion: 2,
          snapshotDigest: brief.snapshotManifest.snapshotDigest,
          briefDigest: brief.briefDigest,
          summary: "Naming review",
          canonicalInputCoverage: [
            {
              canonicalInputId: brief.canonicalInputs.standards[0].id,
              status: "ASSESSED",
              explanation: "Applied naming rule.",
            },
          ],
        };
        let value: unknown;
        if (request.stage === "PRELIMINARY") {
          assert.doesNotMatch(JSON.stringify(request.messages), /AUTHOR_PRIVATE/);
          assert.equal(brief.mode, "STANDARDS");
          assert.equal(brief.canonicalInputs.requirements, undefined);
          value = {
            ...common,
            stage: "PRELIMINARY",
            inspectedPaths: ["code.ts"],
            findings: noFindings ? [] : [{ id: "finding_name", ...finding }],
            evidenceGaps: [],
            limitations: [],
            nextAction: "REQUEST_AUTHOR_PACKET",
          };
        } else {
          assert.match(request.messages.at(-1)!.content, /AUTHOR_PRIVATE/);
          const saved = JSON.parse(
            await readFile(join(f.packet, "review", "preliminary.json"), "utf8"),
          );
          assert.equal(saved.findings.length, noFindings ? 0 : 1);
          value = {
            ...common,
            stage: "FINAL",
            mode: "STANDARDS",
            findings: removed
              ? []
              : [
                  {
                    ...finding,
                    sourceFindingIds: ["finding_name"],
                    reconciliationRationale: "Preference does not establish a permitted exception.",
                  },
                ],
            withdrawnPreliminaryFindings:
              scenario === "exception"
                ? [
                    {
                      preliminaryFindingId: "finding_name",
                      rationale: "Selected exception applies to the established API.",
                    },
                  ]
                : [],
            preliminaryConcernDispositions: [],
            authorClaims: [],
            authorVerificationClaims: [],
            changedPathCoverage: [
              { path: "code.ts", status: "INSPECTED", explanation: "Reviewed frozen code." },
            ],
            limitations:
              scenario === "unavailable" ? ["Required surrounding context is unavailable."] : [],
            verdict:
              scenario === "unavailable"
                ? "UNABLE_TO_VERIFY"
                : scenario === "recommended"
                  ? "READY_WITH_FOLLOW_UPS"
                  : removed
                    ? "READY"
                    : "NOT_READY",
            nextActions: {
              blockers: scenario === "required" ? ["Use a descriptive name."] : [],
              fastFollows: scenario === "recommended" ? ["Consider a descriptive name."] : [],
            },
          };
        }
        return {
          value,
          rawContent: JSON.stringify(value),
          responseId: "test",
          model: request.model,
          provider: "test/fp4",
          usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200, cost: 0.00001 },
        };
      },
    };
    try {
      let args = ["review", "--request", f.requestPath];
      if (scenario === "required") {
        const standardsPath = join(f.repo, "standards.json");
        const authorPath = join(f.repo, "author.md");
        await writeFile(standardsPath, JSON.stringify(profile));
        await writeFile(authorPath, fixtureRequest.authorPacket.overview);
        await rm(f.requestPath);
        args = [
          "review",
          "--repo",
          f.repo,
          "--base",
          "main",
          "--standards",
          standardsPath,
          "--author",
          authorPath,
        ];
      }
      const result = await runCliV1(
        [...args, "--config", f.configPath, "--output", f.packet],
        { stdout: (m) => output.push(m), stderr: (m) => errors.push(m) },
        { readOpenRouterApiKey: () => "test", createProvider: () => provider },
      );
      assert.equal(result, expectedExit, errors.join("\n"));
      assert.equal(
        calls,
        scenario === "conflict" ? 0 : ["unknown", "inapplicable"].includes(scenario) ? 1 : 2,
        errors.join("\n"),
      );
      if (invalidRule) assert.match(errors.join("\n"), /Unknown standard rule/);
      else if (expectedExit !== 1) {
        assert.match(output.join("\n"), /Standards/);
        const report = JSON.parse(await readFile(join(f.packet, "review", "final.json"), "utf8"));
        assert.equal(report.mode, "STANDARDS");
        assert.equal(report.findings.length, removed ? 0 : 1);
        if (!removed) assert.equal(report.findings[0].ruleIds[0], "rule_names");
        const markdown = await readFile(join(f.packet, "review", "report.md"), "utf8");
        assert.match(markdown, /Project standard/);
        const authorPath = join(f.packet, "author-packet.json");
        const author = JSON.parse(await readFile(authorPath, "utf8"));
        author.overview = "Tampered";
        await writeFile(authorPath, JSON.stringify(author));
        await assert.rejects(inspectSnapshotPacket(f.packet), /Author overview digest/);
      }
    } finally {
      await rm(f.repo, { recursive: true, force: true });
    }
  });

test("standards convenience dry-run needs no credentials or provider and leaves no review run", async () => {
  const f = await fixture();
  const output: string[] = [];
  const errors: string[] = [];
  try {
    const request = JSON.parse(await readFile(f.requestPath, "utf8"));
    const profilePath = join(f.repo, "standards.json");
    const overviewPath = join(f.repo, "author.md");
    await writeFile(profilePath, request.canonicalInputs.standards[0].content);
    await writeFile(overviewPath, request.authorPacket.overview);
    const result = await runCliV1(
      [
        "review",
        "--repo",
        f.repo,
        "--base",
        "main",
        "--standards",
        profilePath,
        "--author",
        overviewPath,
        "--config",
        f.configPath,
        "--dry-run",
      ],
      { stdout: (m) => output.push(m), stderr: (m) => errors.push(m) },
      {
        readOpenRouterApiKey: () => {
          throw new Error("dry-run read credential");
        },
        createProvider: () => {
          throw new Error("dry-run created provider");
        },
      },
    );
    assert.equal(result, 0, errors.join("\n"));
    assert.match(output.join("\n"), /Reserved tokens/);
    assert.doesNotMatch(output.join("\n"), /AUTHOR_PRIVATE/);
    await assert.rejects(readFile(join(f.packet, "review", "final.json")));
  } finally {
    await rm(f.repo, { recursive: true, force: true });
  }
});

test("saved settings never overwrite silently and direct inputs enforce three exclusive instance claims", async () => {
  const f = await fixture();
  try {
    const { assembleStandardsRequest, localReviewDirectory } = await import(
      "../src/cli/standards-input.js"
    );
    const request = JSON.parse(await readFile(f.requestPath, "utf8"));
    const standardPath = join(f.repo, "standards.json");
    const authorPath = join(f.repo, "author.md");
    await writeFile(standardPath, request.canonicalInputs.standards[0].content);
    await writeFile(authorPath, request.authorPacket.overview);
    const errors: string[] = [];
    const io = { stdout: (_: string) => {}, stderr: (s: string) => errors.push(s) };
    const init = [
      "init",
      "--repo",
      f.repo,
      "--config",
      f.configPath,
      "--standards",
      standardPath,
      "--author",
      authorPath,
    ];
    assert.equal(await runCliV1(init, io), 0);
    assert.equal(await runCliV1(init, io), 1);
    assert.match(errors.join("\n"), /Settings already exist/);
    const options = new Map<string, string | true>([
      ["--repo", f.repo],
      ["--config", f.configPath],
      ["--standards", standardPath],
      ["--author", authorPath],
    ]);
    const first = await assembleStandardsRequest(options);
    await first.claim();
    const second = await assembleStandardsRequest(options);
    const concurrent = await assembleStandardsRequest(options);
    assert.equal(second.request.reviewInstance.number, 2);
    await second.claim();
    await assert.rejects(concurrent.claim(), /EEXIST/);
    const third = await assembleStandardsRequest(options);
    assert.equal(third.request.reviewInstance.number, 3);
    await third.claim();
    await assert.rejects(assembleStandardsRequest(options), /all three instances/);
    const next = await assembleStandardsRequest(new Map([...options, ["--new-flow", true]]));
    assert.notEqual(next.request.flowId, first.request.flowId);
    assert.equal(next.request.reviewInstance.number, 1);
    assert.match(await localReviewDirectory(f.repo), /\.git/);
  } finally {
    await rm(f.repo, { recursive: true, force: true });
  }
});
