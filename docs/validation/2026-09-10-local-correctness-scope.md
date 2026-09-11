# Local-correctness scope live check — 2026-09-10

Standards policy v5 widens scope from selected rules alone to selected rules plus
local correctness, carried by a `rule_local_correctness` REQUIRED rule in the
example profile. Findings still cite a selected ruleId, so no contract, severity
model, or coverage accounting changed.

## Cases

| Fixture | Change | Expected | Result | Cost |
| --- | --- | --- | --- | --- |
| `bug` | `cartTotalCents` computes `subtotal - subtotal * percentOff` with `percentOff` documented 0-100 | REQUIRED finding | Changes requested; REQUIRED against `rule_local_correctness`, correction divides by 100 | $0.002984 |
| `clean` | `cartLineCount` sums `line.quantity` | intended clean | REQUIRED finding: the name says line count, the body returns total quantity | $0.000805 |
| `clean2` | `cartItemQuantity` sums `line.quantity`, doc comment says so | Standards satisfied | Standards satisfied, no findings | $0.000528 |
| `system` | `checkoutTotalCents` passes `STORE_TAX_PERCENT = 8` to `taxCents(amount, rate)`, whose 0.0-1.0 contract lives in an unchanged file | no finding | Standards satisfied, no findings, no limitations | $0.000998 |

The `clean` case was written as a control and is not one: the reviewer was
correct and the fixture was wrong. It is retained because it is the clearest
example of the rule doing its job — a name and a body that disagree.

Same run policy as the [routing batch](2026-09-10-availability-routing-e2e.md):
every run completed, no provider failures, no retries.

## The gap this exposed, and its fix

The `system` case behaved as specified — cross-module behaviour was out of scope,
so no finding was raised. But the report read **Standards satisfied** with
`rule_local_correctness: ASSESSED` and no limitations, on code that overcharges
tax eightfold. The rule text promised judgement over "the changed code together
with the declarations it cites"; capture froze changed paths only, so the second
half was never delivered.

[ADR-007](../decisions/007-capture-cited-declarations.md) captures the unchanged
files a change imports, read-only, at depth one. Re-running the same fixtures
with policy v6:

| Fixture | Referenced context | Result |
| --- | --- | --- |
| `system` — passes `STORE_TAX_PERCENT = 8` to a 0.0-1.0 `rate` | `src/tax.ts`, `src/cart.ts` | Changes requested; REQUIRED, cites `src/checkout.ts:7-9` only, "returns 9000 cents rather than 1080" |
| `clean3` — same imports, passes `STORE_TAX_PERCENT / 100` | `src/tax.ts`, `src/cart.ts` | Standards satisfied, no findings |

The finding anchors to the call site in changed code and cites no referenced
path, which is the intended boundary: referenced sources inform the judgement and
are never themselves reviewed.

Cost rose with the larger prompt, from $0.0005-$0.0010 to $0.0009-$0.0027 per
review on these fixtures.

## What this does not establish

One fixture per case, one model, one small diff. A six-case pass measures that
the rule fires and does not fire where intended on these examples; it does not
measure false-positive rate on real changes, and the `clean` case shows how
easily an intended control turns out to contain a real defect.

Referenced-source capture is unmeasured on a real import graph. These fixtures
import two small files; a change importing a barrel file or a large module will
pull far more, and the 128 KB capture ceiling and shared evidence budget have not
been exercised against one. A follow-up replaced ESM extraction with
`es-module-lexer`, which ignores comments and string literals; ordinary CommonJS
`require()` and malformed-source fallback remain conservatively matched.
