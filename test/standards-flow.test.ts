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

for (const invalidRule of [false, true])
  test(`standards CLI preserves blind assessment and ${invalidRule ? "rejects unknown rules" : "renders mandatory findings"}`, async () => {
    const f = await fixture();
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
          severity: "REQUIRED",
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
              canonicalInputId: "input_standard",
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
            findings: [{ id: "finding_name", ...finding }],
            evidenceGaps: [],
            limitations: [],
            nextAction: "REQUEST_AUTHOR_PACKET",
          };
        } else {
          assert.match(request.messages.at(-1)!.content, /AUTHOR_PRIVATE/);
          const saved = JSON.parse(
            await readFile(join(f.packet, "review", "preliminary.json"), "utf8"),
          );
          assert.equal(saved.findings[0].id, "finding_name");
          value = {
            ...common,
            stage: "FINAL",
            mode: "STANDARDS",
            findings: [
              {
                ...finding,
                sourceFindingIds: ["finding_name"],
                reconciliationRationale: "Preference does not establish a permitted exception.",
              },
            ],
            withdrawnPreliminaryFindings: [],
            preliminaryConcernDispositions: [],
            authorClaims: [],
            authorVerificationClaims: [],
            changedPathCoverage: [
              { path: "code.ts", status: "INSPECTED", explanation: "Reviewed frozen code." },
            ],
            limitations: [],
            verdict: "NOT_READY",
            nextActions: { blockers: ["Use a descriptive name."], fastFollows: [] },
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
      const result = await runCliV1(
        ["review", "--request", f.requestPath, "--config", f.configPath, "--output", f.packet],
        { stdout: (m) => output.push(m), stderr: (m) => errors.push(m) },
        { readOpenRouterApiKey: () => "test", createProvider: () => provider },
      );
      assert.equal(result, invalidRule ? 1 : 2, errors.join("\n"));
      assert.equal(calls, invalidRule ? 1 : 2, errors.join("\n"));
      if (invalidRule) assert.match(errors.join("\n"), /Unknown standard rule/);
      else {
        assert.match(output.join("\n"), /Standards review: changes requested/);
        const report = JSON.parse(await readFile(join(f.packet, "review", "final.json"), "utf8"));
        assert.equal(report.mode, "STANDARDS");
        assert.equal(report.findings[0].ruleIds[0], "rule_names");
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
