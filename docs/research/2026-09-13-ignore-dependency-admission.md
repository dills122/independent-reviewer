# `ignore` dependency admission

Status: accepted for Slice 3 after Gemini ignore parity fixtures. Owner: project
maintainer. Evaluated package: `ignore@7.0.9`.

## Decision

Use exact-pinned `ignore@7.0.9` behind the Gemini family adapter for frozen
`.gitignore` and `.geminiignore` interpretation. Native Git remains snapshot
capture authority. Product code owns BASE reads, normalized case-sensitive
repository paths, candidate limits, target applicability, and fail-closed
handling.

## Admission evidence

| Check | Evidence |
| --- | --- |
| Ownership | npm package and GitHub repository are maintained by `kael`; npm registry reports one maintainer, `kael <i@kael.me>` |
| Maintenance | npm registry modification time is 2026-09-08; upstream repository was pushed 2026-09-08; latest tagged release metadata is 7.0.8 from 2026-08-31 and registry version is 7.0.9 |
| Adoption | Upstream repository reports 501 stars and 54 forks; package is the established Gitignore-specific candidate selected by ADR-014 |
| License | npm registry declares MIT |
| Security | Install-time audit of 95 packages reports zero vulnerabilities; full repository `npm run check` remains required before merge |
| Package cost | 113,359 unpacked bytes and no declared runtime dependencies |
| Compatibility | Package declares Node.js `>=4`; project compiles and exercises it under the pinned Node.js 24 toolchain before merge |
| Integrity | npm registry SHA-512 integrity is `sha512-brTTsvFRt5C1gGHtPst/281UjPD5t9fBqbgoMPlVWy11ZLTPfu7HxK4ZYqO9H7o/yC9rSTCI85EaQ4OoY12qYw==` |
| Adversarial behavior | Focused fixtures cover ordering, negation, comments, directory bases, case sensitivity, ancestor-directory exclusion, and parity with `git check-ignore --no-index` |

## Boundary

Library permissiveness does not widen product grammar. Adapter must configure
case-sensitive matching on normalized relative paths and must not expose
callbacks, executable configuration, host paths, or working-tree reads. Any
parity failure blocks Slice 3 integration and removes this dependency from the
delivery branch.
