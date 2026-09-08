# ADR-004: Use JCS and SHA-256 for artifact identities

## Status

Accepted

## Date

2026-09-07

## Context

Snapshot and blind-stage artifacts need repeatable content identities across
processes and future language implementations. Ordinary JSON permits irrelevant
whitespace and object-property order differences, while artifact documents also
contain opaque run metadata and their own digest fields. Hashing an arbitrary
serialization or the complete persisted object would therefore make identity
unstable or self-referential.

The identity profile must remain dependency-light, fail closed on data that
cannot be represented consistently, and distinguish logical snapshot content
from the exact blind-stage packet sent to a reviewer.

## Decision

Canonicalize identity payloads using the JSON Canonicalization Scheme (JCS) in
RFC 8785. JCS preserves array order, recursively sorts object names by UTF-16
code units, uses ECMAScript primitive serialization, emits no insignificant
whitespace, and encodes the result as UTF-8.[^jcs]

Accept only I-JSON-compatible in-memory data. Reject non-finite numbers, lone
Unicode surrogates, sparse arrays, cycles, accessors, custom object instances,
symbols, and values that JSON cannot represent without changing them. Do not
normalize Unicode strings. Detect JavaScript `Proxy` instances with Node's
non-reflective runtime predicate before any property inspection so neither
finalization nor verification executes user-defined traps.[^node-is-proxy]

Hash the canonical UTF-8 bytes with SHA-256 and store lowercase hexadecimal in
the existing `DigestV1` shape. Node's built-in `node:crypto` implementation is
used, so this decision adds no runtime dependency.[^node-crypto]

Every artifact payload includes a versioned identity-profile URN for domain
separation:

- Canonical-input identity binds the complete validated input, including its
  ID, kind, title, content, and provenance. A neutral brief must reconcile each
  embedded input with the corresponding digest in its snapshot manifest.
- Snapshot identity represents logical frozen review content. It excludes the
  opaque snapshot, flow, and review-instance IDs, the self-referential digest,
  and capture-attempt count. It includes the stable capture-state digests.
  Set-like path, exclusion, omission, canonical-input, and untracked-path
  ledgers are sorted before canonicalization.
- Neutral-brief identity represents the exact ordered blind-stage artifact. It
  excludes only the opaque brief ID and self-referential brief digest. It
  includes the complete embedded manifest, canonical inputs, evidence order,
  constraints, and capability declarations. Its finalizer refuses an embedded
  snapshot whose identity does not verify.
- Initial-evidence identity uses SHA-256 over the exact evidence-content UTF-8
  bytes. The runtime recomputes this digest and checks that source-context
  content covers its declared logical line range before a neutral brief is
  accepted.

Creation APIs accept digest-free material, validate it against the versioned
runtime contract, and return a finalized artifact. Verification APIs validate
the contract and recompute the digest. Merely parsing a digest field is not an
identity verification.

Caller-input defaults are materialized before an artifact crosses the
persisted boundary. Persisted schemas and verification APIs require every
identity-bound field explicitly; they never restore omitted fields while
checking a stored artifact.

## Alternatives considered

### Plain `JSON.stringify`

Rejected because object insertion order would become an accidental part of the
identity and cross-language implementations could serialize equivalent objects
differently.

### Hash persisted JSON bytes

Rejected for logical snapshot identity because formatting and operational IDs
would change the digest without changing review evidence. Exact artifact bytes
may still be recorded separately from semantic content identity.

### Opaque IDs without content digests

Rejected because they cannot prove that persisted or transmitted content still
matches the frozen artifact.

### Add a canonical-JSON package

Deferred because the required JCS surface is small, Node already supplies the
primitive serialization and hashing behavior, and the implementation is
covered by RFC vectors and golden artifact digests. A maintained package can be
adopted later only with compatibility tests proving identical bytes.

## Consequences

- Identity behavior is language-neutral at the persisted boundary and pinned
  by RFC vectors plus golden snapshot and neutral-brief digests.
- Array order remains meaningful unless an artifact-specific projection
  explicitly declares the array a set-like ledger.
- Adding or removing identity fields, changing ledger normalization, or changing
  the canonicalization profile requires an explicit identity-profile revision.
- The serializer is intentionally stricter than `JSON.stringify`; callers must
  supply plain data-property JSON values rather than class instances,
  accessors, or lossy values. Identity finalizers preflight this representation
  and copy it into fresh null-prototype objects before schema parsing. Missing
  fields therefore cannot resolve through inherited data or accessors on a
  polluted `Object.prototype`; verification applies the same boundary.
- Snapshot capture must digest raw captured file content separately before
  artifact finalization. This ADR does not define Git capture or file-byte
  hashing.
- Request JSON Schema describes caller input, while snapshot and neutral-brief
  JSON Schemas describe fully materialized output.
- Relational reconciliation compares structured provenance fields directly;
  delimiter-joined composite strings are not artifact identities.

[^jcs]: RFC Editor, [RFC 8785 — JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html).
[^node-crypto]: Node.js, [`crypto.createHash`, `hash.update`, and `hash.digest`](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptocreatehashalgorithm-options).
[^node-is-proxy]: Node.js, [`util.types.isProxy`](https://nodejs.org/docs/latest-v24.x/api/util.html#utiltypesisproxyvalue).
