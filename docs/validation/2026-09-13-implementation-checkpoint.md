# Current implementation checkpoint — 2026-09-13

This checkpoint records branch state after the full paid matrix and pinned-route
retry fix. Canonical product direction remains in
[architecture and roadmap](../architecture-and-roadmap.md); friendly operations
work remains governed by the
[implementation plan](../plans/2026-09-11-friendly-reviewer-operations-plan.md).

## Implemented and verified

- Cumulative Git capture freezes committed, staged, unstaged, and untracked
  changes; deterministic packets bind source locations, omissions, file
  classification, Git attributes, unified diffs, and referenced source context.
- Language-neutral review units use bounded Tree-sitter adapters for JavaScript,
  TypeScript, TSX, Python, Go, and Java, with deterministic universal file-level
  fallback for other languages or parser failure.
- Two-stage review preserves blind preliminary assessment before author context.
  A selective fresh verifier now reconciles every preliminary claim that can
  affect verdict: findings, evidence gaps, and limitations. Runner-owned logic
  derives final verdict, blockers, follow-ups, coverage, and limitations.
- Strict versioned JSON contracts bind snapshot, context map, review-unit plan,
  guidance graph, prompt inputs, verification artifacts, reports, and durable
  run-record events. Resume revalidates persisted identity and charges recorded
  attempts rather than repeating completed stages.
- OpenRouter transport uses strict structured output, explicit privacy/routing
  controls, bounded retry and pacing, conservative token/cost admission, and
  safe diagnostics. Pinned retry now excludes the provider that actually failed
  rather than assuming the failed provider was first in configured order.
- Friendly operations Slices 1 and 2 are complete: model/cost simple settings,
  BASE-owned `.independent-reviewer/rules.md`, guidance admission, exact identity
  binding, provider-free configuration inspection, and legacy JSON compatibility.
- Friendly operations Slice 3 is partial: canonical Codex ancestor discovery,
  Claude direct/scoped rules, bounded BASE-only Claude imports, canonical graph
  presentation, and secret/cap enforcement are implemented.
- Build output is removed with exact-pinned `rimraf` before compilation, avoiding
  stale generated tests and artifacts.

## Verification evidence

At `5ffcec6`:

- `npm run check`: 496 tests passed; configured line, branch, and function
  coverage thresholds passed.
- `npm run test:e2e:dry-run`: 30 tests passed with no provider access.
- `python3 -B scripts/check-ai-context.py --ci`: committed context gate passed.
- `npm run audit:dependencies`: zero vulnerabilities at audit level `high`.

The full 14-case provider-free matrix admitted every case with zero calls and
zero cost. Its separately approved paid run at `5fa4e84` completed 9/14 cases,
and all nine completed reports matched expected human verdicts. It started 37
calls: 27 succeeded, 10 failed, and successful calls reported `$0.007381112`.
Failed-call cost remains unknown. Five cases ended without reports because of
provider 429, 502, or null-content responses; one was amplified by the pinned
retry-selection defect fixed at `5ffcec6`. No paid replay has confirmed that fix.
See [durable ledger live matrix](2026-09-12-durable-ledger-live-matrix.md) for
case-level evidence.

## Remaining friendly-operations track

1. Finish Slice 3 adapters and corpus for Gemini, Kiro, Copilot, Cursor, and
   ignore semantics without weakening BASE authority or frozen-source bounds.
2. Complete Slice 4 steering inspection and format-only lint, including exact
   byte/token/cost presentation and provider-free hard stops.
3. Complete Slice 5 initialization and author-explanation UX, retaining explicit
   and discouraged `--no-author` behavior plus non-interactive automation.
4. Complete Slice 6 user documentation and provider-free multilingual E2E matrix
   across TypeScript, Python, Go, Java, documentation-only, and mixed changes.
5. After provider capacity stabilizes, replay only the five incomplete paid
   cases to separate remaining upstream availability from local recovery.

## Deferred scope and coordination boundary

Semantic symbol mapping beyond current context units, per-unit provider batching,
an evidence tool loop, isolated test workers, broader provider/model pools,
distributed resumability, and PR/MR hosting remain deferred. CCE assists agent
development when exposed but is not a product runtime dependency.

This branch owns V3 adverse-claim verification, runner bookkeeping updates,
clean-build behavior, paid-matrix evidence, and the pinned retry-selection fix.
Parallel bug-fix branches should rebase on the resulting PR or avoid modifying
those areas until it lands.
