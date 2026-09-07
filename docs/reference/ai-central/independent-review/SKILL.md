---
name: independent-review
description: Prepare and conduct a fresh-context engineering review of completed or substantially complete work, covering both the code changes and the implementation plan. Use when an implementation chat must explain its approach for a senior-maintainer review, when that explanation and repository scope will be handed to a brand-new chat for independent assessment, or when reviewing whether completed work is correct, well-designed, idiomatic, sufficiently tested, and faithful to its plan. Do not use as a substitute for ordinary in-session self-checks or for a review that intentionally shares the author's full conversation history.
---

# Independent Review

Separate the author's explanation from the reviewer's judgment. Use one role at a time: prepare the review handoff in the implementation task, then conduct the review in a brand-new task with no inherited conversation history.

## Protect Independence

- Start the reviewer in a new task, not a fork, continuation, or subagent that inherits the implementation conversation.
- Treat the author's explanation as testimony to verify, not as repository truth or an approval recommendation.
- Reconstruct the scope from the repository, canonical requirements, plan, Git state, code, tests, and executed checks.
- Inspect the implementation before reading the author's rationale whenever the bootstrap and explanation can be passed separately. Record the preliminary concerns first.
- State when a blind first pass was impossible because the explanation was already present in the reviewer context.
- Keep the review read-only by default. Do not fix findings, alter the plan, stage changes, or create commits unless the user separately asks.

## Role A: Prepare The Author Explanation

### Freeze The Review Target

Inspect applicable `AGENTS.md`, canonical requirements, implementation plan, Git status, branch, base or checkpoint, commits, and changed files. Define:

- the objective and observable success criteria;
- the exact base and head or the explicit working-tree boundary;
- in-scope and excluded files, commits, requirements, and plan items;
- relevant specs, ADRs, plans, migrations, generated artifacts, and external contracts;
- verification already executed, including failures and environmental limitations.

Do not hide dirty or untracked files. Do not commit or stage work merely to make the review target cleaner. If the implementation changes materially while preparing the explanation, freeze the new scope and refresh the handoff.

### Explain The Work Like An Author Before A Maintainer

Answer the questions a skeptical senior maintainer would ask. Be concrete and admit uncertainty.

1. **Intent:** What problem was solved, for whom, and what behavior should now differ?
2. **Plan:** Which plan items and acceptance criteria were implemented, changed, deferred, or abandoned?
3. **Approach:** What is the end-to-end control, data, or dependency flow?
4. **Walkthrough:** What responsibility does each materially changed file or component now own?
5. **Choices:** Why does the approach fit existing repository patterns? Which realistic alternatives were rejected and why?
6. **Invariants:** Which compatibility, security, privacy, concurrency, data-integrity, performance, or operational properties must hold?
7. **Verification:** Which tests and checks exercise the behavior, which important cases remain untested, and what was observed rather than assumed?
8. **Costs:** What complexity, coupling, migration burden, or maintenance debt did the implementation introduce?
9. **Limits:** What is incomplete, risky, environment-dependent, or deliberately out of scope?
10. **Challenge points:** Where should a reviewer apply extra skepticism without limiting the review to those areas?

Describe code and plan evidence with paths, symbols, task IDs, commands, and results. Distinguish facts from author rationale and inference. Never issue the final readiness verdict in the author phase.

### Produce Two Separate Packets

Prefer the repository's existing review-artifact convention when the user requests a durable handoff. Otherwise return two clearly separated blocks in the response. Keep the neutral bootstrap separable from the author explanation so the reviewer can perform a blind first pass.

Use this bootstrap:

```markdown
# Fresh Review Bootstrap

## Review Objective
## Repository And Worktree
## Base, Head, Branch, And Dirty State
## In-Scope Commits And Paths
## Canonical Requirements And Plan
## Explicit Exclusions
## Verification Commands Available To Reviewer
## Author Explanation Location Or Delivery Step
```

Use this author packet:

```markdown
# Author Explanation

## Intent And Success Criteria
## Plan-To-Implementation Traceability
## Technical Approach And Flow
## Changed-Component Walkthrough
## Decisions And Rejected Alternatives
## Invariants And Boundary Conditions
## Verification Performed And Results
## Risks, Tradeoffs, And Maintenance Costs
## Deviations, Deferrals, And Known Gaps
## Challenge Points For The Reviewer
```

End with this clean-task instruction:

```text
Use $independent-review in reviewer mode. This is review instance <N> of <MAX>. Work from the Fresh Review Bootstrap first and record a preliminary review before reading the Author Explanation. Then verify the explanation against the repository, review both the implementation and its plan, run proportionate non-mutating checks, and return an evidence-backed verdict. Do not implement fixes, create further review instances, or split the work into new workstreams.
```

## Role B: Conduct The Independent Review

### Establish Ground Truth

1. Read applicable repository instructions and the canonical requirements and plan.
2. Verify the repository, worktree, base, head, branch, dirty state, commits, and paths named by the bootstrap.
3. Resolve the actual diff and classify missing, extra, generated, vendored, or unrelated changes.
4. Inspect tests and acceptance criteria before relying on implementation details.
5. Record a preliminary findings ledger before reading the author explanation when separation is possible.

Stop and report an unverifiable scope instead of silently reviewing the wrong diff. Ask only for information that cannot be recovered from the repository or handoff.

### Review The Implementation And Plan

Evaluate the smallest relevant surrounding context, not only changed lines:

- requirement and acceptance-criteria coverage;
- correctness, error paths, boundary cases, state transitions, and regression risk;
- architecture, ownership, dependency direction, abstraction cost, and repository consistency;
- naming, readability, maintainability, style, and unnecessary complexity;
- security, privacy, data integrity, concurrency, performance, and operational behavior where relevant;
- test quality, missing cases, failure sensitivity, and whether claimed checks prove the intended behavior;
- plan completeness, task ordering, dependencies, rollout, migration, rollback, observability, documentation, and unresolved decisions;
- divergence between the plan, code, tests, configuration, and retained documentation.

Do not reject a sound change merely because another design is possible. Tie style findings to repository conventions or a concrete maintenance cost. Report pre-existing problems separately unless the change worsens or newly exposes them.

Run proportionate non-mutating verification when feasible. Report the exact commands and outcomes. Never convert an unexecuted check into a passing claim.

### Digest The Author Explanation

After the independent pass, turn material author claims into a claim ledger:

| Author claim | Evidence inspected | Status | Review consequence |
| --- | --- | --- | --- |
| `<claim>` | `<path, symbol, test, or command>` | Confirmed / Contradicted / Unverified | `<impact>` |

Use the explanation to discover intent and rationale, then test it against the implementation. Look especially for omissions: changed behavior the explanation does not mention, plan deviations presented as completion, tests that do not exercise the claimed path, and tradeoffs asserted without evidence.

### Report Findings First

Order actionable findings by severity:

- **P0 — Critical:** immediate security, data-loss, or broadly catastrophic failure;
- **P1 — High:** incorrect core behavior, major regression, unsafe migration, or a plan gap that blocks safe delivery;
- **P2 — Medium:** real defect or maintainability risk that should be corrected but is not an immediate blocker;
- **P3 — Low:** bounded improvement with concrete value; exclude subjective nits.

For every finding include a concise title, evidence with a precise path and line or symbol, the failing scenario, impact, and the smallest credible correction. Do not inflate severity to make the review look useful. If no actionable findings remain, say so explicitly and describe residual uncertainty.

Finish with:

```markdown
## Findings
## Plan Review
## Author-Claim Reconciliation
## Verification Performed
## Open Questions And Residual Risks
## Verdict
## Recommended Next Actions
```

Choose one verdict: `Ready`, `Ready with non-blocking follow-ups`, `Not ready`, or `Unable to verify`. A ready verdict requires evidence against both the implementation and the plan, not merely passing tests or a persuasive author explanation.

## Bound The Review Loop

Treat each fresh-context reviewer pass as one review instance. Default to at most three review instances for the complete implementation flow, counting the initial review. Honor a different limit only when the developer or worker task that initiated the review flow explicitly sets it; a reviewer, follow-up reviewer, or newly created task must not raise its own limit.

Include `Review instance: <N> of <MAX>` in every bootstrap and report. Return each report to the initiating task before another instance begins. That task decides whether fixes materially changed reviewed behavior and justify another independent pass. Do not create a replacement reviewer merely because the verdict is unfavorable or the remaining budget allows one.

When the configured maximum is reached, stop the review loop. Return remaining findings, unresolved risks, the last verdict, and the reason no further review instance will start to the initiating task for the human in the loop. Do not silently reset the count by creating a new task or changing delivery units.

## Stop For A Heavy Pivot

Hard-stop the flow when a review concludes that credible remediation requires a heavy pivot, including splitting the implementation into separate workstreams, materially replacing the agreed architecture or plan, or expanding scope beyond the review target. The reviewer must not dispatch those streams, implement the pivot, or start another review instance.

Return a decision gate to the initiating developer or worker task with:

- the evidence that makes the pivot necessary;
- the proposed workstreams or material plan change;
- affected requirements, scope, dependencies, and review-count state;
- risks of proceeding and of ending the flow;
- the exact approval needed from the human in the loop.

The initiating task must surface that gate to the human. Continue only after explicit human approval, using any revised review limit the human or initiating task specifies. If approval is denied or unavailable, end the flow with the current verdict and residual risks; do not continue recursively.

## Close The Loop

Return the independent report to the implementation task. Let that task respond finding by finding with `Accept`, `Dispute with evidence`, or `Defer with owner and rationale`. Require a new independent pass when fixes materially change reviewed behavior, architecture, migration, or plan scope, subject to the configured review-instance limit and heavy-pivot gate.
