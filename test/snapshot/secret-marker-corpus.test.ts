import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { secretContentScanV1 } from "../../src/snapshot/git-capture.js";

/**
 * Recall corpus for the content secret policy, from the #115 detector evaluation.
 *
 * Every value is fabricated but shaped like the real format, because a detector that only matches
 * `aaaa…` filler proves nothing. Values are assembled by concatenation so this file contains no
 * scannable literal of its own, matching the convention in git-capture.test.ts.
 */
const join = (...parts: string[]): string => parts.join("");

/** Deterministic mixed-charset filler, so charset and length constraints are exercised. */
function fill(
  length: number,
  alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
): string {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += alphabet[(index * 31 + 7) % alphabet.length] as string;
  }
  return out;
}
const UPPER_ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const BASE64URL = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

function privateKeyBlock(kind: string): string {
  return join(
    "-----BEGIN ",
    kind,
    " PRIVATE KEY-----\n",
    fill(64),
    "\n",
    fill(60),
    "==\n-----END ",
    kind,
    " PRIVATE KEY-----\n",
  );
}

const DETECTED: ReadonlyArray<readonly [label: string, text: string]> = [
  ["PEM private key block", privateKeyBlock("RSA")],
  ["PEM private key block", privateKeyBlock("OPENSSH")],
  ["PEM private key block", privateKeyBlock("EC")],
  // A truncated paste is still a leaked key; the marker deliberately needs no END line.
  ["PEM private key block", join("-----BEGIN RSA", " PRIVATE KEY-----\n", fill(40), "\n")],
  [
    "PGP private key block",
    join(
      "-----BEGIN PGP",
      " PRIVATE KEY BLOCK-----\n",
      fill(64),
      "\n-----END PGP",
      " PRIVATE KEY BLOCK-----\n",
    ),
  ],
  ["PuTTY private key", join("PuTTY", "-User-Key-File-3: ssh-rsa\nEncryption: none\n")],
  ["AWS access key id", join("AKIA", fill(16, UPPER_ALNUM))],
  ["AWS access key id", join("ASIA", fill(16, UPPER_ALNUM))],
  ["AWS access key id", join("AROA", fill(16, UPPER_ALNUM))],
  [
    "Azure storage account key",
    join(
      "AccountName=acct;",
      "AccountKey=",
      fill(86, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"),
      "==;",
    ),
  ],
  ["Google API key", join("AIza", fill(35))],
  ["Google OAuth client secret", join("GOCSPX", "-", fill(28))],
  ["OpenAI-style API key", join("sk", "-", fill(20), "T3BlbkFJ", fill(20))],
  ["OpenAI project key", join("sk", "-proj-", fill(74, BASE64URL))],
  ["Anthropic API key", join("sk", "-ant-api03-", fill(93, BASE64URL), "AA")],
  ["Groq API key", join("gsk", "_", fill(52))],
  ["Hugging Face token", join("hf", "_", fill(34))],
  ["GitHub token", join("ghp", "_", fill(36))],
  ["GitHub token", join("gho", "_", fill(36))],
  ["GitHub fine-grained token", join("github", "_pat_", fill(22), "_", fill(59))],
  ["GitLab access token", join("glpat", "-", fill(20))],
  ["npm access token", join("npm", "_", fill(36))],
  ["Slack token", join("xox", "b-", "123456789012-", fill(24))],
  [
    "Slack incoming webhook",
    join("https://hooks.slack.com/services/", "T00000000/", "B00000000/", fill(24)),
  ],
  ["SendGrid API key", join("SG", ".", fill(22), ".", fill(43))],
  ["Stripe live key", join("sk", "_live_", fill(24))],
  ["Stripe live key", join("rk", "_live_", fill(24))],
  ["Notion integration token", join("ntn", "_", fill(46))],
  [
    "URL with embedded credentials",
    join("postgres", "://admin:", fill(16), "@db.internal:5432/app"),
  ],
  ["URL with embedded credentials", join("https://admin:", fill(16), "@internal.example/api")],
];

const CLEAN: ReadonlyArray<readonly [why: string, text: string]> = [
  ["the documented AWS example stays reviewable", join("AKIA", "IOSFODNN7EXAMPLE")],
  ["prose naming a key with no block", "Rotate the PRIVATE KEY before release.\n"],
  ["40 hex characters are a commit id", join('baseCommit = "', fill(40, "0123456789abcdef"), '";')],
  ["too short to be a GitHub token", join("ghp", "_", fill(8))],
  ["sk appears in ordinary identifiers", "const sk_id = resolveSkId();\n"],
  ["fixture base64 that is not a credential", join('const png = "', fill(120), '";')],
  ["a UUID is not a credential", 'flowId = "flow_3f2504e0-4f89-11d3-9a0c-0305e82c3301";\n'],
  ["plain reviewable source", "export const value = 1;\n"],
  ["an npm integrity hash is not a credential", join('"integrity": "sha512-', fill(86), '=="')],
  // Stripe test keys are routine in fixtures; excluding them would delete ordinary evidence.
  ["a Stripe test key is not a live credential", join("sk", "_test_", fill(24))],
  ["a short placeholder password in documentation", "postgres://user:pass@localhost:5432/db\n"],
];

describe("secret content marker corpus", () => {
  it("detects every credential family the policy claims", () => {
    const missed: string[] = [];
    for (const [label, text] of DETECTED) {
      const result = secretContentScanV1(Buffer.from(text, "utf8"));
      if (result.status !== "MARKER") {
        missed.push(label);
        continue;
      }
      assert.equal(result.label, label, `expected ${label}, got ${result.label}`);
    }
    assert.deepEqual(missed, [], `undetected families: ${missed.join(", ")}`);
  });

  it("detects each family through a NUL-dense encoding as well", () => {
    // Pairs the corpus with the #92 encoding fix: coverage must not depend on UTF-8.
    for (const [label, text] of DETECTED) {
      const result = secretContentScanV1(Buffer.from(text, "utf16le"));
      assert.equal(result.status, "MARKER", `${label} missed in UTF-16LE`);
    }
  });

  it("leaves ordinary review evidence clean", () => {
    const flagged: string[] = [];
    for (const [why, text] of CLEAN) {
      const result = secretContentScanV1(Buffer.from(text, "utf8"));
      if (result.status === "MARKER") flagged.push(`${why} -> ${result.label}`);
    }
    assert.deepEqual(flagged, [], `false positives: ${flagged.join("; ")}`);
  });
});
