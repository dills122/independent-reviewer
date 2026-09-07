# Repository governance

## Default branch

The `main` ruleset targets the default branch. Changes use pull requests and squash merges. Direct pushes, force pushes, and deletion are blocked; commits require verified signatures. There are no bypass actors. Review conversations must be resolved before merging.

Required approvals remain zero while the owner is the only collaborator. Increase this when another maintainer can review. The required `Repository checks` status is bound to the GitHub Actions app (15368), and branches must be up to date before merging. The ruleset payload is retained in `.github/rulesets/main.json`; editing that file alone does not change GitHub settings.

## CI and local checks

`python3 -B scripts/check-ai-context.py --ci` checks committed guidance, retained source hashes, bootstrap shell syntax, and that machine-local skills and review artifacts are not tracked. It works on a clean clone without AI Central. The default command additionally validates local AI Central links and exclusions.

CI runs on pull requests and pushes to main, with read-only permissions, pinned
official Actions, a five-minute timeout, and cancellation of superseded runs.
It installs the committed npm dependency graph on Node.js 24, validates project
context, and runs formatting, lint, strict type checking, build, and application
tests. It performs no external-model requests and retains the stable required
`Repository checks` job name.

## Repository settings

Squash is the only merge method, merged branches are automatically deleted, and squash commit titles use the PR title. Auto-merge is available but must be enabled per PR. Issues stay enabled; documentation lives in the repository rather than a separate wiki. The repository remains public.

GitHub Actions keeps read-only default workflow tokens and cannot approve pull
requests. Dependabot checks pinned Actions and npm dependencies weekly.
Dependency alerts and security updates are enabled; existing secret scanning
and push protection remain enabled. Code scanning can be added as the
application grows.

## Maintenance

Review the rules in GitHub Settings → Rules → Rulesets before changing required checks. Introduce and observe a passing check before making it required. Keep `.github/rulesets/main.json` aligned with deliberate settings changes. Never bypass a failed check just to complete setup.
