# Whitespace diagnostic batch — 2026-09-09

Status: offline probe verified; three live submissions completed. Two unchanged
CoreWeave final replays passed. DeepInfra returned 502. No whitespace-loop
reproduction in this batch and no production change or claimed fix.

## Offline verification

A private harness now stores request/audit identity before submission, then raw
response and outcome before semantic analysis. It accepts object and string
response bodies, preserves non-JSON provider errors, and records absent usage
as unknown. Each attempt uses an exclusive directory. The harness bounds the
batch to six submissions, 160,000 conservative reserved tokens, and $0.02
reserved cost. Unknown-cost attempts retain their full reservation.

Offline checks exercised the saved successful clean final, saved whitespace
length failure, a mocked JSON 429, a non-JSON 502, uncertain transport, and a
syntactically complete candidate with missing changed-path coverage. The last
case was rejected through the existing orchestrator's validation path. No live
repair calls are possible during offline validation. Whitespace metrics count
JSON formatting outside quoted strings and handle escaped quotes/backslashes.

Saved-good validation used its own frozen clean packet and original config;
live exception validation used the frozen exception packet. Replaying a provider
response through a packet copy invokes existing candidate materialization,
semantic checks, and source validation. This is not a new blind review.

## Live outcomes

| Submission | Route | Result | Completion tokens | Longest formatting run | Seconds | Reported cost |
| --- | --- | --- | --- | --- | --- | --- |
| A | CoreWeave/fp4 | Valid READY, zero findings | 751 | 9 characters | 15.4 | $0.00020276 |
| B | DeepInfra/bf16 | Provider 502; no comparison | Unknown | Not applicable | 0.4 | Unknown |
| A repeat | CoreWeave/fp4 | Valid READY, zero findings | 742 | 14 characters | 20.3 | $0.00020123 |

Each call used the exact reconstructed final review request, with only provider
routing pinned. No prompt, model, schema, sampling, output budget, or evidence
change was introduced. The original assistant preliminary content remained in
the conversation. No preliminary provider calls or automatic retries occurred.
The repeat A was selected explicitly after B failed and A completed, to check
intermittency before considering a changed-prompt comparison.

Both CoreWeave results passed full existing review validation. Manual inspection
confirmed the exception judgment: the adjacent @publicApiStable annotation
permits the single-letter API name under the selected rule. The first result
used an empty authorClaims array but explained the author's exception argument
in its rule assessment; current contracts accept this. It is not evidence of
new author-ledger enforcement.

Known cost totals $0.00040399, plus one unknown-cost DeepInfra attempt. Aggregate
reservation was $0.006236304 and 80,208 tokens, below the planned bounds.

## Interpretation and stop decision

The original bad response and these good responses share identical review
content and schema. The generation failure is therefore intermittent under the
observed endpoint configuration. Two clean replays do not establish long-term
reliability, eliminate schema sensitivity, or prove provider internals unchanged.
The DeepInfra 502 prevents a deployment comparison; it is not evidence about
DeepInfra generation quality.

Stop after three calls. Adding schema text or compact-output instructions now
would compare a changed request with a currently successful baseline, offering
weak causal evidence. No production fix was tested. Preserve the original
failure instead of treating these replays as retroactive completion of its run.

Next external evidence needed: whether the original failing generation and new
successful ones used the same backend/version, prompt template, schema delivery,
sampling defaults, and whitespace constraints. A private support draft identifies
the original generation and asks these concrete questions. It has not been sent.
If provider evidence identifies a relevant control or deployment difference,
resume with one controlled comparison. Streaming protection remains separate.

## Artifacts and checks

Private batch root: `.review-runs/whitespace-batch-2026-09-09/`.
Contains `run.mjs`, six offline cases, exclusive attempt requests/raw/outcome
records, and offline validation packets/reports. Original failure artifacts
remain unchanged. Support draft: `support-draft.md` in that private directory.

Repository-context CI check and git whitespace check passed. No application
source/schema changes; application suite was not needlessly rerun. The unrelated
user-configuration research note remains untracked.
