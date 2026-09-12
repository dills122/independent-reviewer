# Strict JSON admission decision

Status: accepted for issue #111. Package evaluated: `jsonc-parser@3.3.1`.

## Decision

Use exact-pinned `jsonc-parser@3.3.1` as the lexical and structural admission
layer for external and persisted JSON. Keep native `JSON.parse` only after that
admission succeeds and for a small set of strings produced and already validated
inside the process.

The dependency is the latest stable release as of 2026-09-12. It is maintained
by Microsoft, MIT licensed, has no runtime dependencies, and exposes source
positions plus explicit comment and trailing-comma policy. Version 4 remains a
prerelease and is not admitted.

`jsonc-parser` is intentionally fault tolerant and does not reject duplicate
object members itself. Product code therefore uses its visitor API with strict
options and one property-name set per active object. Property callbacks provide
decoded names, so literal and Unicode-escaped spellings of the same name collide.
The library still owns tokenization, escape handling, grammar recovery, and
positions; the adapter owns the product's duplicate-member rule.

After a clean visit, native `JSON.parse` supplies the value. Any disagreement or
parser recursion failure fails closed with a generic diagnostic. Provider bytes,
member names, values, snippets, and native parser messages do not enter errors.

Primary references:

- [jsonc-parser package](https://www.npmjs.com/package/jsonc-parser)
- [v3.3.1 API and strict parse options](https://github.com/microsoft/node-jsonc-parser/blob/v3.3.1/README.md)
- [v3.3.1 visitor implementation](https://github.com/microsoft/node-jsonc-parser/blob/v3.3.1/src/impl/parser.ts)
- [upstream changelog](https://github.com/microsoft/node-jsonc-parser/blob/main/CHANGELOG.md)

## Boundary inventory

The audit found 36 production `JSON.parse` calls:

- 8 external user, configuration, author, or standards inputs;
- 22 persisted packet, flow-state, run-record, or resume inputs;
- 2 OpenRouter envelope/completion inputs; and
- 4 trusted internal re-parses of canonical or already-admitted strings.

External and persisted sites move to one strict adapter. Trusted internal sites
remain explicit so callers cannot accidentally treat the native parser as an
admission boundary.

## Initial caps

| Artifact family | Maximum |
| --- | ---: |
| Small settings, configuration, and flow state | 1 MiB |
| External request, author, and standards documents | 8 MiB |
| OpenRouter response envelope and structured completion | 8 MiB |
| Stored provider response record or JSONL line | 8 MiB |
| Complete packet/resume JSON artifact or run-record JSONL | 64 MiB |

Bounded file reads stop after `maximum + 1` bytes. These initial compatibility
ceilings prevent unbounded allocation without silently lowering existing product
budgets; later artifact-specific measurement may tighten them.

## Required behavior

- Reject comments, trailing commas, empty input, malformed input, multiple roots,
  and duplicate properties at any object depth before Zod validation.
- Report stable error code plus one-based line and column without echoing content.
- Treat UTF-8 byte count, not JavaScript string length, as the admission unit.
- Reject invalid UTF-8 rather than decoding replacement characters.
- Give JSONL both total-file and per-line caps and retain physical line location.
- Never retain a raw provider body when strict admission failed: encoded secrets
  may otherwise survive string-level redaction in a private failure artifact.
- Keep canonical JSON serialization unchanged.

## Revisit triggers

Re-evaluate the adapter if stable `jsonc-parser` adds native duplicate-member or
depth limits, v4 becomes stable and materially improves ESM/runtime behavior, or
measured artifacts justify lower family-specific caps.
