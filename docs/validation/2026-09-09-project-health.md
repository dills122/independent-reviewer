# Project health and live E2E check — 2026-09-09

Scope: current `main` at `6998efbd56c485c30fc6b7ccf7bf7b0903da734e`, recent hardening changes, local gates, and bounded synthetic reviews. This is a focused health check, not an exhaustive security audit or a production accuracy benchmark.

## Repository and backlog

- Working tree started clean; GitHub CI passed at the inspected HEAD. Two open PRs are Dependabot updates (#2 and #5).
- GitHub currently lists 24 closed issues and 20 open issues. Recent merged work covers Git isolation/timeouts/literal paths, snapshot helper consistency, atomic packet publication, bounded filesystem concurrency, provider body limits and transport classification, credential filtering, run cost admission, schema construction, shared contract primitives, and CLI contracts.
- Open issues #26, #38, and #53 describe functionality already present in HEAD: CLI help and argument parsing, config-v2/resume documentation, and versioned inspection output. PR #64 has no linked closing issues. Reconcile these statuses after checking each acceptance criterion; no issues were changed during this check.
- Remaining work includes unreadable tracked-file capture (#57), guidance budget accounting (#29), ledger durability and diagnostics (#47/#52), orchestration separation/resume duplication (#17/#18/#19/#49), capture performance (#23/#45), test/coverage/lint depth (#27/#28/#40/#41), package distribution (#51), and packet retention (#54).
- Documentation still contains deferred behavior in current-looking prose: architecture lifecycle step 3 says the model can request evidence reads, despite ADR-005 removing that capability; README's later-scope list says provider fallback is deferred although bounded same-model provider fallback ships.

## Runner-observed local checks

Node 24.19.0, npm 11.17.0; installed direct dependencies match exact pins.

- `npm run check`: 181 tests passed after the fixture fix below. Formatting, lint, strict type checking, build, schema-drift assertions, mock-provider CLI E2E, snapshot integration, and report tests passed.
- Lint retains four warnings and two informational diagnostics: type-only import, unused imports/variable, and string concatenation. The gate permits these; passing does not mean warning-free.
- `python3 -B scripts/check-ai-context.py --ci`: passed.
- `python3 -B scripts/check-ai-context.py`: passed, including 57 local skills and compatibility links.
- `npm audit --json`: zero known vulnerabilities reported. This is registry advisory coverage, not a security guarantee.
- `git diff --check`: passed; CLI `--help` worked; `.env` and private run artifacts are Git-ignored.

Initial `npm run check` failed 1/181: the literal-pathspec test created a fixture commit while inheriting global `commit.gpgsign`. GPG could not access the agent inside the sandbox. Added a fixture-local `commit.gpgsign=false`, matching other test fixtures; the same test then passed under the unchanged host configuration. This does not alter the user's signing settings. Change remains uncommitted on `codex/project-health-e2e-check`.

## Live test design

Only generated synthetic code and fixture requirements/author text were sent. No implementation conversation, memory, repo source, or credential was included in evidence. The key was loaded from the repo-local `.env` by Node and supplied through the existing environment-only provider integration.

Fixtures have a three-line owner-access predicate baseline. Defect variant inverts equality; clean variant introduces an equivalent local variable; steering variant logs identifiers despite an explicit no-logging/no-side-effects rule. Valid input objects with string IDs are specified, avoiding invented input-validation requirements. The author claims checks passed, deliberately contradicted by the defect variant. Actual local evaluation output is stored separately and is not promoted to model-observed verification.

Models: `openai/gpt-oss-20b` and `openai/gpt-oss-120b`. Each run uses 80,000 total token admission, 4,096 maximum output tokens per call, 120-second per-call timeout, and a $0.02 local cost ceiling. Routing allows only `coreweave/fp4` and `deepinfra/bf16`, preserving ZDR, denied data collection, strict structured output, disabled response caching, and disabled compression. Public endpoint metadata was checked before calls. Normal order is CoreWeave then DeepInfra; one diagnostic reverses that order. This is provider preference, not proof of which provider served a call.

Prices are capped at $0.03/$0.14 per million prompt/completion tokens for 20B and $0.037/$0.17 for 120B, with zero per-request price. Six runs imply at most $0.12 in configured local ceilings, not a guarantee of external billing. Existing one-time final repair remains enabled; there were no automatic whole-run retries or resumes of uncertain submissions.

Private reproducibility artifacts: `.review-runs/health-2026-09-09/`, including requests/configs, frozen packets, raw provider responses, preliminary assessments, final reports where valid, run ledgers, local-check log, runner-observed fixture output, and `reproduce.mjs`. Reproduction makes paid calls and requires a fresh output location; it is not part of the offline test suite.

## Findings from live runs

1. CoreWeave 20B returned valid blind assessments for defect and clean fixtures, then `finish_reason: stop` with `message.content: null` on both final calls. Usage and nonzero cost were present. The runner correctly returned exit 1 and published no final report. This is not an output-token-cap failure in those two responses.
2. The DeepInfra-first 20B control actually fell back to CoreWeave for both stages. Its final response reached the 4,096-token cap (`finish_reason: length`) and was rejected. The experiment therefore does not isolate DeepInfra behavior; raising the output cap would not explain the preceding null-content failures.
3. 120B's defect run found the inverted predicate, rejected a mismatched author-verification claim in its first final candidate, and produced a valid Not ready report after one repair. Final report retained the defect and contradicted the false author test claim. Its three calls took about 148 seconds overall.
4. Failed-response audit gap: null/truncated responses retain usage, provider, and response ID in the private raw JSON, but `CALL_FAILED` retains only generic error details. Summing only `CALL_SUCCEEDED.usage` understates observed billed usage. Result costs below include all raw response usage, including rejected calls; they are provider-reported, not settled account charges. Preserve sanitized validated metadata for rejected completions in the ledger before expanding production use.

5. All three 120B runs needed final repair for exact author-claim copying. On the clean and steering cases, the model changed the ASCII hyphen in `non-owner` (U+002D) to a non-breaking hyphen (U+2011). Repair fixed the clean run but repeated the mismatch in the steering run. The steering preliminary correctly identified identifier logging and side effects as P1 findings, yet no valid final report could be published. Preserve strict provenance checks; improve exact input-bound field generation or deterministic ledger assembly instead of silently normalizing evidence.

## Completed results

| Fixture | Model / requested order | Final outcome | Calls | Elapsed | Reported cost USD |
| --- | --- | --- | ---: | ---: | ---: |
| Inverted access predicate | 20B / CoreWeave first | Rejected: null final content | 2 | 17.6 s | 0.000433020 |
| Clean refactor | 20B / CoreWeave first | Rejected: null final content | 2 | 7.5 s | 0.000273190 |
| Clean refactor diagnostic | 20B / DeepInfra first; actually CoreWeave | Rejected: final output limit | 2 | 34.2 s | 0.000840940 |
| Inverted access predicate | 120B / CoreWeave first | Not ready; correct defect, repaired claim ledger | 3 | 147.6 s | 0.000840645 |
| Clean refactor | 120B / CoreWeave first | Ready; no findings, repaired claim ledger | 3 | 77.0 s | 0.000715010 |
| Steering violation | 120B / CoreWeave first | Rejected: claim text mismatch survives repair | 3 | 122.7 s | 0.001027890 |

Total: 15 provider calls, 55,833 reported tokens, **$0.004130695 reported cost**, including rejected outputs. Two of six runs produced validated final reports, both after repair. No first final candidate was accepted. All six preliminary assessments were valid: both defect runs detected the bug, all three clean runs had zero findings, and the steering run detected its violations. These are tiny, partly repeated fixtures within one model family; do not infer general recall, false-positive rate, or a stable model ranking.

All six frozen packets passed CLI inspection. Private review artifacts were checked for the actual credential without printing it; none contained it. Blind briefs did not contain the author test claim. Every author-delivery event followed preliminary persistence. The engine failed visibly and did not emit a successful final report for null, truncated, or semantically mismatched responses.

## Next steps

1. Prioritize exact author-claim field reliability. Add a deterministic regression using the observed U+002D/U+2011 mismatch, then improve constrained generation or server-owned provenance fields while preserving identity validation. A cheap formatting substitution currently consumes a repair or loses the entire review.
2. Isolate CoreWeave null final completions with a bounded provider-specific diagnostic. The DeepInfra-first control fell back, so it does not establish an alternative reliable route. Do not simply raise output limits to address the null-content cases.
3. Preserve validated usage/route/response IDs on rejected responses in the durable ledger and surface them in failure summaries. Keep raw artifacts private and do not treat missing accepted-call usage as zero spend.
4. Reconcile stale issue states and documentation; then address capture failure and ledger durability before expanding real-repository evaluations.
5. Rerun this small acceptance set after targeted fixes. Broader repository/model comparisons should follow reliable final-report production rather than spending on a larger matrix now.

No commits, pushes, PRs, issue edits, or model-report publication were made. The only application-tree edit is the one-line test fixture signing fix; this report is the additional documentation artifact.
