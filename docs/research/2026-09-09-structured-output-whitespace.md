# Runaway whitespace in structured model output

## Findings

Repeated formatting whitespace is a documented failure mode of constrained
language-model generation. The best-supported explanation for the observed
GPT-OSS 120B response is an interaction between token selection and permissive
JSON formatting constraints. This explains how output can remain an acceptable
prefix of a document while making almost no progress toward completing it.
It does not identify the exact software defect on CoreWeave's endpoint.

No reviewed evidence supports intentional billing inflation by the model or
provider. Similar behavior is reported in locally hosted open-source inference
stacks, where no external provider charges per generated token. The operational
concern remains real: unsuccessful generation can consume paid tokens and time.
A failure explanation does not make that behavior acceptable for production.

Research distinguishes three levels of confidence:

| Conclusion | Evidence strength |
| --- | --- |
| Actual whitespace is present in the saved provider content, across several cases | Direct local evidence |
| JSON generation can loop through grammar-permitted whitespace until its token cap | Specification, decoder documentation, and multiple original reports |
| CoreWeave's exact GPT-OSS deployment has that particular decoder defect | Plausible, unconfirmed; deployment configuration and token-selection traces unavailable |
| The model deliberately tries to inflate bills | Unsupported |

## Incident evidence

The failed exception final contains 31,081 characters, including 30,127 whitespace
characters, and reports `finish_reason: length`. Its completion allowance was
8,192 tokens. Provider usage records 655 reasoning tokens and a final-call cost
of $0.00146773. Character percentages are not token percentages: the tokenizer
can encode runs of whitespace differently from words. Therefore 97% whitespace
by characters does not establish that precisely 97% of cost was whitespace.

Formatting bursts occur outside strings, between otherwise recognizable JSON
fragments. One completed burst spans 8,965 characters. The generation duplicates
an author claim, continues into coverage fields, and ends before completing the
object. This is neither an empty HTTP response nor whitespace inserted by the
report renderer. Removing whitespace after receipt cannot recover missing fields
or reverse the tokens already generated.

Retrospective inspection found other CoreWeave finals with approximately 71%,
80%, 82%, and 92% whitespace, spanning advisory, conflict, and clean-code cases.
Some terminated normally. This is a selected sample, not a failure-rate estimate,
and there is no matched successful DeepInfra comparison yet. The problem is
broader than the exception rule and does not demonstrate a universally broken
model. Local evidence and reproduction limitations are recorded in
[the isolation report](../validation/2026-09-09-whitespace-isolation.md).

## Why valid JSON constraints can permit this

JSON explicitly permits repeated spaces, tabs, line feeds, and carriage returns
around structural characters. Its whitespace grammar allows zero or more such
characters, without a numerical limit. A schema describing object properties
and string lengths does not change this formatting rule.[^1]

A constrained decoder filters candidate next tokens according to a grammar.
LLGuidance's technical description explains this as computing allowed-token
masks from grammars.[^2] Such a mask can reject a syntactically illegal token
without preferring a useful token. At a position before a comma, both formatting
whitespace and the comma may be allowed. Selecting whitespace can leave the
parser waiting for the same comma again. If generation continues choosing
whitespace, each step is locally permitted even though the document remains
unfinished. This mechanism is an interpretation combining grammar behavior
with reported failures, not a reconstruction of CoreWeave's hidden token scores.

The distinction is between enforcing structure and ensuring completion. A prefix
can still be extendable into a valid document after thousands of blank characters.
If the token allowance runs out first, the returned prefix is incomplete. A
strong schema and local validation protect the consumer from accepting that
prefix; they cannot retroactively make the generation finish.

The loop need not be mathematically permanent. Occasional punctuation or content
can interrupt it, as in the saved response. That explains why related calls can
finish after substantial waste while another reaches the token cap.

## Reports and applicability

| Primary source | Report or implementation | Relevance and limitation |
| --- | --- | --- |
| Outlines issue 691, February 20, 2024 | Llama-2 JSON generation returns an opening brace followed by repeated newlines | Demonstrates this failure class predates GPT-OSS and occurs in local inference; old version, not our deployment |
| XGrammar issue 345, June 25, 2025 | Report of repeated newlines; asks for bounded whitespace matching | Independent report in another decoder project; does not isolate our endpoint |
| vLLM issue 38696, April 1, 2026 | Qwen3.5 strict JSON Schema intermittently outputs blanks until the length limit | Close match to the symptom with a small schema; different model |
| vLLM issue 54497, August 31, 2026 | Requests exposing XGrammar whitespace bounds; explains a whitespace self-loop can consume max_tokens | Recent integration evidence; request is open, not a shipped universal fix |
| vLLM issue 23120, August 18, 2025 | GPT-OSS channel variants fail to activate constraints correctly | Model-specific integration risk, but a different demonstrated symptom; closed as not planned/stale, not proof of a current deployed fix |

Sources: original issue bodies.[^3][^4][^5][^6][^7] Public reports establish that
these failures occur; they do not establish frequency across all installations.

A further XGrammar report provides a minimal grammar reproduction for empty
XML tool arguments. Its generated argument grammar accepts only repeated
whitespace, allowing generation to stall before a closing tag. This is unusually
concrete evidence that grammar design can create non-progressing paths, but its
XML/no-argument-tool trigger does not match this application's JSON report.
It must not be presented as the root cause here.[^8]

## GPT-OSS schema and prompt integration

OpenAI's Harmony documentation distinguishes presenting the output schema in the
model's developer message from enforcing it during sampling. It describes a
response-format section and states that prompting alone does not guarantee
schema adherence; grammar enforcement is still needed.[^9]

Conversely, enforcement alone need not mean the model has read the schema.
vLLM's Gemma 4 recipe explicitly warns that schema descriptions are not visible
to the model in that setup and recommends placing output instructions in the
prompt.[^10] This source is model/setup-specific. It is a reason to inspect
schema delivery, not proof that CoreWeave omits schemas for GPT-OSS.

The application's request supplies strict `response_format: json_schema` and
`require_parameters: true`, consistent with OpenRouter's documented contract.
It does not explicitly duplicate the entire final schema into a message.
OpenRouter advertises structured-output support but that capability flag alone
does not establish the endpoint's internal prompt template, decoder version,
or formatting policy.[^11]

A useful hypothesis is that insufficient schema visibility, template conversion,
or an enforcement transition increases the chance of an unproductive sequence.
Adding the exact schema to a diagnostic prompt could test visibility sensitivity.
It should be a separate comparison with admission recalculated, not an assumed
production fix and not mixed with changing models or sampling settings.

## Controls with evidence behind them

XGrammar's documented `from_json_schema` API exposes `max_whitespace_cnt`, which
bounds whitespace between elements; its default is unlimited. It also supports
fixed formatting via `any_whitespace: false`. The same documentation cautions
that enforcing formatting different from a model's preferences can degrade
quality. Thus bounded formatting offers a directly relevant experiment, but
still requires checking the resulting review content.[^12]

vLLM separately documents a server configuration called
`disable_any_whitespace`, supported for xgrammar and guidance backends, to
require compact JSON formatting.[^13] This is a serving-engine setting, not a
standard JSON Schema keyword. Adding it to an OpenRouter request without
confirmed support would not establish enforcement. The recent vLLM feature
request also shows that controls available inside a library may not be exposed
through every serving path.[^6]

For the hosted application, the first question is whether the selected endpoint
can enable or expose a supported formatting bound. If not, a provider with
verified behavior may be the practical mitigation. Moving to self-hosting solely
to obtain this setting would be a separate product and operational decision.

Streaming offers a consumer-side safeguard: track long runs of JSON formatting
whitespace and stop an unproductive response. A detector must respect quoted
strings and escapes, carry state across chunks, preserve partial artifacts, and
classify the result as incomplete. It limits exposure; it does not repair a
review. Thresholds should be calibrated against saved valid outputs rather than
chosen from a global whitespace percentage, which can flag ordinary indentation.

Crucially, aborting a stream does not universally stop billing. OpenRouter says
cancellation support is endpoint-specific; unsupported endpoints may continue
upstream generation after disconnection. Verify the selected endpoint's support
before treating streaming abort as a cost-saving guarantee.[^14]

## Cost interpretation

OpenRouter usage accounting reports native-token counts, reasoning counts, and
cost. Billing records measure consumed generation, not the amount of useful
information delivered.[^15] The failed call's saved usage provides direct evidence
of a charged unsuccessful completion. It provides no evidence of a plan to
increase spending.

The practical failure is wasteful generation under permissive formatting rules,
with missing or ineffective progress protection. There is no need to invoke
billing intent to explain the observed output. Provider-side logs would still be
needed to establish why this particular request selected those tokens.

## Recommended investigation sequence

1. Preserve the exact reconstructed final request as baseline. Do not regenerate
   preliminary work or overwrite original evidence. Keep the token limit fixed.
2. Obtain one usable pinned-endpoint baseline and a matched alternative-provider
   result. Record failures and unknown usage; one success is not a reliability
   claim. Routing differences test the deployment as a whole, not just quantization.
3. Verify the provider's schema visibility, Harmony handling, decoder/version,
   and supported formatting controls. The existing request ID and synthetic
   reproduction are sufficient starting material for a support inquiry; any
   actual message to support requires separate authorization.
4. Where supported, compare one formatting-control change. Otherwise test schema
   visibility or a smaller schema in separate diagnostic variants. Removing
   schema constraints can help isolate an interaction, but is not permission
   to weaken production report validation.
5. Add progress-abort protection as a distinct hardening change once cancellation
   semantics and cost accounting are specified. Retain all local correctness gates.

Do not raise the output budget, add delays between calls, or trim the partial
object into a passing report as a presumed solution. None addresses why the
current generation spends its budget on permitted formatting. Repetition
penalties, temperature changes, and compact-output prompting are diagnostic
variables, not guaranteed remedies. No new paid inference calls or runtime
changes were made for this research.

## Sources

Sources checked September 9, 2026. Versioned documentation and original issue
bodies take precedence over search snippets. No claim depends on an inaccessible
comment, unmerged fix, or an inferred CoreWeave implementation.

[^1]: T. Bray / IETF, [RFC 8259, section 2](https://www.rfc-editor.org/rfc/rfc8259#section-2), December 2017. JSON whitespace grammar.
[^2]: Guidance AI, [LLGuidance: Making Structured Outputs Go Brrr](https://guidance-ai.github.io/llguidance/llg-go-brrr). Allowed-token masking mechanism.
[^3]: vegaluisjose / Outlines, [JSON generation fails for Llama-2-7b-chat-hf, #691](https://github.com/dottxt-ai/outlines/issues/691), February 20, 2024. Original newline-loop reproduction, Outlines 0.0.32.
[^4]: anaivebird / XGrammar, [How to allow whitespace_patter to bounded whitespace, #345](https://github.com/mlc-ai/xgrammar/issues/345), June 25, 2025. Original repeated-newline report.
[^5]: Yyong25 / vLLM, [Qwen3.5 JSON Schema outputs garbled spaces, #38696](https://github.com/vllm-project/vllm/issues/38696), April 1, 2026. Strict JSON symptom reproduction.
[^6]: wangxuw / vLLM, [Upgrade XGrammar and expose max_whitespace_cnt, #54497](https://github.com/vllm-project/vllm/issues/54497), August 31, 2026. Open feature request and integration limits.
[^7]: jmracek / vLLM, [Structured output is not correctly enforced when using GPT-OSS, #23120](https://github.com/vllm-project/vllm/issues/23120), August 18, 2025. Historical channel/enforcement issue, v0.10.2 development build.
[^8]: wangxuw / XGrammar, [XML tool calling loops forever on no-argument tools, #802](https://github.com/mlc-ai/xgrammar/issues/802), August 4, 2026. Minimal grammar reproduction; different protocol.
[^9]: OpenAI, [Harmony response format: structured output](https://github.com/openai/harmony/blob/main/docs/format.md#structured-output). GPT-OSS schema presentation and sampling enforcement.
[^10]: vLLM project, [Gemma 4 usage guide](https://github.com/vllm-project/recipes/blob/main/Google/Gemma4.md). Schema-description visibility caveat; not evidence of CoreWeave's GPT-OSS implementation.
[^11]: OpenRouter, [Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs). Hosted API contract and routing capability requirement.
[^12]: XGrammar 0.2.5, [Grammar API](https://xgrammar.mlc.ai/docs/latest/api/python/grammar.html). Formatting controls, defaults, and quality caveat.
[^13]: vLLM, [Structured-output configuration](https://docs.vllm.ai/en/stable/api/vllm/config/structured_outputs/#vllm.config.structured_outputs.StructuredOutputsConfig.disable_any_whitespace). Server-side compact formatting.
[^14]: OpenRouter, [Stream cancellation and billing](https://openrouter.zendesk.com/hc/en-us/articles/51691588409883-How-do-I-cancel-a-streaming-request-and-which-providers-stop-billing-when-I-do), June 14, 2026. Endpoint-specific cancellation behavior.
[^15]: OpenRouter, [Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting). Native token usage and cost reporting.
