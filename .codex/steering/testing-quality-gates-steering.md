# Testing and quality gates

## Current setup phase

Run `python3 -B scripts/check-ai-context.py` after changing integration metadata, imported reference files, or setup scripts. Run `sh -n scripts/setup-ai-context.sh` for shell changes. Verify refresh is non-overwriting and excludes only managed local links. Run the source checkout's `scripts/check.sh` when bootstrapping or updating the source integration.

## Future runtime gates

Test behavior and trust boundaries: snapshot races, dirty files, rename/delete scope, path traversal and symlink escapes, author-packet withholding, persisted stage transitions, resume behavior, malformed/truncated model output, failed or uncertain transport, exhausted budgets, and stale MR heads. Use mock providers for deterministic integration tests. Keep live provider checks explicitly configured and distinguish them from offline checks.

Verify citations against captured evidence, but do not equate a valid location with a correct finding. Keep known-defect and clean-change evaluation fixtures and measure false positives as well as recall.

No application test suite or build exists yet. Document that limitation instead of inventing passing commands. Introduce focused tests as runtime behavior is implemented.

## Committed repository gate

Run `python3 -B scripts/check-ai-context.py --ci` for the clean-clone checks used by GitHub Actions. Run without `--ci` to additionally verify local AI Central links. See `docs/repository-governance.md` for merge rules and required checks.
