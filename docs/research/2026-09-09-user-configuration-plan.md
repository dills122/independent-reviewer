# Versioned user configuration and tuning

Tracking: https://github.com/dills122/independent-reviewer/issues/71

Status: research-backed proposal, not implemented. Owner: project maintainer.
Inspected baseline: `e6b3872`, 2026-09-09. Scope: plan and GitHub issue only;
no runtime changes, dependencies, provider calls, or changes to existing limits.
Decision question: how can users tune review behavior without editing TypeScript
or weakening the meaning of a validated review? Stop condition: bounded source
comparison, concrete implementation slices and acceptance criteria.

## Recommendation

Offer YAML 1.2 for human editing and preserve JSON for automation. Both load into
one strict, versioned runtime configuration with documented defaults, validation,
and a canonical resolved-config digest. Prefer `reviewer.yaml` explicitly selected
through `--config` or saved by `init`. Do not silently trust a newly discovered
file from the code under review to change paid-call settings.

Compare options: JSON-only has no new parser dependency but is awkward for
annotated examples; YAML+JSON improves editing and keeps machine compatibility at
the cost of one parser and a tightly defined subset; executable TS/JS config or
remote includes adds execution, reproducibility and support complexity without
needed first-release value. Recommend YAML+JSON; defer executable config, includes,
profiles/extends, and a general environment-interpolation engine.

## Current state — repository observations

| Area | Current control | Proposed treatment |
| --- | --- | --- |
| Model, provider order/allowlist and price ceilings | ReviewRunConfigV2 JSON | Preserve and document |
| Evidence/conversation bytes, output/total tokens, total cost, call timeout | ReviewRunConfigV2 JSON | Preserve with explicit units and bounds |
| Minimum request-start interval | ProviderCallPacerV1 constructor, default 0; no config field | Expose pacing setting; default remains 0 |
| 429/529 fallback delay | Fixed 5–10 second jitter range | Bounded min/max tuning |
| Other transient fallback delay | Fixed 1–2 second jitter range | Bounded min/max tuning |
| Maximum automatic wait for Retry-After | Fixed 30 seconds | Tunable wait ceiling; longer hints stop/wait, never retry early |
| Provider retries and final-output repairs | One each per run | Initially expose 0 or 1; larger counts require budget/state-machine work |
| Response prose/array limits | Fixed named limits in response-schema.ts | Selected advanced bounds with consistency checks, not a validation off switch |
| Standards selection/enforcement/applicability | Explicit separate profile JSON | Reference profile from user config; preserve frozen rule identity |
| Base, exclusions, output, quiet | CLI options | Unify useful defaults through resolver |
| Saved settings | Git-local JSON stores config/profile/author paths | Keep as local selection state, not another conflicting policy layer |

Source areas: src/contracts/review-run-config.ts, src/cli/standards-input.ts,
src/provider/call-pacing.ts, src/orchestrator/two-stage-review.ts,
src/orchestrator/response-schema.ts. Existing pacing is process-local and keyed
by model; it is not a distributed rate limiter or an in-flight concurrency cap.

## Research basis — documented facts

- [OpenRouter error handling](https://openrouter.ai/docs/api_reference/errors-and-debugging)
  documents Retry-After and provider overload/unavailability. Retain server hints;
  a configured wait ceiling must not shorten the server-requested delay.
- [AWS SDK retry behavior](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html)
  separates retry policies, attempt limits and backoff. Inference for this product:
  expose bounded retry controls, keep one retry-owning layer, and include every
  possible additional call in budget admission rather than multiplying hidden retries.
- [`yaml` parser documentation](https://eemeli.org/yaml/)
  supports YAML 1.2, duplicate-key checks, line positions, document errors and
  alias limits. Candidate implementation: one mapping document, string keys,
  duplicate rejection, no custom tags/merge keys/aliases, bounded file size/depth,
  and fatal parser warnings for unsupported constructs. Convert to plain data,
  then validate with existing Zod patterns. Parser flexibility is not permission
  to accept ambiguous configuration. Pin exact dependency after implementation
  review; no package installed by this research.

These sources support mechanisms, not a universal best delay or token limit.
Defaults should preserve observed behavior unless a separate measured change
justifies updating them.

## Configuration boundary

Expose tuning: model/route/price policy, budgets, timeout, pacing, bounded retry
and repair limits, chosen response-size limits, selected standards, exclusions,
and output preferences. Keep required correctness guarantees unconditional:
strict schemas, frozen evidence identities, source/rule reference validation,
complete concern coverage, blind assessment before author disclosure, explicit
uncertainty, secret exclusion, and conservative cost accounting. No
`validation: false`, unknown-submission replay switch, or implicit provider widening.

Some limits are derived rather than independent knobs: final concern capacity
must cover allowed preliminary gaps plus limitations; schemas used after call
one must fit their reservations. Increasing retries/repairs/output limits must
reserve all newly possible calls before transmission. Turning off repair means
an invalid report fails visibly; it must not be accepted unvalidated.

## Proposed user experience

Illustrative partial YAML, not a shipped schema or complete runnable example:

```yaml
schemaVersion: 3
model: openai/gpt-oss-120b
pacing:
  minimumIntervalMs: 0
retry:
  maxRetriesPerRun: 1
  overloadDelayMs: { min: 5000, max: 10000 }
  transientDelayMs: { min: 1000, max: 2000 }
  maxAutomaticWaitMs: 30000
repair:
  maxFinalRepairsPerRun: 1
budgets:
  maxOutputTokensPerCall: 8192
  maxTotalTokens: 160000
  maxTotalCostUsd: 0.02
  timeoutMs: 180000
```

Precedence: explicit supported CLI flags > explicitly selected file > documented
built-in defaults. Local init settings select the file and input paths; do not
silently deep-merge several policy files. File-relative paths resolve relative
to that file; CLI paths resolve relative to invocation directory. Arrays replace
whole values. Credentials stay in the existing environment mechanism, outside
config and printed artifacts. Existing JSON v2 resolves to today's defaults.

Add `config validate` and `config show --resolved --json` (names provisional).
Show defaults, overrides and provenance; errors identify field paths and YAML
line/column without dumping secrets. Existing review dry-run should share this
resolver and show admission under the effective values. Persist canonical resolved
operational config and digest for audit/resume; YAML comments and key order must
not change its semantic identity. Resume must reject changed effective policy.

## Implementation slices / acceptance

1. **Contract and inventory:** enumerate tunables versus fixed/derived invariants;
   define user config and resolved config schemas/defaults; explicit v2 adapter;
   generated schemas and documented bounds. Decide supported advanced response
   fields before expanding public API.
2. **Loader and CLI:** YAML+JSON resolver, validation/effective-config output,
   init integration and source-aware errors. Equivalent JSON/YAML inputs resolve
   identically; unknown keys, duplicates and unsupported YAML fail before calls.
3. **Wire tuning:** pass resolved policy to pacing, orchestrator and schema
   construction. Default behavior preserved; budgets handle disabled/enabled
   retry and repair; invalid combinations fail before credentials/provider use.
4. **Verification/docs:** deterministic-clock tests for pacing, jitter and
   Retry-After; zero-delay behavior; ceilings; parser/precedence/path cases;
   config digest/resume mismatch; derived response capacity. One bounded live
   confirmation only if separately authorized when implementing. Publish a
   commented complete example and migration instructions. Run normal gates.

MVP pacing guarantee is explicitly in-process. Cross-process/shared-account
coordination, explicit max-in-flight concurrency, per-stage output tuning and
larger retry counts remain follow-ups unless actual usage demands them.

Confidence: high on current control inventory and one-resolver direction;
moderate on exact field grouping. Open decisions: initial advanced-limit surface,
whether concurrency deserves phase-one scope, and whether opt-in repository
config discovery adds enough value. Maintainer approval of the implementation
contract is the next gate; this issue does not implement it.
