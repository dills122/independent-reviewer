# Targeted missing-context fix — 2026-09-09

Original live result correctly said UNABLE_TO_VERIFY but invented a REQUIRED
finding for the missing API_NAMES.md registry and suggested creating accepted
standard content. This follow-up addresses that failure alone.

Added UNASSESSED to the per-rule ledger. An unassessed rule cannot support any
finding, irrespective of enforcement level. Final unassessed rules require an
unable-to-assess verdict and limitations identifying the missing evidence. For
all-unassessed/no-finding reports, runner next actions request existing evidence
instead of changing code or inventing a standard. Policy v3 explicitly separates
evidence availability from compliance. Legacy contracts remain unchanged.

Regression reproduced the guard accepting a finding against an unassessed rule
before the fix. Offline tests cover prohibited findings, passing verdicts,
missing limitations, and the composed CLI result. Full application checks: 212
tests passed. Repository CI-context check passed. Generated schemas updated.

## Live missing-context reproduction

Same frozen synthetic scenario and GPT-OSS 120B configuration as before, with
CoreWeave/DeepInfra routing, 8,192 maximum output tokens and $0.02 run cap.
Both assessments now mark rule_registry UNASSESSED, identify unavailable
API_NAMES.md, and contain zero findings. Final UNABLE_TO_VERIFY retains the
missing-source limitation and requests existing authoritative evidence.

Three calls, 70.7 seconds, $0.00063624 reported cost; no unknown-cost calls or
transport retries. One automatic repair was needed: first final response omitted
the disposition for preliminary limitation index 0. That separate bookkeeping
issue remains; this is semantic success after repair, not first-final success.

A companion supplied-evidence case includes the registry as captured source,
with its path explicitly in the selected profile so the capture is fully
assessable. It asks the same exported-name question and expects READY. This is
a positive control for available evidence, not a rerun hiding the original failure.

Private runner, requests, raw responses, reports, and ledgers:
`.review-runs/standards-uncertainty-fix-2026-09-09/`.

Companion result: READY, zero findings, zero limitations, rule_registry ASSESSED
with an explanation matching `sumPrices` to the supplied registry. Two calls,
44.4 seconds, $0.00043471 reported cost, no repair or transport retry. Both cases
match their expected semantic outcomes. Combined: five calls, $0.00107095
reported cost, no unknown-cost calls, within the $0.04 combined reservation.
These two fixtures demonstrate the intended distinction; they do not establish
accuracy across arbitrary missing-context situations.
