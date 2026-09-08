# Testing and quality gates

## Repository-context gates

Run `python3 -B scripts/check-ai-context.py` after changing integration metadata, imported reference files, or setup scripts. Run `sh -n scripts/setup-ai-context.sh` for shell changes. Verify refresh is non-overwriting and excludes only managed local links. Run the source checkout's `scripts/check.sh` when bootstrapping or updating the source integration.

## Application gates

Use Node.js 24 and the committed npm lockfile. `npm run check` runs formatting,
lint, strict type checking, build, and the Node.js test suite. Run focused tests
during a red-green-refactor cycle and the complete command before committing.
Generated JSON Schema artifacts must match the runtime schemas in the same
change.

The initial application suite covers strict `ReviewRequestV1`,
`SnapshotManifestV1`, and `NeutralReviewBriefV1` parsing; cumulative
working-tree defaults; optional author-packet separation; review-instance
bounds; normalized snapshot paths; capture-race stability; untracked-path and
canonical-input ledgers; Git kind/mode compatibility; meaningful relocations;
blind-brief author-field rejection; unique and source-side-valid evidence
anchors; JSON Schema drift; RFC 8785 canonicalization; SHA-256 vectors; golden
artifact digests; structural-schema disclosure; fail-closed accessor and custom
instance handling; identity normalization; and post-finalization tamper
detection. Git integration tests additionally use temporary real repositories
to cover committed, staged, unstaged, renamed, deleted, untracked, excluded,
and remote-default scope plus content-addressed packet writing, inspection, and
tamper detection. The CLI test proves provider-free `prepare`/`inspect`
composition.

## Expanding runtime gates

Test behavior and trust boundaries: snapshot races, dirty files, rename/delete scope, path traversal and symlink escapes, author-packet withholding, persisted stage transitions, resume behavior, malformed/truncated model output, failed or uncertain transport, exhausted budgets, and stale MR heads. Use mock providers for deterministic integration tests. Keep live provider checks explicitly configured and distinguish them from offline checks.

Verify citations against captured evidence, but do not equate a valid location with a correct finding. Keep known-defect and clean-change evaluation fixtures and measure false positives as well as recall.

Introduce focused deterministic tests as each runtime behavior is implemented.

## Committed repository gate

Run `python3 -B scripts/check-ai-context.py --ci` and `npm run check` for the
clean-clone checks used by GitHub Actions. Run the Python command without `--ci`
to additionally verify local AI Central links. See
`docs/repository-governance.md` for merge rules and required checks.
