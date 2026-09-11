# Review-quality pivot execution index

Status: complete; live provider qualification deferred. Integration branch:
`codex/review-quality-pivot`.

Objective: make realistic changes reviewable by sending focused Git hunks and
honest scope metadata, while closing the three known scope, capture, and
credential-safety defects. Product decisions remain owned by
[ADR-008](../decisions/008-send-a-reviewable-changeset.md) and its
[implementation plan](2026-09-10-reviewable-changeset-plan.md).

## Work items

| ID | Work | Dependency | Owner | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| RQ-1 | Render bounded unified diffs, retaining whole-file evidence only when deterministic thresholds justify it | ADR-008 slice 2 | Internal subagent | Real changes send valid hunks with stable BASE/HEAD coordinates; focused tests pass | Complete |
| RQ-2 | Fix custom-output scope exclusion and staged-delete/recreate capture | None | Internal subagent | Reproductions for issues #67 and #69 fail first, then pass without changing index state | Complete |
| RQ-3 | Reject JSON-decoded credential reflection before any accepted artifact persists | None | Internal subagent | Issue #68 reproduction fails first, then literal/escaped/nested controls pass | Complete |
| RQ-4 | Replace unmatched-path blocking semantics with explicit out-of-scope accounting and role-aware review depth | RQ-1 | Lead | Clean mixed changes can reach Ready; reviewable unassessed paths still block | Complete |
| RQ-5 | Integrate contracts, schemas, documentation, and provider-free real-commit admission check | RQ-1–RQ-4 | Lead | `npm run schemas:write`, `npm run check`, context checks, and real-commit dry-run pass | Complete |
| RQ-6 | Evaluate proposed Git, diff, syntax, matching, and token libraries against frozen-snapshot invariants | RQ-1–RQ-4 | Lead + research subagents | Source-backed adopt/spike/defer/reject decision retained in repository | Complete |

## Verification

- Focused tests named by each work item.
- `npm run schemas:write` after deliberate contract changes.
- `npm run check`.
- `python3 -B scripts/check-ai-context.py --ci`.
- Provider-free dry-run against commit range `f52f4e8..d6ba399`.

Live OpenRouter qualification is excluded from this implementation pass. It
requires a separately frozen matrix and explicit paid-call authorization after
evidence shaping lands.

## Final evidence

- `npm run check`: 260 tests passed; format, lint, and type checks completed.
  Lint retains nine pre-existing warnings.
- `python3 -B scripts/check-ai-context.py --ci`: passed.
- Range `f52f4e8..d6ba399`: 46 reviewable paths, 10 visible out-of-scope
  documentation exclusions, 34 bounded-hunk items, 12 whole-file items, 264,631
  evidence bytes, and no blocking coverage constraint.
- Existing 1,400,000-token example ceiling remains 35,900 conservative units
  short on the final packet. A provider-free validation config
  changing only that ceiling to 1,500,000 passed at 1,435,900 reserved units and
  $0.160793 maximum reserved cost. Production config remains unchanged; accurate
  token admission is separate work.
