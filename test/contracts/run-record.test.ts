import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { RunRecordEventV1Schema } from "../../src/contracts/run-record.js";

const ORCHESTRATOR_SOURCE = join(process.cwd(), "src", "orchestrator", "two-stage-review.ts");

/** The `type:` literals the schema declares, read off the union rather than restated here. */
function declaredEventTypes(): string[] {
  return RunRecordEventV1Schema.options.map((option) => option.shape.type.value as string).sort();
}

/**
 * The `type:` literals `appendRunEvent` is actually called with.
 *
 * Scans the orchestrator source the way `strict-json.test.ts` scans for `JSON.parse`. Matching
 * the emitted set against the declared set is what makes the contract binding: an event added to
 * the orchestrator without a schema member fails here rather than at a user's resume (#122).
 */
async function emittedEventTypes(): Promise<string[]> {
  const source = await readFile(ORCHESTRATOR_SOURCE, "utf8");
  const emitted = new Set<string>();
  for (const call of source.matchAll(
    /appendRunEvent\(\s*\w+\s*,\s*\{([\s\S]{0,200}?)type:\s*"(\w+)"/g,
  )) {
    emitted.add(call[2] as string);
  }
  return [...emitted].sort();
}

const at = "2026-09-12T00:00:00.000Z";
const digest = { algorithm: "SHA256" as const, value: "a".repeat(64) };

describe("RunRecordEventV1Schema", () => {
  it("declares exactly the event types the orchestrator emits", async () => {
    assert.deepEqual(declaredEventTypes(), await emittedEventTypes());
  });

  it("accepts a RUN_STARTED without a guidance digest and one with it", () => {
    const base = {
      schemaVersion: 1,
      at,
      type: "RUN_STARTED",
      snapshotDigest: digest,
      briefDigest: digest,
      contextMapDigest: digest,
      planDigest: digest,
      configId: "config_example",
      configDigest: digest,
      requestedModels: ["vendor/model"],
      promptVersion: "review-policy-v21",
      preliminarySchema: "preliminary_assessment_v1",
      finalSchema: "final_review_candidate_v3",
      findingVerificationSchema: "finding_verification_candidate_v1",
      findingVerificationPromptVersion: "finding-verification-policy-v3",
    };

    // A requirements brief omits the key entirely; it is never written as null, and resume
    // compares the two sides on that basis.
    assert.equal(RunRecordEventV1Schema.parse(base).type, "RUN_STARTED");
    assert.ok(RunRecordEventV1Schema.safeParse({ ...base, guidanceGraphDigest: digest }).success);
    assert.equal(
      RunRecordEventV1Schema.safeParse({ ...base, guidanceGraphDigest: null }).success,
      false,
    );
  });

  it("accepts both shapes of FINDING_VERIFICATION_PERSISTED", () => {
    const base = { schemaVersion: 1, at, type: "FINDING_VERIFICATION_PERSISTED" };
    assert.ok(
      RunRecordEventV1Schema.safeParse({
        ...base,
        verificationDigest: digest,
        providerCall: false,
        responseArtifact: null,
      }).success,
    );
    assert.ok(
      RunRecordEventV1Schema.safeParse({
        ...base,
        verificationDigest: digest,
        providerCall: true,
        acceptedAttemptNumber: 2,
        responseArtifact: "finding-verification-provider-response.json",
      }).success,
    );
  });

  it("rejects an unknown event type", () => {
    const parsed = RunRecordEventV1Schema.safeParse({
      schemaVersion: 1,
      at,
      type: "RUN_PAUSED",
      terminalState: "FAILED",
    });
    assert.equal(parsed.success, false);
  });

  it("rejects an unknown field, so a renamed field cannot pass silently", () => {
    const parsed = RunRecordEventV1Schema.safeParse({
      schemaVersion: 1,
      at,
      type: "AUTHOR_DELIVERED",
      authorPacketDigest: digest,
      authorPacketDigestV2: digest,
    });
    assert.equal(parsed.success, false);
  });

  it("rejects a future schema version rather than reading it as version 1", () => {
    const parsed = RunRecordEventV1Schema.safeParse({
      schemaVersion: 2,
      at,
      type: "AUTHOR_DELIVERED",
      authorPacketDigest: digest,
    });
    assert.equal(parsed.success, false);
  });

  it("requires a timestamp on every event", () => {
    const parsed = RunRecordEventV1Schema.safeParse({
      schemaVersion: 1,
      type: "AUTHOR_DELIVERED",
      authorPacketDigest: digest,
    });
    assert.equal(parsed.success, false);
  });
});
