# CI health and security audit

Status: remediated baseline, 2026-09-11.

## Audit result

| Area | Before | Implemented gate |
| --- | --- | --- |
| Format, lint, types, build, tests | Present inside one opaque job; lint warnings did not fail | Separate visible jobs; lint warnings are errors |
| Code coverage | Measured nowhere and had no floor | Node-native coverage with 90% line, 80% branch, and 90% function minimums |
| Dry-run E2E | Covered inside the full suite but not visible as a CI capability | Dedicated provider-free CLI integration job including both dry-run paths |
| Dependency vulnerabilities | Weekly updates only; no blocking advisory check | Full-graph `npm audit` plus pull-request dependency review, blocking at high severity |
| Static security analysis | Not configured | CodeQL `security-extended` for TypeScript/JavaScript and GitHub Actions |
| Scheduled health | Pull requests and main pushes only | Weekly full-pipeline run catches advisory and platform drift |
| Supply-chain permissions | Read-only token and pinned Actions, but checkout and Python setup used legacy Node runtimes | Current Node 24 Actions pinned to full commit SHAs; CodeQL alone can write security events |
| Merge enforcement | One stable required status | Stable aggregate now depends on every applicable granular job |

Full-suite coverage during audit: 92.31% lines, 84.93% branches, and 94.98%
functions across 331 passing tests.

Registry-backed audit reported zero known vulnerabilities at audit time. This
result is point-in-time evidence; CI and the weekly schedule
own continuous enforcement.

## Local verification

```sh
python3 -B scripts/check-ai-context.py --ci
npm run check
npm run test:e2e:dry-run
npm run audit:dependencies
actionlint .github/workflows/ci.yml
```

`npm run audit:dependencies` requires registry access. CI dry runs remain
provider-free and must never read `OPENROUTER_API_KEY` or make model calls.

## Repository settings still verified outside code

Checked-in ruleset JSON documents intended settings but does not apply them.
Confirm GitHub's active ruleset still requires `Repository checks`, dependency
graph remains enabled for dependency review, code scanning accepts CodeQL SARIF,
and secret scanning plus push protection remain enabled. Increase required
approvals from zero when another maintainer can review.
