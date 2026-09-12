# Bounded changed-file context E2E

## Goal

Check whether language-neutral changed-file source windows fix a live review that
could capture a security test but could not assess its intended behavior from a
three-line unified hunk alone.

## Frozen target

- Base: `a3e3502`
- Target: `09cdb1a`
- Changed path: `test/snapshot/git-capture.test.ts`
- Classification: `TEST`
- Exclusions and omissions: none
- Model profile: `openai/gpt-oss-120b`
- Selected profile: `examples/standards.javascript-typescript.json`

Both runs reviewed the same committed one-file target. Preliminary assessment is
author-blind, so its result isolates the evidence change. Provider sampling is
not deterministic, and final author packets were not byte-identical; this is a
focused replay, not a statistically controlled model benchmark.

## Before bounded source context

- Initial evidence: one 1,069-byte unified hunk.
- Dry-run reservation: 176,757 token units and `$0.040613` maximum cost.
- Preliminary result: required local-correctness rule `UNASSESSED`; reviewer said
  surrounding assertions and intended test semantics were unavailable.
- Final verdict: `UNABLE_TO_VERIFY`, no findings.
- Provider calls: two successful calls, no repair.
- Provider-reported cost: `$0.000747`.

## After bounded source context

- Initial evidence: same 1,069-byte unified hunk, 945-byte BASE window at lines
  438-462, and 1,176-byte HEAD window at lines 440-470.
- Evidence constraints: none.
- Dry-run reservation: 188,683 token units and `$0.041806` maximum cost.
- Preliminary result: every selected rule `ASSESSED`; no evidence gaps or
  limitations.
- Final verdict: `READY`, no findings or limitations.
- Provider calls: two successful calls, no repair.
- Provider-reported cost: `$0.000866`.

## Result

Bounded source context changed this target from unassessable to fully assessed.
Incremental provider-reported cost was `$0.000119`; conservative reservation
increased by 11,926 token units and `$0.001193`. Exact BASE and HEAD windows were
digest-bound, citable evidence, and no whole-file payload was needed.

Next validation should replay a small multilingual corpus with clean and planted
defect cases. Measure required-rule assessment rate, finding precision, recall,
evidence bytes, repairs, and cost before changing the 12-line radius.
