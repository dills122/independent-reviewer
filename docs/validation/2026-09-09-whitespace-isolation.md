# Final-stage whitespace investigation — 2026-09-09

Status: recurring generation symptom localized; internal provider/model cause
not established. No product prompt, schema, routing, or token budget changed.

## What the existing responses establish

The exception response contains formatting whitespace outside JSON strings in
multiple bursts, interleaved with continued field generation. The largest
completed burst contains 8,965 characters. It repeats an author claim and later
emits a meaningless changed-path explanation. Removing formatting whitespace
for inspection does not complete the JSON or yield a valid report.

The first large burst follows authorClaims.status = UNVERIFIED, which is a valid
value in the exact transmitted schema. The claim and explanation fields fit
its 400-character limits. No immediate impossible schema transition was found
at that point; this does not prove all schema/backend interactions are sound.

The problem is not unique to the exception fixture:

| Saved final response | Provider | Whitespace / characters | Finish reason |
| --- | --- | --- | --- |
| standards-advisory-check / advisory / attempt 2 | CoreWeave | 5,024 / 7,053 (71%) | stop |
| standards-conflict-fix / conflicting-rules / attempt 2 | CoreWeave | 8,021 / 10,089 (80%) | stop |
| standards-live / advisory / attempt 2 | CoreWeave | 9,995 / 12,144 (82%) | length |
| standards-provider-control / clean / attempt 2 | CoreWeave | 13,501 / 14,638 (92%) | stop |
| standards-remaining / exception / attempt 2 | CoreWeave | 30,127 / 31,081 (97%) | length |

These are retrospective selected high-whitespace responses, not an estimated
failure rate or a balanced comparison between providers. A normal finish reason
alone does not establish semantic review correctness. Previously completed
reviews do not prove efficient or stable generation. In particular, the earlier
advisory truncation also had excessive whitespace; raising output allowance
was not demonstrated to fix its cause.

## Exact-request reconstruction and live probes

Reconstructed the original final request offline by replaying the saved
preliminary response through the existing orchestrator against a copy of the
packet. No preliminary provider call was made. With original routing, both
wire-body and credential-free request hashes match the original ledger:

- Wire body: 17,977 bytes; SHA256
  `96e0fb034e42f5cb927506d47680be3683244e5ee12300f8940ca73c47080c48`.
- Credential-free request SHA256:
  `03f2257e068b79d67a925385d30f77a732035eb0f793e87548ddec968fb85287`.

Two one-call probes pinned the existing routes separately, changing routing
only. Model, messages, schema, 8,192-token allowance, price ceilings, ZDR policy,
and 180-second timeout remained fixed. Neither probe retried automatically.

1. CoreWeave returned provider error 429 in about 0.4 seconds. The diagnostic
   script retained the error code/message but did not capture usage/raw error;
   cost remains unknown. No generation comparison was obtained.
2. DeepInfra returned an error response, but the diagnostic script incorrectly
   passed its object-valued responseBody directly to writeFile. This lost error
   details before persistence. Provider outcome and cost remain unknown. Do not
   interpret this attempt as a reproduced whitespace failure or successful
   control. The script now serializes both string and object error envelopes;
   both forms were checked offline. No additional live replay followed.

Initial automatic approval rejection was cleared after inspecting the exact
payload and establishing it was the already-transmitted synthetic sum-function
fixture and local fixture-path metadata, not private application source.

Private reconstruction, audit hashes, probe scripts, and explicit unknown-attempt
record: `.review-runs/whitespace-isolation-2026-09-09/`.

## Mechanism and next discriminating check

JSON permits formatting whitespace outside strings, while prose maxLength
constraints apply inside string values. Thus schema compliance does not itself
bound formatting whitespace or guarantee progress toward completion.

vLLM documents an engine-side `disable_any_whitespace` option for xgrammar and
guidance backends. This confirms that formatting constraints can be enforced
at the decoder layer, separately from JSON field validation. It does **not**
establish CoreWeave's backend/version or that OpenRouter exposes that control.
Source: [vLLM structured-output configuration](https://docs.vllm.ai/en/stable/api/vllm/config/structured_outputs/#vllm.config.structured_outputs.StructuredOutputsConfig.disable_any_whitespace).

Next useful experiment remains the reconstructed final request with provider
availability restored, followed by one controlled backend/schema comparison.
Do not change prompts, schema, sampling and routing together, infer a universal
model defect from these samples, or claim a fix from one successful completion.
If provider-supported formatting control exists, test it explicitly; do not send
undocumented parameters and assume they are honored. Streaming early abort
would limit waste, but would not establish or repair the generation cause.
