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

## The gap this exposed

The `system` case behaved as specified — cross-module behaviour is out of scope,
so no finding was raised. But the report reads **Standards satisfied** with
`rule_local_correctness: ASSESSED` and no limitations, on code that overcharges
tax eightfold. The model's own explanation says it assessed the rule "based
solely on the changed code", which is exactly what the policy asks of it.

The rule text promises judgement over "the changed code together with the
declarations it cites". The evidence packet does not deliver the second half:
only changed paths are captured, so an imported signature and its doc comment are
invisible and the reviewer cannot check a call against the contract it targets.

Recording every unseen import as a limitation is not a usable fix.
`validateReportStructure` makes any limitation block both ready verdicts, so a
review of ordinary code that imports anything would return UNABLE_TO_VERIFY.

Unresolved. Options are recorded for decision, not chosen here:

1. Leave the boundary and make the standing scope note carry the warning
   (implemented in the report footer; no evidence change).
2. Capture the declarations — signature plus doc comment — of symbols the changed
   code imports from unchanged files, making the promised boundary real.
3. Treat an unverifiable cross-module call as an evidence gap rather than a
   limitation, if evidence gaps can be made not to block a ready verdict.

## What this does not establish

One fixture per case, one model, one small diff. A four-case pass measures that
the rule fires and does not fire where intended on these examples; it does not
measure false-positive rate on real changes, and the `clean` case shows how
easily an intended control turns out to contain a real defect.
