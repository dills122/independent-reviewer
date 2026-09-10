# Targeted conflicting-standards fix — 2026-09-09

Scope: only the failed distinct-ID conflicting-standards case from the live
batch. No other live scenario rerun. Original rules, code, author overview,
GPT-OSS 120B model, CoreWeave/DeepInfra configuration, 8,192 output-token allowance,
and $0.02 review cap retained.

## Change and verification

Profile-level coverage allowed the model to ignore the other mandatory rule.
Added a required per-rule assessment ledger to preliminary, candidate, and final
standards pilot contracts. Every selected rule must appear exactly once. Conflict
references must name other selected rules reciprocally. Conflicted rules cannot
support code findings; unresolved final conflicts require UNABLE_TO_VERIFY and
limitations. The prompt now compares applicable mandatory rules before findings
and checks proposed corrections against other rules. Markdown exposes the ledger.
Standards policy identity is now v2; legacy v1 contracts remain unchanged.

The omission regression failed before the change. Tests cover missing, duplicate,
unknown and asymmetric rule references, invalid conflict verdicts and findings,
and a complete two-call conflict outcome. `npm run check`: 211 passed.
`python3 -B scripts/check-ai-context.py --ci`: passed.

## Live result

Original: NOT_READY, naming violation, rename recommendation that breaks the
other mandatory rule; no conflict limitation.

After: both rules marked CONFLICT in the blind assessment and final report;
UNABLE_TO_VERIFY, zero code findings, and an explicit limitation explaining the
mutually exclusive naming requirements and absent precedence. Conflict recognition
and classification now match the expected outcome in this one live reproduction.

Three calls, 183.8 seconds, $0.00133878 provider-reported cost, no unknown-cost
calls. No transport retry. One automatic output repair: the first final response
omitted disposition index 0 for the saved preliminary limitation. Existing
validation rejected it and the repair supplied the reference. This was not a
first-final acceptance success.

The live next-action wording still loosely suggested changing code to satisfy
one rule. Closed that narrow presentation issue without another paid call: for
reports where every selected rule is conflicted and no code findings exist,
the runner supplies the workflow action to clarify precedence, applicability, or
exceptions first. It does not select a winning rule or alter the model's findings,
verdict, or explanations. Other reports retain their model-provided actions.
The raw live candidate remains preserved.

A failing regression reproduced the wording gap; full checks still pass (211).
Offline rematerialization of the exact saved live repair response confirms the
correct verdict, zero findings, and clear clarification-only action. This result
is recorded separately as `offline-rematerialized-final.json`; the original live
report was not overwritten. One live reproduction does not prove arbitrary
semantic conflict detection reliable. First-final concern accounting still
needed the existing bounded repair and remains a separate follow-up.

Evidence: `.review-runs/standards-conflict-fix-2026-09-09/conflicting-rules/`.
The original failed run remains untouched in the earlier batch directory.
