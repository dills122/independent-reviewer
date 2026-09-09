# Repeat scenarios and larger refactor — 2026-09-09

Starting implementation committed as `08258da`. Eight existing scenarios were
repeated once with prompt v6 and the existing GPT-OSS 120B configuration.

## Repeat results and targeted fixes

Six of eight runs completed. The clean single-file run failed with a DeepInfra
502 during repair; the misleading-author run timed out at 120 seconds with
submission outcome unknown. Both failures remain recorded. Fresh sequential
reviews completed after increasing the example per-call timeout to 180 seconds;
no uncertain attempt was resumed. The $0.02 per-review admission cap is unchanged.

One completed cross-file report contained a false positive: harmless rounding
was classified P2 despite its own explanation stating correctness was unaffected.
Prompt v7 directs harmless cleanup to optional fast follows. Its targeted rerun
returned only the genuine 100× conversion defect.

Across the original runs and targeted reruns, all eight scenarios produced their
expected results: clean cases remained clean, planted defects were detected,
logging stayed one combined finding, and misleading author input was rejected.
This does not mean all eight passed on their first attempt or under final prompt v8.

## Larger scenarios

An order-service refactor replaces one module with eight modules totaling 98
HEAD source lines. It covers line aggregation, inventory, pricing, discounts,
shipping, payment recording, receipt storage, and orchestration. Requirements
explicitly scope this to synchronous in-memory operations. Expected outcomes and
before/after execution probes remain outside reviewer inputs.

- **Buggy refactor:** both planted P1 defects found, no extras: tax applied before
  discount and replay protection checked after inventory/payment mutations.
  Completed with prompt v7 in two calls, 95.8 seconds, reported $0.001086940.
- **Clean refactor:** initial run reported no findings but marked all files
  UNASSESSED while saying READY; repair repeated the contradiction. Prompt v8
  clarifies that source inspection does not require executing tests. Targeted
  rerun returned READY, no findings, in two calls, 137.8 seconds, $0.001279260.

No validation layers or new tests added. The existing reservation fixture allowance
was updated for prompt length. `npm run check` passes all 190 tests.

## Cost and limits

Fourteen runs including failures and targeted reruns made 33 provider calls.
Reported cost totals **$0.011605844**. Two failed calls have unknown cost, so this
is incomplete telemetry, not a final bill. Every run retained its $0.02 admission
ceiling. Completed runs ranged from about 52 to 222 seconds; some needed repair.

Useful review quality is demonstrated on these fixtures. First-attempt reliability
and latency remain limitations; provider errors and inconsistent model metadata
were not eliminated. No additional broad runs were made after targeted fixes.

Private artifacts:

- `.review-runs/repeat-2026-09-09/` — original eight runs and combined summary.
- `.review-runs/repeat-recovery-2026-09-09/` — targeted follow-ups.
- `.review-runs/larger-2026-09-09/` — larger fixtures, expectations, and reports.

Example larger review from repository root (use a new output directory):

```sh
node --env-file=.env dist/src/cli.js review \
  --request .review-runs/larger-2026-09-09/order_bugs/request.json \
  --config examples/review-config.gpt-oss-120b.json \
  --output .review-runs/manual-order-review-01
```
