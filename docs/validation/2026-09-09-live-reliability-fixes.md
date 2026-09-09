# Live review reliability fixes — 2026-09-09

Follow-up to [project health check](2026-09-09-project-health.md), on `codex/project-health-e2e-check` from `6998efb`. Changes remain local and uncommitted.

## Implemented fixes

- **Source text assembly:** `final-review-candidate-v1` requests author claim indices and kind-scoped preliminary concern indices with model judgments. The runner inserts exact source text and validates the unchanged final report. Missing, duplicate, out-of-range references and model-supplied copied fields fail. Prompt version is `review-policy-v3`; older runs cannot resume across this protocol change. Repair schemas constrain reference IDs/counts within existing repair admission.
- **Rejected response accounting:** exported `ProviderResponseMetadataV1` carries sanitized response ID, model, provider, finish reason, and normalized usage. Rejected parseable completion envelopes attach it to `ProviderCallError`; `CALL_FAILED.responseMetadata` and CLI failure output retain it. Missing/fractional/negative usage remains unknown. Rejected raw response artifacts remain private and separate. Sum accepted-call usage and rejected-call metadata once per attempt; terminal failure events do not duplicate the usage.
- **Provider isolation:** config-v2 routing accepts one to three distinct endpoint slugs. A singleton list disables fallback and sets both `order` and `only` to that endpoint; longer lists retain bounded same-model fallback. Policy audit version advances to `openrouter-chat-completions-v3`. Existing two/three-endpoint configurations remain valid. This is an additive pre-release config acceptance change; regenerated committed schema reflects it.
- **Documentation:** corrected architecture's current-looking claim about on-demand evidence reads and README's statement that provider fallback is deferred. Documented source-text assembly, failed-call metadata, and pinned routing.
- **Fixture signing:** retained the preceding one-line temporary Git fixture fix; user/global signing settings remain untouched.

Provider pinning follows OpenRouter's documented [`order`, `only`, and `allow_fallbacks` controls](https://openrouter.ai/docs/guides/routing/provider-selection). Changing preference order alone does not guarantee a provider: the previous DeepInfra-first run actually used CoreWeave. No model fallback, silent schema repair, automatic replay of failed/uncertain submissions, or relaxed privacy controls were added.

## Verification

Before the candidate-assembly change, `npm run check` passed **185 tests** with formatting, lint, type checking, build, and schema drift checks. Four existing lint warnings and two informational diagnostics remain. Both repository-context checks passed. Red/green regressions cover original author text versus U+2011 substitution, no author disclosure in the preliminary schema, rejected null/length responses retaining cost and route, redacted metadata and unknown invalid usage, durable failed-call metadata without a success event/retry, CLI failure metadata, and pinned single-endpoint routing.

Live tests use the same synthetic owner-access defect, clean refactor, and no-logging steering fixtures as the initial check. Each run remains bounded to 80,000 total tokens, 4,096 output tokens per call, a 120-second per-call timeout, and $0.02 local admission ceiling. Seven runs were authorized within this follow-up, for a combined configured envelope of $0.14. Reported cost is not settled billing. No repo source, implementation conversation, or credentials were supplied as model evidence.

Private inputs, configs, frozen evidence, raw responses, validated reports, and reproduction helper are in `.review-runs/health-fixes-2026-09-09/`. Original failed artifacts were preserved.

## Operational decision

Neither model is established as consistently reliable by these small samples. [Example configuration](../../examples/review-config.gpt-oss-120b.json) preserves the tested CoreWeave/DeepInfra allowlist and cost controls; requests must reference its `configId`. This is a smoke-test starting point, not a production quality guarantee or an automatic product default.

The 20B results do not support treating a provider switch as a complete fix. DeepInfra's clean case succeeds, but defect and steering cases still fail strict reconciliation after the one repair: invented/missing preliminary finding IDs and missing concern dispositions. CoreWeave's clean control still reaches the output cap. These failures stay visible. Avoid spending on broad 20B comparisons until reference-ledger generation improves; keep exact validation intact.

The precise upstream cause of the original null CoreWeave completions remains unproven. The new pinned controls and recorded metadata make that behavior diagnosable; they cannot guarantee an external provider always emits a completion. No inference is made that raising output limits fixes the prior null-with-stop responses.

Candidate assembly replaces the copied-text workaround. Live results above predate this change; no new model reliability claim follows from local tests alone.
