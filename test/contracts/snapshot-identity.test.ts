import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { finalizeSnapshotManifestV1, verifySnapshotManifestIdentityV1 } from "../../src/index.js";

async function readSnapshotDraft(): Promise<Record<string, unknown>> {
  const contents = await readFile(
    resolve("test", "fixtures", "snapshot-manifest.valid.json"),
    "utf8",
  );
  const { snapshotDigest: _snapshotDigest, ...draft } = JSON.parse(contents) as Record<
    string,
    unknown
  >;
  return draft;
}

describe("snapshot manifest identity", () => {
  it("finalizes and verifies a valid snapshot manifest", async () => {
    const manifest = finalizeSnapshotManifestV1(await readSnapshotDraft());

    assert.equal(manifest.snapshotDigest.algorithm, "SHA256");
    assert.equal(
      manifest.snapshotDigest.value,
      "a09e0229ad5fad95a0261656c16d7694af9c4bba2c36e0177e30ef4ad17d3b14",
    );
    assert.equal(verifySnapshotManifestIdentityV1(manifest), true);
  });

  it("is stable across opaque run metadata and ledger order", async () => {
    const draft = await readSnapshotDraft();
    const reordered = structuredClone(draft) as {
      snapshotId: string;
      flowId: string;
      reviewInstance: { number: number; maximum: number };
      raceCheck: { attempts: number };
      paths: unknown[];
    };
    reordered.snapshotId = "snapshot_another_artifact";
    reordered.flowId = "flow_another_run";
    reordered.reviewInstance = { number: 2, maximum: 3 };
    reordered.raceCheck.attempts = 3;
    reordered.paths.reverse();

    assert.deepEqual(
      finalizeSnapshotManifestV1(reordered).snapshotDigest,
      finalizeSnapshotManifestV1(draft).snapshotDigest,
    );
  });

  it("uses UTF-16 ordering for set-like ledger entries", async () => {
    const draft = (await readSnapshotDraft()) as {
      exclusions: Array<{
        path: string;
        reason: "USER_EXCLUDED";
        detail: string;
      }>;
    };
    draft.exclusions = [
      { path: "\u{e000}.txt", reason: "USER_EXCLUDED", detail: "unicode ordering vector" },
      { path: "\u{1f600}.txt", reason: "USER_EXCLUDED", detail: "unicode ordering vector" },
    ];
    const reversed = structuredClone(draft);
    reversed.exclusions.reverse();

    const expected = "b74c3d3bcb6512857e8a0cd383a54531baf9e6f07a5049e8a6dd9cc517cf2159";
    assert.equal(finalizeSnapshotManifestV1(draft).snapshotDigest.value, expected);
    assert.equal(finalizeSnapshotManifestV1(reversed).snapshotDigest.value, expected);
  });

  it("changes when captured content identity changes", async () => {
    const draft = await readSnapshotDraft();
    const changed = structuredClone(draft) as {
      paths: Array<{ after: null | { digest?: { value: string } } }>;
    };
    const modified = changed.paths.find((path) => path.after?.digest);
    assert.ok(modified?.after?.digest);
    modified.after.digest.value = "9".repeat(64);

    assert.notDeepEqual(
      finalizeSnapshotManifestV1(changed).snapshotDigest,
      finalizeSnapshotManifestV1(draft).snapshotDigest,
    );
  });

  it("detects a changed manifest after finalization", async () => {
    const manifest = finalizeSnapshotManifestV1(await readSnapshotDraft());
    manifest.source.branch = "codex/different-branch";

    assert.equal(verifySnapshotManifestIdentityV1(manifest), false);
  });

  it("rejects a persisted manifest with an omitted review-instance maximum", async () => {
    const manifest = finalizeSnapshotManifestV1(await readSnapshotDraft()) as unknown as {
      reviewInstance: { maximum?: number };
    };
    delete manifest.reviewInstance.maximum;

    assert.equal(verifySnapshotManifestIdentityV1(manifest), false);
  });

  it("rejects invalid draft material before hashing", async () => {
    const draft = { ...(await readSnapshotDraft()), unexpected: true };

    assert.throws(() => finalizeSnapshotManifestV1(draft));
  });

  it("rejects custom identity drafts before coercing them", async () => {
    const draft = await readSnapshotDraft();
    Object.setPrototypeOf(draft, { customDraft: true });

    assert.throws(() => finalizeSnapshotManifestV1(draft), /plain JSON objects/);
  });

  it("rejects identity-draft accessors without invoking them", async () => {
    const draft = await readSnapshotDraft();
    const source = draft.source;
    let getterCalls = 0;
    Object.defineProperty(draft, "source", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return source;
      },
    });

    assert.throws(() => finalizeSnapshotManifestV1(draft), /data properties/);
    assert.equal(getterCalls, 0);
  });

  it("rejects proxy-backed finalization and verification without invoking traps", async () => {
    let getTrapCalls = 0;
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(target, property, receiver) {
        getTrapCalls += 1;
        return Reflect.get(target, property, receiver);
      },
    };
    const draftProxy = new Proxy(await readSnapshotDraft(), handler);
    assert.throws(() => finalizeSnapshotManifestV1(draftProxy), /proxies/);
    assert.equal(getTrapCalls, 0);

    const manifest = finalizeSnapshotManifestV1(await readSnapshotDraft());
    const manifestProxy = new Proxy(manifest as unknown as Record<string, unknown>, handler);
    assert.equal(verifySnapshotManifestIdentityV1(manifestProxy), false);
    assert.equal(getTrapCalls, 0);
  });

  it("rejects an inherited required field without invoking its accessor", async () => {
    const draft = (await readSnapshotDraft()) as {
      source: { branch?: string | null };
    };
    delete draft.source.branch;
    let getterCalls = 0;
    const previousDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "branch");
    Object.defineProperty(Object.prototype, "branch", {
      configurable: true,
      get() {
        getterCalls += 1;
        return null;
      },
    });

    try {
      assert.throws(() => finalizeSnapshotManifestV1(draft));
      assert.equal(getterCalls, 0);
    } finally {
      if (previousDescriptor) {
        Object.defineProperty(Object.prototype, "branch", previousDescriptor);
      } else {
        delete (Object.prototype as { branch?: unknown }).branch;
      }
    }
  });

  it("rejects an incomplete persisted artifact without invoking an inherited accessor", async () => {
    const draft = (await readSnapshotDraft()) as {
      source: { branch: string | null };
    };
    draft.source.branch = null;
    const manifest = finalizeSnapshotManifestV1(draft) as unknown as {
      source: { branch?: string | null };
    };
    delete manifest.source.branch;
    let getterCalls = 0;
    const previousDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "branch");
    Object.defineProperty(Object.prototype, "branch", {
      configurable: true,
      get() {
        getterCalls += 1;
        return null;
      },
    });

    try {
      assert.equal(verifySnapshotManifestIdentityV1(manifest), false);
      assert.equal(getterCalls, 0);
    } finally {
      if (previousDescriptor) {
        Object.defineProperty(Object.prototype, "branch", previousDescriptor);
      } else {
        delete (Object.prototype as { branch?: unknown }).branch;
      }
    }
  });
});
