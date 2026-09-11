# Agent tool-loop and repository-tool evaluation

Status: complete for framework triage and synthetic feasibility. Broader syntax
corpus, multi-platform native binding, sandbox, and live-provider gates remain.
Decision owner: project maintainer.

## Executive conclusion

Do not adopt an agent framework for the next reviewer-tool slice. Implement the
small, application-owned Chat Completions loop already specified by the review
protocol, behind existing provider and orchestrator boundaries. This is not a
generic agent loop: every model call needs pre-call token/cost admission, an
append-only attempt record, frozen-snapshot evidence accounting, and durable
stage visibility enforcement.

`@openrouter/agent@0.11.0` is the only tested framework candidate that compiles
under the repository's strict TypeScript profile. It is still a poor direct fit:
it is beta, uses the OpenResponses API, streamed both mocked requests, owns tool
execution and follow-up calls, and exposes cost stopping only after reported
cost is incurred. Keep it as a future spike candidate if its loop can be placed
behind product-owned per-call admission and persistence.

The exact tested Vercel combinations do not pass the repository type gate:
`ai@7.0.97` plus `@openrouter/ai-sdk-provider@3.0.0` emitted 20 dependency
diagnostics; `ai@6.0.280` plus provider `2.10.0` emitted 10. Do not weaken
`exactOptionalPropertyTypes` or enable `skipLibCheck` to admit either.

Tool conclusions support the pasted proposal with narrower timing:

- keep bounded text reads and search as first tools;
- continue the planned `@ast-grep/napi` corpus spike, but treat results as
  syntactic candidates rather than symbol identity;
- defer `ts-morph` until semantic reference resolution proves necessary and a
  packet-only virtual filesystem is designed;
- keep Node's current process runner instead of adding `execa`; both can provide
  no-shell arguments, timeouts, cancellation, and output limits, while current
  code also enforces the product-specific environment allowlist;
- defer MCP until another real client needs the repository tools, Dagger until
  the isolated verification-worker design, and Mastra/LangGraph until workflow
  complexity exceeds the existing explicit state machine.

## Decision question and scope

Question: should the first interactive evidence-tool slice adopt
`@openrouter/agent`, Vercel AI SDK, or another framework, and which proposed
repository-tool libraries deserve a next experiment?

Answer matters because the fixed-payload reviewer now exists, while interactive
evidence and named verification are deliberately deferred. Framework choice
must preserve the frozen-snapshot, blind-first, budget, retry, raw-evidence, and
attempt-ledger contracts rather than merely automate tool dispatch.

Authorized work: current primary-source research, exact-version packages in
isolated temporary directories, mock-only model traffic, synthetic source
analysis, and this retained report. Prohibited: product dependency changes,
paid/provider calls, arbitrary reviewed-repository execution, product
implementation, and architecture approval.

Stop condition: distinguish framework viability and reproduce the central
tooling claims without changing runtime dependencies.

## Criteria

1. Preserve local authoritative stage and conversation state.
2. Persist the preliminary assessment before author disclosure.
3. Admit every provider call conservatively before submission.
4. Disable hidden retries and retain exact, bounded raw response evidence.
5. Bind every transmitted request and tool result to deterministic audit data.
6. Read only frozen packet bytes; expose no generic filesystem, network, shell,
   write, Git mutation, or publication tool.
7. Pass Node 24, TypeScript 6, Zod 4, strict declarations, and existing checks.
8. Add measured review signal or remove enough product-owned code to justify a
   dependency and migration.

## Primary source index

- OpenRouter: [Agent SDK overview](https://openrouter.ai/docs/agent-sdk/overview),
  [tools](https://openrouter.ai/docs/agent-sdk/call-model/tools),
  [stop conditions](https://openrouter.ai/docs/agent-sdk/call-model/stop-conditions),
  [API reference](https://openrouter.ai/docs/agent-sdk/call-model/api-reference),
  [official beta package README](https://github.com/OpenRouterTeam/typescript-agent/blob/main/packages/agent/README.md),
  and [Responses endpoint](https://openrouter.ai/docs/api/api-reference/responses/create-responses)
- Vercel AI SDK: [tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling),
  [agents](https://ai-sdk.dev/docs/agents), and
  [loop control](https://ai-sdk.dev/docs/agents/loop-control)
- Repository tools: [ast-grep JavaScript API](https://ast-grep.github.io/guide/api-usage/js-api),
  [ts-morph navigation](https://ts-morph.com/navigation/example),
  [Execa API](https://github.com/sindresorhus/execa/blob/main/docs/api.md), and
  [Node child processes](https://nodejs.org/api/child_process.html)
- Later boundaries: [MCP architecture](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture),
  [Dagger TypeScript SDK](https://docs.dagger.io/sdk/typescript/),
  [Mastra tools](https://mastra.ai/docs/agents/mcp-guide), and
  [LangGraph overview](https://docs.langchain.com/oss/javascript/langgraph/overview)

## Documented facts

- **Fact:** OpenRouter Agent SDK automates user-defined tool execution and
  repeated model calls. Its official package README marks it beta and recommends
  exact version pinning because releases may break compatibility.
- **Fact:** `callModel` uses OpenResponses, not the current product's
  non-streaming Chat Completions protocol.
- **Fact:** `maxCost` sums cost reported by completed steps and stops when the
  sum reaches the threshold. It is therefore a post-call stop condition, not
  pre-call cost admission or a guaranteed billing cap.
- **Fact:** OpenRouter Agent SDK has typed Zod input/output schemas, tool
  deadlines, concurrency controls, abort support, approval/state support, and
  lifecycle hooks. Its public built-in hooks include `PostModelCall`, not a
  blocking pre-model-call admission hook.
- **Fact:** Vercel AI SDK supports typed tools and tool loops with `stopWhen`,
  per-step preparation, callbacks, and explicit retry configuration.
- **Fact:** MCP specifies context exchange and tool/resource/prompt primitives;
  it does not dictate model orchestration. It is a protocol boundary, not a
  reason to add a boundary inside one process.
- **Fact:** ast-grep provides syntax-tree pattern matching. ts-morph wraps the
  TypeScript compiler and exposes semantic reference navigation. Execa defaults
  to no shell and supports timeouts, cancellation, and output ceilings.

## Experiments

### Environment and provenance

- repository commit: `d6ba399fcac22a31f0e78c1a1efca8a0642dee41`
- working branch: `codex/review-quality-pivot`, with pre-existing uncommitted
  product work left untouched
- host: `Darwin 25.6.0 arm64`
- runtime: `Node v24.19.0` through `fnm`, `npm 11.17.0`
- compiler/types: `typescript@6.0.3`, `@types/node@24.13.3`
- isolated paths:
  `/tmp/independent-reviewer-agent-spike.deD8Az` and
  `/tmp/independent-reviewer-ai6-spike.aR5Gwv`
- no provider credential or network model call was used

Registry inspection selected these current exact versions on 2026-09-10:
`@openrouter/agent@0.11.0`, `ai@7.0.97`,
`@openrouter/ai-sdk-provider@3.0.0`, `ai@6.0.280`,
`@openrouter/ai-sdk-provider@2.10.0`, `@ast-grep/napi@0.45.3`,
`ts-morph@28.0.0`, and `execa@10.0.1`.

Representative setup and gate commands:

```sh
npm install --prefix /tmp/independent-reviewer-agent-spike.deD8Az \
  --ignore-scripts --save-exact \
  @openrouter/agent@0.11.0 ai@7.0.97 \
  @openrouter/ai-sdk-provider@3.0.0 zod@4.5.4 \
  typescript@6.0.3 @types/node@24.13.3 \
  @ast-grep/napi@0.45.3 ts-morph@28.0.0 execa@10.0.1

fnm exec --using=24.19.0 -- node node_modules/typescript/bin/tsc \
  --ignoreConfig --noEmit --strict --exactOptionalPropertyTypes \
  --noUncheckedIndexedAccess --module NodeNext --moduleResolution NodeNext \
  --target ES2024 --types node src/openrouter-agent.ts
```

The same compiler command targeted each candidate fixture. Runtime scripts used
the same `fnm exec --using=24.19.0 -- node` prefix. Temporary fixtures declared
one Zod-validated `read_file` tool; model traffic used an injected local mock
fetcher returning OpenResponses JSON.

### Framework type compatibility

- **Observation:** `@openrouter/agent@0.11.0` compiled with the repository's
  strict settings and a typed `read_file` input/output, tool timeout,
  concurrency limit, `stepCountIs`, and `maxCost`.
- **Observation:** AI SDK 7/provider 3 failed with 20 diagnostics in shipped
  dependency declarations. Failures included `TS2344` generic constraints under
  `exactOptionalPropertyTypes` and `TS7016` for the dependency's untyped
  `json-schema` import.
- **Observation:** AI SDK 6/provider 2 failed with 10 diagnostics from the same
  broad classes. Testing the prior major does not supply a clean fallback.
- **Inference:** Vercel AI SDK is unavailable under current quality gates. A
  future exact release may change this; re-run rather than assume permanence.

### OpenRouter loop and cost semantics

Mock response one returned a `read_file` call and reported `$0.02`; response two
returned final text and reported `$0.03`. The configured stop list was
`[stepCountIs(8), maxCost(0.01)]`.

- **Observation:** SDK made two requests to `/api/v1/responses`, executed the
  tool once, and reported two calls, 30 tokens, and `$0.05` total cost.
- **Observation:** both captured request bodies set `stream: true`; the caller
  consumed only `await result.getText()` and did not request streaming.
- **Observation:** second body contained accumulated function call and function
  result items. SDK, not product orchestrator, assembled that next request.
- **Inference:** `maxCost` is useful as a runaway-loop signal but cannot replace
  existing reservation arithmetic. A `$0.01` threshold permitted `$0.05` in
  this controlled case because the condition can only inspect completed usage.
- **Inference:** adopting this loop would also adopt a new endpoint, wire shape,
  streaming decoder, response-evidence format, and conversation serializer. It
  is not a localized replacement for boilerplate dispatch.

### Syntax, semantic, and process tools

Synthetic TypeScript contained `Repository.query`, one call through a
`Repository`, and an unrelated `logger.query` with the same syntax.

- **Observation:** ast-grep pattern `$OBJ.query($$$ARGS)` returned both calls
  with zero-based source coordinates. Structural matching did not distinguish
  symbol identity.
- **Observation:** ts-morph `findReferencesAsNodes()` returned only the call
  bound to `Repository.query`, with a one-based line number.
- **Inference:** ast-grep is a good bounded declaration/hunk-enrichment tool,
  while claims like “find references” need compiler semantics or an explicitly
  syntactic name. This small fixture does not satisfy the planned corpus and
  platform gate in the Git/context library evaluation.
- **Observation:** Execa passed the literal argument `$(not-a-shell)` unchanged,
  classified a 10 ms timeout with `timedOut: true`, and classified output above
  1,024 bytes with `isMaxBuffer: true`.
- **Inference:** Execa is capable but does not remove product-specific work:
  named check lookup, environment allowlisting, disposable reconstruction,
  isolation policy, output redaction, and attempt evidence remain local. Current
  `spawn` runner already supplies required primitives with fewer dependencies.

## Consistent option comparison

| Option | Type gate | Protocol fit | Control/audit fit | Decision |
| --- | --- | --- | --- | --- |
| Application-owned narrow loop | Existing | Exact current Chat Completions contract | Product owns every transition, request, retry, and reservation | **Adopt for first tool slice** |
| `@openrouter/agent@0.11.0` | Pass | OpenResponses plus observed streaming; beta | Useful controls, but loop and next-request assembly are framework-owned | Defer; bounded compatibility spike only |
| AI SDK 7 + OpenRouter provider 3 | Fail | Chat Completions provider available | Rich callbacks, but migration remains broad | Reject exact tested versions |
| AI SDK 6 + OpenRouter provider 2 | Fail | Chat Completions provider available | Same ownership mismatch | Reject exact tested versions |
| Mastra | Not tested | Adds agent/workflow abstraction | Duplicates current explicit state machine | Defer |
| LangGraph | Not tested | General durable graph runtime | Potential later fit only if current ledger/state machine becomes inadequate | Defer |

## Recommended first tool surface

Keep operation names aligned with protocol, not generic coding-agent names:

```text
read_snapshot_file(path, startLine?, endLine?)
read_diff(paths? or hunkIds?)
search_snapshot(pattern, pathFilter?, continuation?)
read_canonical_input(artifactId, section?)
request_verification(checkId)
```

Do not expose `run_shell`, `run_command`, arbitrary test paths/packages, live
filesystem reads, writes, network fetch, dependency installation, or Git
mutation. Config maps a reviewer-selected `checkId` to an application-owned
argument array and executes it only inside the approved disposable environment.

Start with literal or tightly restricted text search plus bounded line reads.
Add syntax context only after the broader ast-grep gate. Do not expose
`find_symbol` or `get_references` until their exact semantics, supported
languages, ambiguity behavior, snapshot source, and resource limits are
contracted.

## Confidence, limitations, and unknowns

Confidence: high that no tested framework should replace current provider and
orchestrator boundaries now; high that `maxCost` is not a hard cap; medium that
ast-grep will earn its dependency after a real corpus evaluation.

Unknowns:

- real-model tool-call reliability through OpenRouter across promoted models;
- Responses versus Chat Completions routing, structured-output, raw-evidence,
  error, and privacy parity for this exact protocol;
- behavior on Linux x64/arm64 and malformed/partially valid source;
- review-quality delta from interactive evidence versus larger deterministic
  initial context;
- isolated verification-worker runtime, network, filesystem, and secret policy;
- whether a future framework exposes a blocking pre-model-call boundary with
  exact outbound bytes and durable resume compatible with this ledger.

No live call was made, no full package security audit was performed, and one
synthetic file cannot establish review-quality improvement.

## Recommendation and next gates

Owner: project maintainer.

1. Approve or reject application-owned tool-loop direction before contract work.
2. If approved, define versioned tool request/result, per-call admission, loop
   ledger, continuation, and terminal-state contracts before implementation.
3. Build a mock-only vertical slice with `read_snapshot_file`, `read_diff`, and
   literal `search_snapshot`; prove author content remains locked until a valid
   preliminary assessment is durably persisted.
4. Add one named verification fixture only after disposable reconstruction and
   credential-free execution are proven.
5. Run the broader ast-grep corpus/platform experiment already specified by the
   Git/context library evaluation. Defer ts-morph until that evidence shows a
   material semantic gap.
6. Compare fixed-payload and tool-enabled reviews on known-defect and clean
   changes. Measure recall, false positives, calls, bytes, latency, cost, tool
   failures, and unresolved coverage.
7. Use one explicitly authorized live smoke only after offline request/ledger,
   budget, malformed-tool, retry, timeout, and resume gates pass.

Evidence that would change the framework recommendation: an exact release that
passes strict type checks and exposes a blocking, auditable pre-call hook over
exact bytes; lets product code own retry and raw response capture; supports the
selected non-streaming protocol; and demonstrably deletes more local complexity
than its adapter introduces.
