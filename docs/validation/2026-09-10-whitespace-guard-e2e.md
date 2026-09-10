# OpenRouter whitespace guard E2E — 2026-09-10

Status: healthy live path passed; live guard trip and endpoint retry not observed.

## Scope

Ran the PR build against a disposable one-file TypeScript fixture that renamed an
exported pagination helper without changing its arithmetic. Direct review of the
PR was rejected during dry-run because its initial evidence exceeded the
configured 32,000-byte limit; no provider call occurred for that rejected scope.

The accepted fixture dry-run captured one changed path and excluded the author
overview. It reserved 95,133 tokens and `$0.006789` under the unchanged `$0.02`
hard review ceiling. Reservations are not confirmed charges.

## Live result

- Terminal state: `READY` (`Standards satisfied`).
- Attempts: one preliminary and one final; no repair or retry.
- Preliminary: CoreWeave, 26,409 ms, 2,424 prompt tokens, 1,089 completion
  tokens, `$0.00025785` reported cost.
- Final: requested `coreweave/fp4`, returned CoreWeave, 26,138 ms, 3,015 prompt
  tokens, 850 completion tokens, `$0.00023495` reported cost.
- Total provider-reported cost: `$0.0004928`; CLI rounded display `$0.000493`.

The final attempt used provider policy `openrouter-chat-completions-v4` and
retained an `OPENROUTER_SSE` diagnostic with 2,304 partial-content characters.
Its longest consecutive formatting-whitespace run outside strings was 9 and its
terminal run was 0, below the 512-character guard.

## Safety and limits

The OpenRouter credential was loaded from the authorized main-worktree `.env`
only into the live child process; it was not copied into this worktree. A local
exact-byte scan found zero credential matches across all 15 retained packet and
review files.

This run proves live SSE compatibility, endpoint pinning, structured response
normalization, usage capture, artifact persistence, and normal two-stage
completion. It does not prove live guard cancellation, different-endpoint retry,
billing cancellation, or population reliability. Those guard and retry paths
remain deterministically covered by offline tests.
