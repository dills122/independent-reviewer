import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { secretContentScanV1 } from "../../src/snapshot/git-capture.js";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----\n";
const SOURCE = `const key = \`${PEM}\`;\n`;

function utf16be(text: string): Uint8Array {
  const le = Buffer.from(text, "utf16le");
  const be = Buffer.alloc(le.length);
  for (let index = 0; index < le.length; index += 2) {
    be[index] = le[index + 1] as number;
    be[index + 1] = le[index] as number;
  }
  return be;
}

function withBom(prefix: number[], text: string, encoding: "utf16le" | "utf16be"): Uint8Array {
  const body = encoding === "utf16le" ? Buffer.from(text, "utf16le") : Buffer.from(utf16be(text));
  return Buffer.concat([Buffer.from(prefix), body]);
}

describe("secretContentScanV1", () => {
  it("finds a marker in UTF-8 content", () => {
    assert.deepEqual(secretContentScanV1(Buffer.from(SOURCE, "utf8")), {
      status: "MARKER",
      label: "PEM private key block",
    });
  });

  it("finds the same marker in NUL-dense UTF-16, which previously bypassed the scan", () => {
    // Regression for #92: `bytes.includes(0)` returned undefined, so these read as clean and the
    // file was admitted with its key written into the packet blob store.
    for (const [name, bytes] of [
      ["utf-16le", Buffer.from(SOURCE, "utf16le")],
      ["utf-16be", utf16be(SOURCE)],
      ["utf-16le with BOM", withBom([0xff, 0xfe], SOURCE, "utf16le")],
      ["utf-16be with BOM", withBom([0xfe, 0xff], SOURCE, "utf16be")],
    ] as const) {
      assert.deepEqual(
        secretContentScanV1(bytes),
        { status: "MARKER", label: "PEM private key block" },
        name,
      );
    }
  });

  it("reports every marker kind through a UTF-16 encoding", () => {
    for (const [label, secret] of [
      ["PGP private key block", "-----BEGIN PGP PRIVATE KEY BLOCK-----\n"],
      ["AWS access key id", "AKIA1234567890ABCDEF"],
      ["GitHub token", `ghp_${"a".repeat(36)}`],
      ["Google API key", `AIza${"b".repeat(35)}`],
      ["OpenAI-style API key", `sk-${"c".repeat(20)}`],
    ] as const) {
      const text = `const value = "${secret}";\n`;
      assert.deepEqual(secretContentScanV1(Buffer.from(text, "utf16le")), {
        status: "MARKER",
        label,
      });
    }
  });

  it("reports clean text as clean, in either encoding", () => {
    const clean = "export const value = 1;\n";
    assert.deepEqual(secretContentScanV1(Buffer.from(clean, "utf8")), { status: "CLEAN" });
    assert.deepEqual(secretContentScanV1(Buffer.from(clean, "utf16le")), { status: "CLEAN" });
    assert.deepEqual(secretContentScanV1(utf16be(clean)), { status: "CLEAN" });
  });

  it("keeps the public AWS example from making evidence disappear, in either encoding", () => {
    const text = 'const documented = "AKIAIOSFODNN7EXAMPLE";\n';
    assert.deepEqual(secretContentScanV1(Buffer.from(text, "utf8")), { status: "CLEAN" });
    assert.deepEqual(secretContentScanV1(Buffer.from(text, "utf16le")), { status: "CLEAN" });
  });

  it("reports content it cannot decode as not scanned rather than clean", () => {
    for (const [name, bytes] of [
      // NULs on both parities: neither UTF-16 orientation explains them.
      ["mixed NUL parity", Buffer.from([0x41, 0x00, 0x42, 0x00, 0x00, 0x43, 0x44, 0x00])],
      // Odd length cannot be UTF-16 at all.
      ["odd length with NUL", Buffer.from([0x41, 0x00, 0x42, 0x00, 0x00])],
    ] as const) {
      assert.deepEqual(
        secretContentScanV1(bytes),
        { status: "NOT_SCANNED", reason: "UNDECODABLE" },
        name,
      );
    }
  });

  it("treats sparse NUL bytes in otherwise binary content as undecodable", () => {
    // A PNG-like payload: too few NULs to be UTF-16, so it is not scanned as garbage text.
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0d]);
    assert.deepEqual(secretContentScanV1(binary), {
      status: "NOT_SCANNED",
      reason: "UNDECODABLE",
    });
  });

  it("scans empty content rather than refusing it", () => {
    assert.deepEqual(secretContentScanV1(new Uint8Array()), { status: "CLEAN" });
  });
});
