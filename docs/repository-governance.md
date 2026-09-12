# Repository governance

## Default branch

The `main` ruleset targets the default branch. Changes use pull requests and squash merges. Direct pushes, force pushes, and deletion are blocked; commits require verified signatures. There are no bypass actors. Review conversations must be resolved before merging.

Required approvals remain zero while the owner is the only collaborator. Increase this when another maintainer can review. The required `Repository checks` status is bound to the GitHub Actions app (15368), and branches must be up to date before merging. The ruleset payload is retained in `.github/rulesets/main.json`; editing that file alone does not change GitHub settings.

## CI and local checks

`python3 -B scripts/check-ai-context.py --ci` checks committed guidance, retained source hashes, bootstrap shell syntax, and that machine-local skills and review artifacts are not tracked. It works on a clean clone without AI Central. The default command additionally validates local AI Central links and exclusions.

CI runs on pull requests, pushes to main, a weekly health schedule, and manual
dispatch. Granular jobs validate project context; formatting, lint, and strict
types; the build and full test suite with minimum 90% line, 80% branch, and 90%
function coverage; and provider-free CLI dry-run E2Es. Superseded runs are
cancelled, dependencies are cached, jobs have explicit timeouts, and no job
makes an external-model request.

Security jobs reject high or critical vulnerabilities in the full npm graph,
review pull-request dependency changes, and run CodeQL `security-extended`
analysis over TypeScript/JavaScript and GitHub Actions. Workflow permissions are
read-only except the CodeQL job's scoped `security-events: write` permission.
All external Actions are pinned to full commit SHAs and updated by Dependabot.

The final aggregate retains the stable required `Repository checks` job name
and fails unless every applicable job succeeds. The checked-in main ruleset
therefore continues to enforce every gate through one durable status context.

## Repository settings

Squash is the only merge method, merged branches are automatically deleted, and squash commit titles use the PR title. Auto-merge is available but must be enabled per PR. Issues stay enabled; documentation lives in the repository rather than a separate wiki. The repository remains public.

GitHub Actions keeps read-only default workflow tokens and cannot approve pull
requests. Dependabot checks pinned Actions and npm dependencies weekly.
Dependency alerts and security updates are enabled; existing secret scanning
and push protection remain enabled. CodeQL findings publish to code scanning.
See [CI health and security audit](ci-health-and-security.md) for gate rationale
and remaining repository-setting work.

## Maintenance

Review the rules in GitHub Settings → Rules → Rulesets before changing required checks. Introduce and observe a passing check before making it required. Keep `.github/rulesets/main.json` aligned with deliberate settings changes. Never bypass a failed check just to complete setup.
