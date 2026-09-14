# Friendly reviewer operations execution index

Status: in progress. Adapter integration destination:
`codex/multi-harness-guidance-adapters`. Commander work remains isolated in PR
#154. Canonical scope and acceptance remain in
[`2026-09-11-friendly-reviewer-operations-plan.md`](2026-09-11-friendly-reviewer-operations-plan.md).

| ID | Issue | Delivery unit | Owner | Dependencies | Acceptance and verification | Status |
| --- | --- | --- | --- | --- | --- | --- |
| FO-3A | #148 | Gemini and Kiro BASE guidance adapters, imports, ignore semantics, and focused fixtures | guidance-gemini-kiro worker | Frozen `GuidanceGraphV1`; existing discovery helpers | Normative family-table selection, exclusion, import, cap, secret, and permutation fixtures pass | Implemented; focused tests green |
| FO-3B | #148 | Copilot and Cursor BASE guidance adapters, imports, and focused fixtures | guidance-copilot-cursor worker | Frozen `GuidanceGraphV1`; existing discovery helpers | Normative family-table selection, exclusion, import, cap, secret, overlap, and permutation fixtures pass | Implemented; focused tests green |
| FO-3I | #148 | Register adapters in canonical repository capture and prove shared-node merge | lead | FO-3A, FO-3B | Combined discovery corpus passes; multi-family content renders once with full provenance | Complete; final review findings remediated and post-fix gates green |
| FO-4A | #101 | Compact prompt presentation provenance and add explicit envelope-byte regression ceilings | lead | Frozen graph identity; no graph-contract weakening | 13- and 121-target fixtures substantially reduce bytes; target IDs occur once per source presentation | Pending; first implementation rejected in fresh review |
| FO-5A | #130 | Let Commander own grammar, required values, duplicate handling, and typed command options | cli-commander worker | Existing Commander dependency admission | Existing command grammar, help, exit codes, stdout, and stderr parity tests pass | Complete; CLI parity tests green |
| FO-5B | #103 | Implement author-setting controls and friendly input lifecycle | unassigned | FO-4 trust/budget checkpoint, FO-5A | Every simple setting changes behavior; author default/opt-out/isolation/resume fixtures pass | Pending |
| FO-6 | #149 | Update short-flow docs and provider-free multilingual qualification | lead | FO-3I, FO-4A, FO-5B | Schema generation, full repository check, context gate, and provider-free E2E matrix pass | Pending |

## Ownership boundaries

- FO-3A owns new Gemini/Kiro guidance modules and focused tests. Lead owns
  shared capture registration, shared contracts, exports, and dependency files.
- FO-3B owns new Copilot/Cursor guidance modules and focused tests. Lead owns
  shared capture registration, shared contracts, exports, and dependency files.
- FO-5A owns `src/cli.ts` and `test/cli.test.ts` only for parser migration.
  Author lifecycle and contract work stays outside this delivery unit.
- FO-4A owns guidance presentation contract/runtime/tests and does not change
  graph identity or discovery behavior.

## Integration gate

Lead reconciles handoffs, updates this index, then runs focused tests, schema
generation for deliberate contract changes, `npm run check`, and
`python3 -B scripts/check-ai-context.py --ci`. No paid provider call is part of
this execution index; live qualification requires separate explicit approval.

Latest provider-free gate (2026-09-14): formatting, lint, typecheck, 600
coverage tests, and 32 E2E tests pass under Node.js 24. Dependency audit reports
zero vulnerabilities when rerun with registry access. No provider call made.

Separately approved paid validation on the rebased Slice 3 branch initially
completed 3/14 cases before upstream shared-pool 429 capacity errors. A later
targeted recovery completed all 11 previously incomplete cases, and all 14
combined verdicts matched their human labels. See [multi-harness paid
E2E](../validation/2026-09-14-multi-harness-paid-e2e.md).

Expanded Slice 3 qualification (2026-09-14): 46 focused provider-free cases
pass, within a 110-test guidance suite. Coverage includes canonical multi-family closure under
reversed input order, direct-symlink shared-family merging, source-kind overlap,
relocation scopes, every snapshot change projection, TypeScript/Python/Go/Java/
documentation applicability, dynamic-mode exclusions, and new-family secret/
symlink/unresolved/cycle failures. Explicit below/at/above fixtures now cover
every normative discovery-cap row: snapshot and relocation-derived targets,
applicability paths, candidates, nodes, recognitions, applicability pairs,
occurrences, edges, diagnostics, normalized paths, import specifiers, source
bytes, Gemini basenames and settings, vendor frontmatter, conditional patterns,
brace groups/products, compiled alternatives, and symlink chains.

## Fresh-review blockers

- FO-4A needs a versioned compact presentation that retains exact
  family-to-target mapping and measures complete provider-message wire deltas.

## Slice 3 review-loop outcome

Review instance 3 of 3 found path-scoped rules were fully admitted before
applicability filtering and found stale canonical status text. Remediation now
selects targets from bounded leading metadata before full secret, UTF-8, size,
and Markdown admission in Claude, Kiro, Copilot, and Cursor adapters. Regression
fixtures retain matching-source rejection while proving non-matching unsafe
bodies never enter graph or blob output. No fourth independent review instance
is claimed; post-fix repository gates provide completion evidence.
