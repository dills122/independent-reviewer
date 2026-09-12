# Backlog contract-hardening execution

Status: complete. Integration branch: `codex/backlog-contract-hardening`.

Objective: clear the highest-return correctness work that should precede the
remaining friendly-operations adapters without overlapping the externally owned
secret-detector work in issue #115.

| ID | Work | Dependency | Delivery unit | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| BH-1 | Fix explicit model identity validation (#93) | None | Internal subagent | Pinned slugs containing `auto` pass; router and moving aliases fail case-insensitively | Complete (`3898b98`) |
| BH-2 | Make CLI dispatch exhaustive (#104) | None | Internal subagent | Registered commands cannot fall through to `resume-final`; incomplete `config` has actionable usage | Complete (`32a17a2`) |
| BH-3 | Add one strict JSON admission boundary (#111) | BH-1 and BH-2 integrated | Internal subagent | External and persisted JSON rejects duplicate members, comments, trailing commas, and malformed input before Zod | Complete (`296fac6`, `655fa62`, `02e6075`, `495ca3f`) |
| BH-4 | Repair standards-profile diagnostics (#94) | BH-3 | Same owner as BH-3 | Syntax, schema, and identifier conflicts are distinct; rejected profiles cannot poison later inputs | Complete (`495ca3f`) |
| BH-5 | Reconcile fixed or superseded issues | Evidence from merged code and tests | Lead task | Close #67, #69, and #102 with evidence; narrow #68 and #103 to remaining scope | Complete |
| BH-6 | Remediate independent-review findings | BH-3 | Separate implementation owners | JSONL avoids eager line-array amplification; provider rejects invalid UTF-8 and retains only safe failure metadata | Complete (`c3a1539`, `5339945`) |

Issue #115 is explicitly excluded because another implementation task owns it.
Issue #29 belongs to steering-budget Slice 4; #47 requires a dedicated ledger
slice; #86 belongs with package/distribution hardening.

Verification: focused red/green tests per work item, then `npm run schemas:write`,
`npm run check`, `npm run test:e2e:dry-run`, `npm run audit:dependencies`, and
`python3 -B scripts/check-ai-context.py --ci` before delivery.

Completion evidence: generated schemas had no drift; `npm run check` passed 461
tests and coverage gates; provider-free E2E passed 29 tests; dependency audit
reported zero vulnerabilities; repository-context CI check passed.
