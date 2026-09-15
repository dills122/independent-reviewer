import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  buildGuidanceGraphV1,
  buildReviewBrief,
  captureGitSnapshotV1,
  captureRepositoryGuidanceV1,
  captureReviewerRulesGuidanceV1,
  guidanceGraphDigestV1,
  ProviderCallError,
  preflightReview,
  type ReviewProviderV1,
  type ReviewRunConfigV3,
  resumeFinalReview,
  runTwoStageReview,
  sha256Utf8,
  writeSnapshotPacketV1,
} from "../../src/index.js";

const execFileAsync = promisify(execFile);
const auditDigest = { algorithm: "SHA256" as const, value: "a".repeat(64) };

async function git(repositoryPath: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", repositoryPath, ...args], { encoding: "utf8" });
}

async function arrangeGuidancePacket(
  rules?: string,
  withImport = false,
  targetCount = 1,
  withRichProvenance = false,
): Promise<{
  repositoryPath: string;
  packetPath: string;
}> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "independent-reviewer-guidance-run-"));
  await git(repositoryPath, "init", "--initial-branch=main");
  await git(repositoryPath, "config", "user.name", "Guidance Run Test");
  await git(repositoryPath, "config", "user.email", "guidance@example.invalid");
  await git(repositoryPath, "config", "commit.gpgsign", "false");
  if (rules !== undefined) {
    await mkdir(join(repositoryPath, ".independent-reviewer"), { recursive: true });
    await writeFile(join(repositoryPath, ".independent-reviewer", "rules.md"), rules);
  }
  if (withImport) {
    await mkdir(join(repositoryPath, ".kiro", "steering"), { recursive: true });
    await mkdir(join(repositoryPath, "docs"), { recursive: true });
    await writeFile(
      join(repositoryPath, ".kiro", "steering", "main.md"),
      "# Main\n\n#[[file:../../docs/expected.md]]\n",
    );
    await writeFile(join(repositoryPath, "docs", "expected.md"), "# Expected guidance\n");
    await writeFile(join(repositoryPath, "docs", "attacker.md"), "# Redirected guidance\n");
    if (withRichProvenance) {
      await mkdir(join(repositoryPath, ".github"), { recursive: true });
      await writeFile(
        join(repositoryPath, ".github", "copilot-instructions.md"),
        "# Copilot guidance\n",
      );
      await writeFile(
        join(repositoryPath, ".kiro", "steering", "scoped.md"),
        "---\ninclusion: fileMatch\nfileMatchPattern: reviewed-001.ts\n---\n# Scoped guidance\n",
      );
    }
  }
  const targetPaths = Array.from({ length: targetCount }, (_, index) =>
    targetCount === 1 ? "reviewed.ts" : `reviewed-${String(index + 1).padStart(3, "0")}.ts`,
  );
  await Promise.all(
    targetPaths.map((path) => writeFile(join(repositoryPath, path), "export const value = 1;\n")),
  );
  await git(repositoryPath, "add", ".");
  await git(repositoryPath, "commit", "-m", "initial");
  await git(repositoryPath, "switch", "-c", "feature/guidance");
  await Promise.all(
    targetPaths.map((path) => writeFile(join(repositoryPath, path), "export const value = 2;\n")),
  );

  const profile = {
    schemaVersion: 1,
    name: "TypeScript review",
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
  };
  const request = {
    schemaVersion: 2 as const,
    mode: "STANDARDS" as const,
    flowId: "flow_guidance_run",
    reviewInstance: { number: 1, maximum: 3 },
    repository: { path: repositoryPath, base: "main" },
    canonicalInputs: {
      standards: [
        {
          id: "input_standard",
          kind: "PROJECT_GUIDANCE" as const,
          title: profile.name,
          content: JSON.stringify(profile),
          provenance: { type: "INLINE" as const, label: "guidance run test" },
        },
      ],
    },
    authorPacket: {
      schemaVersion: 2 as const,
      overview: "AUTHOR_ONLY: changed the value intentionally.",
      claimedVerification: [],
    },
    reviewConfigRef: "config_guidance_run",
  };
  const captured = await captureGitSnapshotV1(request);
  const guidance = withImport
    ? await captureRepositoryGuidanceV1(repositoryPath, captured.manifest)
    : await captureReviewerRulesGuidanceV1(repositoryPath, captured.manifest);
  const packetPath = join(repositoryPath, ".review-runs", "packet");
  await writeSnapshotPacketV1(packetPath, captured, request, { guidance });
  return { repositoryPath, packetPath };
}

async function redirectPersistedImport(packetPath: string): Promise<void> {
  const graph = JSON.parse(await readFile(join(packetPath, "guidance-graph.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(packetPath, "snapshot-manifest.json"), "utf8"));
  const importer = graph.nodes.find(
    ({ resolvedPath }: { resolvedPath: string }) => resolvedPath === ".kiro/steering/main.md",
  );
  const occurrence = graph.occurrences.find(
    ({ familyId }: { familyId: string }) => familyId === "KIRO",
  );
  assert.ok(importer);
  assert.ok(occurrence);
  const attackerContent = "# Redirected guidance\n";
  const attackerDigest = sha256Utf8(attackerContent);
  const redirected = buildGuidanceGraphV1(
    manifest,
    [
      {
        resolvedPath: importer.resolvedPath,
        contentDigest: importer.contentDigest,
        directRecognitions: importer.directRecognitions,
      },
      {
        resolvedPath: "docs/attacker.md",
        contentDigest: attackerDigest,
        directRecognitions: [],
      },
    ],
    [
      {
        familyId: "KIRO",
        syntaxKind: "KIRO_FILE_REFERENCE",
        importerPath: importer.resolvedPath,
        importerContentDigest: importer.contentDigest,
        importedPath: "docs/attacker.md",
        importedContentDigest: attackerDigest,
        requestedSpecifier: occurrence.requestedSpecifier,
        startUtf16: occurrence.startUtf16,
        endUtf16: occurrence.endUtf16,
        applicableTargetIds: graph.edges
          .filter(
            ({ occurrenceId }: { occurrenceId: string }) =>
              occurrenceId === occurrence.occurrenceId,
          )
          .map(({ applicableTargetId }: { applicableTargetId: string }) => applicableTargetId),
      },
    ],
  );
  await writeFile(join(packetPath, "guidance-graph.json"), `${JSON.stringify(redirected)}\n`);
  await writeFile(join(packetPath, "blobs", attackerDigest.value), attackerContent);
  const metadataPath = join(packetPath, "packet-metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.guidanceGraphDigest = guidanceGraphDigestV1(redirected);
  await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
}

const config: ReviewRunConfigV3 = {
  schemaVersion: 3,
  configId: "config_guidance_run",
  model: "mock/reviewer",
  fallbackModels: [],
  providerRouting: {
    order: ["mock/fp4"],
    pinToOrder: false,
    zeroDataRetention: false,
    denyDataCollection: false,
    maxPrice: { prompt: 0.1, completion: 0.2, request: 0 },
  },
  budgets: {
    maxInitialEvidenceBytes: 32_000,
    maxConversationBytes: 256_000,
    maxOutputTokensPerCall: 1_000,
    maxTotalTokens: 100_000,
    maxTotalCostUsd: 1,
    timeoutMs: 10_000,
    maxAttemptsPerCall: 2,
    minimumCallIntervalMs: 0,
  },
};

test("compacts reviewer-rule provenance across small and large target sets", async () => {
  const rules = "# Reviewer rules\n\nPrefer small functions.\n";
  assert.equal(Buffer.byteLength(rules, "utf8"), 42);
  const cases = [
    { targetCount: 13, presentationCeiling: 3_200, wireCeiling: 5_000 },
    { targetCount: 121, presentationCeiling: 20_000, wireCeiling: 30_000 },
  ] as const;

  for (const testCase of cases) {
    const { repositoryPath, packetPath } = await arrangeGuidancePacket(
      rules,
      false,
      testCase.targetCount,
    );
    try {
      const brief = await buildReviewBrief(packetPath, 128_000);
      assert.equal(brief.schemaVersion, 3);
      if (brief.schemaVersion !== 3) throw new Error("Expected guidance-capable standards brief.");
      const presentationText = brief.guidancePresentation;
      const presentation = JSON.parse(presentationText);
      assert.equal(presentation.schemaVersion, 2);
      assert.equal(presentation.sources.length, 1);
      const [source] = presentation.sources;
      assert.equal(source.applicableTargets.length, testCase.targetCount);
      assert.equal(source.directRecognitionGroups.length, 1);
      assert.deepEqual(
        source.directRecognitionGroups[0].applicableTargetIndexes,
        Array.from({ length: testCase.targetCount }, (_, index) => index),
      );
      for (const { targetId } of source.applicableTargets) {
        assert.equal(presentationText.split(targetId).length - 1, 1);
      }
      assert.ok(
        Buffer.byteLength(presentationText, "utf8") <= testCase.presentationCeiling,
        `${testCase.targetCount}-target presentation exceeded ${testCase.presentationCeiling} bytes`,
      );

      const admission = await preflightReview(packetPath, {
        ...config,
        budgets: {
          ...config.budgets,
          maxInitialEvidenceBytes: 128_000,
          maxConversationBytes: 600_000,
          maxTotalTokens: 1_000_000,
        },
      });
      assert.ok(admission.guidanceAdmission);
      const wireBytesByStage = admission.guidanceAdmission.wireBytesByStage;
      assert.deepEqual(Object.keys(wireBytesByStage).sort(), [
        "final",
        "findingVerification",
        "preliminary",
      ]);
      for (const wireBytes of Object.values(wireBytesByStage)) {
        assert.equal(Number.isSafeInteger(wireBytes), true);
        assert.ok(wireBytes >= Buffer.byteLength(presentationText, "utf8"));
        assert.ok(
          wireBytes <= testCase.wireCeiling,
          `${testCase.targetCount}-target provider-message delta ${wireBytes} exceeded ${testCase.wireCeiling} bytes`,
        );
      }
      assert.equal(wireBytesByStage.preliminary, wireBytesByStage.final);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  }
});

test("preserves exact direct and imported provenance through compact target indexes", async () => {
  const { repositoryPath, packetPath } = await arrangeGuidancePacket(undefined, true, 3, true);
  try {
    const graph = JSON.parse(await readFile(join(packetPath, "guidance-graph.json"), "utf8"));
    const brief = await buildReviewBrief(packetPath, 128_000, repositoryPath);
    assert.equal(brief.schemaVersion, 3);
    if (brief.schemaVersion !== 3) throw new Error("Expected guidance-capable standards brief.");
    const presentation = JSON.parse(brief.guidancePresentation);

    const expectedDirect = graph.nodes
      .flatMap((node: { sourceId: string; directRecognitions: Record<string, unknown>[] }) =>
        node.directRecognitions.map((recognition) => ({ sourceId: node.sourceId, ...recognition })),
      )
      .map((entry: unknown) => JSON.stringify(entry))
      .sort();
    const presentedDirect = presentation.sources
      .flatMap(
        (source: {
          sourceId: string;
          applicableTargets: { targetId: string }[];
          directRecognitionGroups: {
            familyId: string;
            sourceKind: string;
            nativeOrder: number;
            discoveredPath: string;
            applicableTargetIndexes: number[];
          }[];
        }) =>
          source.directRecognitionGroups.flatMap((group) =>
            group.applicableTargetIndexes.map((targetIndex) => ({
              sourceId: source.sourceId,
              familyId: group.familyId,
              sourceKind: group.sourceKind,
              nativeOrder: group.nativeOrder,
              applicableTargetId: source.applicableTargets[targetIndex]?.targetId,
              discoveredPath: group.discoveredPath,
            })),
          ),
      )
      .map((entry: unknown) => JSON.stringify(entry))
      .sort();
    assert.deepEqual(presentedDirect, expectedDirect);
    assert.ok(new Set(presentedDirect.map((entry: string) => JSON.parse(entry).familyId)).size > 1);

    const occurrences = new Map(
      graph.occurrences.map((occurrence: { occurrenceId: string }) => [
        occurrence.occurrenceId,
        occurrence,
      ]),
    );
    const expectedImports = graph.edges
      .map(
        (edge: {
          edgeId: string;
          occurrenceId: string;
          importedSourceId: string;
          applicableTargetId: string;
        }) => ({
          importedSourceId: edge.importedSourceId,
          edgeId: edge.edgeId,
          ...(occurrences.get(edge.occurrenceId) as Record<string, unknown>),
          applicableTargetId: edge.applicableTargetId,
        }),
      )
      .map((entry: unknown) => JSON.stringify(entry))
      .sort();
    const presentedImports = presentation.sources
      .flatMap(
        (source: {
          sourceId: string;
          applicableTargets: { targetId: string }[];
          inboundImportGroups: {
            occurrenceId: string;
            familyId: string;
            syntaxKind: string;
            importerSourceId: string;
            requestedSpecifier: string;
            startUtf16: number;
            endUtf16: number;
            edges: { edgeId: string; applicableTargetIndex: number }[];
          }[];
        }) =>
          source.inboundImportGroups.flatMap((group) =>
            group.edges.map((edge) => ({
              importedSourceId: source.sourceId,
              edgeId: edge.edgeId,
              occurrenceId: group.occurrenceId,
              familyId: group.familyId,
              syntaxKind: group.syntaxKind,
              importerSourceId: group.importerSourceId,
              requestedSpecifier: group.requestedSpecifier,
              startUtf16: group.startUtf16,
              endUtf16: group.endUtf16,
              applicableTargetId: source.applicableTargets[edge.applicableTargetIndex]?.targetId,
            })),
          ),
      )
      .map((entry: unknown) => JSON.stringify(entry))
      .sort();
    assert.deepEqual(presentedImports, expectedImports);
    assert.ok(presentedImports.length > 0);
    for (const source of presentation.sources) {
      const sourceText = JSON.stringify(source);
      for (const { targetId } of source.applicableTargets) {
        assert.equal(sourceText.split(targetId).length - 1, 1);
      }
    }
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

function preliminaryFor(request: Parameters<ReviewProviderV1["complete"]>[0]) {
  const brief = JSON.parse(request.messages[1]?.content ?? "{}");
  return {
    value: {
      schemaVersion: 2 as const,
      stage: "PRELIMINARY" as const,
      snapshotDigest: brief.snapshotManifest.snapshotDigest,
      briefDigest: brief.briefDigest,
      summary: "Guidance-aware review completed.",
      inspectedPaths: ["reviewed.ts"],
      canonicalInputCoverage: [
        {
          canonicalInputId: "input_standard",
          status: "ASSESSED" as const,
          explanation: "Applied the selected standard.",
        },
      ],
      ruleAssessments: [
        {
          ruleId: "rule_typescript",
          status: "ASSESSED" as const,
          conflictingRuleIds: [],
          explanation: "Reviewed the selected rule and repository guidance.",
        },
      ],
      findings: [],
      evidenceGaps: [],
      limitations: [],
      nextAction: "REQUEST_AUTHOR_PACKET" as const,
    },
    rawContent: "{}",
    responseId: "mock-preliminary",
    model: "mock/reviewer",
    provider: "mock/fp4",
    usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, cost: null },
  };
}

test("provider entry rejects a self-consistent redirected import before any call", async () => {
  const { repositoryPath, packetPath } = await arrangeGuidancePacket(undefined, true);
  let calls = 0;
  const provider: ReviewProviderV1 = {
    auditRequest: () => ({
      providerPolicyVersion: "mock-v1",
      wireBodyDigest: auditDigest,
      wireBodyBytes: 1,
      credentialFreeWireRequestDigest: auditDigest,
    }),
    complete: async () => {
      calls += 1;
      throw new Error("Provider must not be called.");
    },
  };
  try {
    await assert.rejects(
      () => runTwoStageReview(packetPath, config, provider),
      /trusted repository path.*frozen BASE/i,
    );
    assert.equal(calls, 0);
    await redirectPersistedImport(packetPath);
    await assert.rejects(
      () => runTwoStageReview(packetPath, config, provider, repositoryPath),
      /invalid resolved destination/i,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("final resume rejects a replaced import before any resumed call", async () => {
  const { repositoryPath, packetPath } = await arrangeGuidancePacket(undefined, true);
  const initialProvider: ReviewProviderV1 = {
    auditRequest: (request) => ({
      providerPolicyVersion: "mock-v1",
      wireBodyDigest: auditDigest,
      wireBodyBytes: Buffer.byteLength(JSON.stringify(request), "utf8"),
      credentialFreeWireRequestDigest: auditDigest,
    }),
    complete: async (request) => {
      if (request.stage === "PRELIMINARY") return preliminaryFor(request);
      throw new ProviderCallError("PROVIDER_ERROR", "OpenRouter rate limit exceeded.", {
        diagnostic: {
          httpStatus: 429,
          providerErrorCode: "429",
          providerMessage: "Rate limit exceeded",
          errorType: "rate_limit_exceeded",
          providerCode: "rate_limited",
          providerName: "Mock Provider",
          model: "mock/reviewer",
          responseId: null,
          retryAfter: "45",
        },
      });
    },
  };
  let resumedCalls = 0;
  const resumedProvider: ReviewProviderV1 = {
    auditRequest: initialProvider.auditRequest,
    complete: async () => {
      resumedCalls += 1;
      throw new Error("Provider must not be called.");
    },
  };
  try {
    await assert.rejects(
      () => runTwoStageReview(packetPath, config, initialProvider, repositoryPath),
      /rate limit/i,
    );
    const runRecordPath = join(packetPath, "review", "run-record.jsonl");
    const currentRunRecord = await readFile(runRecordPath, "utf8");
    assert.match(currentRunRecord, /"promptVersion":"standards-review-v18"/);
    await writeFile(
      runRecordPath,
      currentRunRecord.replace(
        '"promptVersion":"standards-review-v18"',
        '"promptVersion":"standards-review-v17"',
      ),
    );
    await assert.rejects(
      () => resumeFinalReview(packetPath, config, resumedProvider, repositoryPath),
      /incompatible final response protocol/i,
    );
    assert.equal(resumedCalls, 0);
    await writeFile(runRecordPath, currentRunRecord);
    await redirectPersistedImport(packetPath);
    await assert.rejects(
      () => resumeFinalReview(packetPath, config, resumedProvider, repositoryPath),
      /invalid resolved destination/i,
    );
    assert.equal(resumedCalls, 0);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("guidance-capable run binds prompt identity and withholds author context", async () => {
  const rules = "# Reviewer priority\n\nNever hide a fallback.\n";
  const { repositoryPath, packetPath } = await arrangeGuidancePacket(rules);
  const requests: Parameters<ReviewProviderV1["complete"]>[0][] = [];
  const provider: ReviewProviderV1 = {
    auditRequest: (request) => ({
      providerPolicyVersion: "mock-v1",
      wireBodyDigest: auditDigest,
      wireBodyBytes: Buffer.byteLength(JSON.stringify(request), "utf8"),
      credentialFreeWireRequestDigest: auditDigest,
    }),
    complete: async (request) => {
      requests.push(request);
      const brief = JSON.parse(request.messages[1]?.content ?? "{}");
      const common = {
        snapshotDigest: brief.snapshotManifest.snapshotDigest,
        briefDigest: brief.briefDigest,
        summary: "Guidance-aware review completed.",
        ruleAssessments: [
          {
            ruleId: "rule_typescript",
            status: "ASSESSED",
            conflictingRuleIds: [],
            explanation: "Reviewed the selected rule and repository guidance.",
          },
        ],
      };
      const value =
        request.stage === "PRELIMINARY"
          ? {
              ...common,
              schemaVersion: 2,
              stage: "PRELIMINARY",
              inspectedPaths: ["reviewed.ts"],
              canonicalInputCoverage: [
                {
                  canonicalInputId: "input_standard",
                  status: "ASSESSED",
                  explanation: "Applied the selected standard.",
                },
              ],
              findings: [],
              evidenceGaps: [],
              limitations: [],
              nextAction: "REQUEST_AUTHOR_PACKET",
            }
          : {
              ...common,
              schemaVersion: 3,
              stage: "FINAL",
              mode: "STANDARDS",
              findings: [],
              withdrawnPreliminaryFindings: [],
              preliminaryConcernDispositions: [],
              authorClaims: [],
              authorVerificationClaims: [],
              limitations: [],
              verdict: "READY",
              nextActions: { blockers: [], fastFollows: [] },
            };
      return {
        value,
        rawContent: JSON.stringify(value),
        responseId: "mock-response",
        model: "mock/reviewer",
        provider: "mock/fp4",
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, cost: null },
      };
    },
  };

  try {
    const result = await runTwoStageReview(packetPath, config, provider);
    assert.equal(result.report.verdict, "READY");
    assert.equal(requests.length, 2);
    assert.match(requests[0]?.messages[0]?.content ?? "", /REVIEWER_SPECIFIC/);
    assert.match(requests[0]?.messages[1]?.content ?? "", /Never hide a fallback/);
    assert.doesNotMatch(JSON.stringify(requests[0]?.messages), /AUTHOR_ONLY/);
    assert.match(JSON.stringify(requests[1]?.messages), /AUTHOR_ONLY/);
    const events = (await readFile(result.runRecordPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const started = events.find((event) => event.type === "RUN_STARTED");
    assert.equal(started.promptVersion, "standards-review-v18");
    assert.equal(started.guidanceGraphDigest.value.length, 64);
    assert.equal(events.find((event) => event.type === "GUIDANCE_ADMISSION")?.status, "ACCEPTED");
    assert.equal(
      events.find((event) => event.type === "CALL_STARTED")?.promptVersion,
      "standards-review-v18",
    );
    const reportMetadata = JSON.parse(await readFile(result.reportMetadataPath, "utf8"));
    assert.deepEqual(reportMetadata.guidanceGraphDigest, started.guidanceGraphDigest);
    assert.equal(reportMetadata.promptVersion, "standards-review-v18");
    assert.equal(reportMetadata.preliminarySchema, "standards_preliminary_v2");
    assert.equal(reportMetadata.finalSchema, "standards_candidate_v3");
    assert.deepEqual(
      reportMetadata.reportDigest,
      sha256Utf8(await readFile(result.finalPath, "utf8")),
    );
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

test("64 KiB reviewer guidance stops before the first provider call", async () => {
  const { repositoryPath, packetPath } = await arrangeGuidancePacket("g".repeat(64 * 1024));
  let calls = 0;
  const provider: ReviewProviderV1 = {
    auditRequest: () => ({
      providerPolicyVersion: "mock-v1",
      wireBodyDigest: auditDigest,
      wireBodyBytes: 1,
      credentialFreeWireRequestDigest: auditDigest,
    }),
    complete: async () => {
      calls += 1;
      throw new Error("Provider must not be called.");
    },
  };
  try {
    await assert.rejects(
      () => runTwoStageReview(packetPath, config, provider),
      /admission stopped/i,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});
