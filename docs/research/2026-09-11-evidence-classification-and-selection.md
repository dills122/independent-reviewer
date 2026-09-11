# Evidence classification and selection research

## Status and decision question

Status: accepted 2026-09-11; implemented by ADR-011.

Decision owner: project maintainer.

Question: how should Independent Reviewer represent changed review targets, unchanged supporting evidence, file classification, and exclusions so authoritative non-code evidence can inform a review without becoming a review target?

This matters now because the 2026-09-11 live corpus excluded an explicitly named Markdown registry, while the existing architecture deliberately excludes ordinary documentation to control scope and cost.

Scope: snapshot capture, standards-profile semantics, evidence roles, precedence, and tests. Provider behavior and reviewer-requested evidence round trips remain separate follow-up decisions.

## Executive conclusion

Do not make Markdown generally reviewable and do not reclassify authoritative documents as source or configuration. Preserve deterministic file classification, but add orthogonal artifact roles, a separate capture status, and an explicit typed standards-reference channel.

Recommended model:

- **Classification:** what artifact is (`SOURCE`, `TEST`, `CONFIG`, `DOCUMENTATION`, `STEERING`, `GENERATED`, `BINARY`).
- **Roles:** how captured artifact participates; roles are independent and may coexist (`REVIEW_TARGET`, `SUPPORTING_REFERENCE`).
- **Capture status:** what happened during selection and capture (`CAPTURED`, `OUT_OF_SCOPE`, `UNAVAILABLE`, `OMITTED`).
- **Selection origin:** why disposition was chosen (`CHANGED_PATH_POLICY`, `STANDARD_REFERENCE`, `IMPORT_GRAPH`, `CALLER_INCLUDE`, `CALLER_EXCLUDE`, or hard safety policy).
- **Relationship:** which target or rule needs reference.

Standards `paths` must remain applicability patterns. A new versioned field must declare evidence dependencies; arbitrary filenames in rule prose must never trigger filesystem reads.

## Evidence

### Repository facts and observations

**Documented fact:** `PathRoleV1` is one exclusive classification, and `isReviewableRoleV1` admits only source, test, config, and steering. Documentation, generated, and binary classifications therefore become exclusions before manifest paths are created. See `src/snapshot/path-classification.ts` and `src/snapshot/git-capture.ts`.

**Documented fact:** standards `rules[].paths` currently determines rule applicability. Contract has no field for repository evidence dependencies. See `src/contracts/standards-review.ts` and `src/transmission/neutral-brief-builder.ts`.

**Documented fact:** `referencedSources` is limited to unchanged files imported by changed code. Context map already distinguishes `CHANGED_PATH` from `SUPPORTING_CONTEXT`, so target/reference separation has an existing downstream representation. See `src/contracts/snapshot-manifest.ts`, `src/planning/fallback-context-map.ts`, and ADR-007.

**Observation — live corpus:** supplied-context fixture wrote `API_NAMES.md` after baseline, so Git reported it as untracked. Capture classified it `DOCUMENTATION` and emitted `PATH_POLICY`; final result was `UNABLE_TO_VERIFY` instead of expected `READY`. Artifact: `.review-runs/corpus-rerun-2026-09-11/live/standards/provided-context/snapshot-manifest.json`.

**Observation — corrected baseline experiment:** at commit `2afbf60`, controlled fixture committed `API_NAMES.md` in baseline, changed only `prices.ts`, and ran current standards dry-run/capture. Result: one `SOURCE` review target, zero exclusions, zero omissions, and zero `referencedSources`. An unchanged authoritative document is therefore invisible, not merely misclassified.

Command shape:

```sh
node dist/src/cli.js review --dry-run \
  --repo .review-runs/evidence-selection-research-2026-09-11/repo \
  --base main \
  --standards .review-runs/evidence-selection-research-2026-09-11/standards.json \
  --author .review-runs/evidence-selection-research-2026-09-11/author.md \
  --config .review-runs/corpus-rerun-2026-09-11/config-8192.json
```

Captured result:

```json
{
  "changedPaths": [{ "path": "prices.ts", "role": "SOURCE", "changeType": "MODIFIED" }],
  "referencedSources": [],
  "exclusions": [],
  "omissions": []
}
```

**Inference:** changing `DOCUMENTATION` to a reviewable role would fix only the flawed untracked fixture. It would not make an unchanged registry available and would regress ADR-008's scope and cost goals.

### External primary-source patterns

**Documented fact:** Git attributes assign independent per-path attributes with per-attribute precedence. Git pathspec then separately includes and excludes paths. This supports metadata and selection as separate operations rather than one role deciding both. Sources: [Git attributes](https://git-scm.com/docs/gitattributes), [Git pathspec](https://git-scm.com/docs/user-manual#_pathspec).

**Documented fact:** pre-commit discovers heuristic type tags, while `files`, `exclude`, `types`, `types_or`, and `exclude_types` remain distinct composable selectors. It explicitly documents overriding type filters when path selection must admit an unusual extension. Source: [pre-commit file filtering](https://pre-commit.com/#filtering-files-with-types).

**Documented fact:** SARIF assigns artifacts analysis roles and separately represents an analysis target versus another location relevant to the result. Its example distinguishes a scanned source target from an included header where evidence appears. Source: [SARIF 2.1.0 §§3.24.6 and 3.27.13](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html).

**Documented fact:** GitHub CodeQL documentation warns that workflow path filters decide whether scanning runs, not which files are analyzed; analysis scope has separate configuration. This is another example of keeping similarly named scope concepts explicit. Source: [GitHub code-scanning workflow configuration](https://docs.github.com/en/code-security/reference/code-scanning/workflow-configuration-options).

**Inference:** these systems do not establish one universal schema, but they consistently avoid using a single file-type label as complete participation policy.

## Options

| Option | Correct unchanged references | Preserves scope/cost | Clear target/reference boundary | Contract cost | Assessment |
| --- | --- | --- | --- | --- | --- |
| Make documentation reviewable | No | No | No | Low | Reject |
| Reclassify selected docs as config/source | Only changed files | Partly | No | Low | Reject |
| Capture all safe text and let model choose | Yes | No | Weak | Medium | Reject |
| Treat `rules[].paths` as both applicability and evidence selection | Partly | Partly | Ambiguous | Medium | Reject |
| Add orthogonal roles/status plus typed reference declarations | Yes | Yes | Yes | Medium/high | Recommend |
| Depend only on future reviewer evidence requests | Eventually | Yes | Yes | High latency/complexity | Complement, not replacement |

## Recommended contract direction

Introduce versioned standards profile fields with semantics separate from rule applicability. Illustrative shape, not approved API:

```json
{
  "schemaVersion": 2,
  "references": [
    {
      "id": "reference_api_names",
      "path": "API_NAMES.md",
      "purpose": "Authoritative exported-name registry"
    }
  ],
  "referenceBindings": [
    {
      "ruleId": "rule_registry",
      "referenceId": "reference_api_names",
      "required": true
    }
  ],
  "rules": [
    {
      "id": "rule_registry",
      "appliesTo": ["**/*.ts"]
    }
  ]
}
```

Capture resolves declared references from frozen Git state, applies secret/content/size/symlink safety checks, records digest and selection origin, and transmits safe text as supporting context. Findings remain anchored to review targets; reference paths may support reasoning but are not themselves findings.

Do not infer `references` from rule prose. Profile is caller-selected canonical input, but its contents remain untrusted operational data and must pass repository-bound path validation.

### Proposed precedence

1. Hard safety and representability: secret path/content, path escape, unsupported Git kind, symlink/submodule boundary, unreadable content, and size limit.
2. Explicit caller exclusion. A required-reference conflict becomes visible `UNAVAILABLE`, not silent omission.
3. Explicit typed standards reference or caller include.
4. Static import/dependency reference capture.
5. Default changed-path disposition based on classification and applicable rules.

Classification changes review depth; it does not override steps 2-4.

## Changed-reference authority decision

A declared reference that changes in the same review cannot silently serve as unquestioned authority. Independent review selected this policy:

- capture both BASE and HEAD;
- default normative authority to BASE;
- treat changed HEAD as a review target;
- allow HEAD authority only through unchanged BASE policy or trusted runner-controlled configuration;
- prevent a declaration introduced or modified in HEAD from authorizing itself.

Added references therefore remain review targets but cannot become authoritative during the same review without trusted prior authorization.

## Independent fresh-context review

Review instance 1 of 1 ran in a new projectless task with no implementation conversation or author recommendation. Reviewer first recorded an independent recommendation, then received author recommendation for reconciliation.

Final verdict: **Ready to plan**, provided plan fixes rather than defers:

- multi-valued artifact roles separated from capture status;
- dual-side changed-reference capture with BASE authority by default;
- trusted authorization for HEAD authority and document targeting;
- explicit `{ ruleId, referenceId, required }` bindings;
- versioned standards-profile and manifest migration;
- target-only primary finding-anchor validation;
- visible required-reference failure states;
- ADR-007 and ADR-008 updates;
- modified, added, deleted, renamed, missing, unsafe, and budget-omitted reference tests.

Reviewer noted repository was unavailable in projectless isolation, so repository facts remained supplied evidence rather than independently inspected. External primary sources and architecture reasoning were independently checked.

## Required tests before implementation acceptance

1. Unchanged Markdown registry explicitly declared: captured as supporting reference, rule assessed, no finding may cite registry as changed-code evidence.
2. Missing declared registry: rule `UNASSESSED`, exact unavailable reference recorded.
3. Declared registry excluded by caller: visible conflict and unavailable rule.
4. Secret-bearing or oversized declared registry: bytes never persisted/transmitted; unavailable reason retained.
5. Ordinary unrelated changed documentation: remains out of scope under default policy.
6. Explicitly targeted changed documentation: classified documentation but treated as review target with document-specific review depth.
7. Reference changed in same diff: chosen BASE/HEAD ambiguity policy enforced.
8. Traversal, absolute path, symlink, submodule, and duplicate-reference rejection.
9. Stable digests and identical manifests across repeated capture.
10. `rules[].appliesTo` alone never causes repository reads.

## Confidence and next gate

Confidence: high that current single-axis policy cannot represent required behavior; medium on exact profile shape and changed-reference side semantics.

Next gate: adversarial offline verification followed by a controlled end-to-end review using an explicit profile v2 reference.
