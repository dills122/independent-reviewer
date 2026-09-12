# Secret content detector evaluation

Status: keep the project-owned detector, extended; Secretlint deferred to a
layered follow-up. Decision owner: project maintainer. Issue: #115.

## Decision

Keep `secretContentScanV1` as the admission gate and extend its marker list from
8 families to 21. Do not adopt `@secretlint/core` as a replacement: measured
against a shaped corpus it detects 16 of 32 families where the extended local
detector detects 30, and it did not detect private key blocks or a standalone AWS
access key id at all in this spike.

Secretlint remains worth adopting later as an *additional* layer rather than a
substitute, because it uniquely caught one family the local list cannot express
safely. That is deferred until the private-key question below is resolved.

## Why now

Captured bytes are persisted in packets and transmitted to a third-party
provider, so detection coverage is part of the trust boundary rather than a
convenience. #92 fixed the *encoding* half of this gate — the scan previously
skipped any file containing a NUL byte. This is the *pattern* half: the list was
8 hand-written regexes, and a repository containing a live credential in any
other format was admitted as clean.

## Evidence

### Method

A corpus of 32 positive and 11 negative fixtures, in
`test/snapshot/secret-marker-corpus.test.ts`. Every value is fabricated but
shaped like the real format — correct length, charset, and required infixes such
as OpenAI's `T3BlbkFJ` — because a detector only measured against `aaaa…` filler
proves nothing. The first attempt at this corpus used repeated single characters
and produced misleading results for both detectors; the numbers below come from
the shaped version.

`@secretlint/core@13.0.5` was driven through its documented `lintSource` API with
`@secretlint/secretlint-rule-preset-recommend@13.0.5`, `maskSecrets: true` and
`noPhysicFilePath: true`, against in-memory content — no filesystem walker and no
CLI, as #115 requires.

### Recall

| Detector | Positives detected | False positives |
| --- | --- | --- |
| Local list, before this change | 13 / 32 | 0 / 11 |
| Secretlint preset-recommend | 16 / 32 | 0 / 11 |
| Local list, extended | **30 / 32** | 0 / 11 |
| Union of extended local and Secretlint | 31 / 32 | 0 / 11 |

Families the original list missed and the extended list now covers: OpenAI
project/admin/service-account keys, Anthropic, Groq, Hugging Face, GitLab, npm,
Google OAuth client secrets, Azure storage account keys, Slack incoming webhooks,
SendGrid, Stripe live and restricted keys, Notion, PuTTY private keys, credentials
embedded in a connection URL, and the five AWS IAM prefixes beyond `AKIA`/`ASIA`.

Anthropic keys are worth calling out: this product sends evidence to a model
provider, and `sk-ant-…` was not detectable before this change.

### What only Secretlint caught

- **AWS secret access key** (`aws_secret_access_key = <40 base64 chars>`). Not
  added locally on purpose: the value is 40 unanchored base64 characters, which
  cannot be matched without flagging ordinary hashes and fixtures. Secretlint
  detects it by requiring the assignment context, which is the right approach and
  the strongest single argument for layering it in later.

### What Secretlint did not catch

Through `lintSource` with the recommended preset, and again with
`@secretlint/secretlint-rule-privatekey@13.0.5` and
`@secretlint/secretlint-rule-aws@13.0.5` enabled explicitly:

- No private key block matched — RSA, OpenSSH, EC and PGP, with full BEGIN/END
  markers, 64-column base64 bodies, and a separate run using high-entropy
  pseudorandom bodies to rule out an entropy filter.
- A standalone `AKIA…` access key id did not match; the AWS rule fired only when
  a secret access key appeared nearby.

The rule's bundled matcher looks capable of matching these
(`BEGIN[ ]?(?:(?:RSA|DSA|EC|OPENSSH|PGP) )?PRIVATE KEY(?: BLOCK)?-----`), and
eleven other rules fired through the identical harness, so **this is an
unresolved question rather than a settled fact about Secretlint.** It is either a
harness detail this spike did not find or a regression in 13.0.5. It must be
resolved before adoption, because adopting Secretlint as a replacement on these
numbers would have removed private key detection from the product.

### Cost

- 8 packages, 1.4 MB installed, MIT, published 2026-08-27. Rules ship bundled in
  the preset rather than as separately pinned packages.
- 0.20 ms per scan versus 0.002 ms for the local list — roughly 90x, but
  negligible in absolute terms against a capture that already spawns Git
  subprocesses per file.
- The API satisfies the #115 constraints directly: in-memory source, and
  `maskSecrets: true` keeps matched values out of results.

## Alternatives

- **Replace the local list with Secretlint.** Rejected on the measurements: it
  would trade 30/32 recall for 16/32 and lose private key detection.
- **Add a generic high-entropy detector.** Rejected for now. It is the only way to
  reach the last families, and it is also the change most likely to exclude
  ordinary review evidence, which costs coverage silently.
- **Do nothing.** Rejected: the gate admitted recognizable live credential formats
  for every provider except the eight in the original list.

## Limits and next gate

- Still undetected by the extended list: AWS secret access keys (needs assignment
  context) and Vercel tokens (no format confidently documented in this spike).
- The marker list remains hand-maintained, so it will drift as providers add
  formats. The corpus test is what makes that drift visible rather than silent.
- Stripe coverage is deliberately restricted to `_live_` and `rk_live_`. Test keys
  are routine in fixtures and excluding them would delete review evidence for no
  security gain; a Stripe test key is asserted clean.
- `NOT_SCANNED` handling from #92 is unchanged: content that decodes in no
  supported text encoding is still admitted with a recorded omission rather than
  reported clean.
- Next gate for adopting Secretlint as a second layer: reproduce or disprove the
  private-key result, then decide whether a second detector's maintenance and
  supply-chain cost is worth one additional family plus future coverage.
