import type * as z from "zod";
import type { ReviewRunConfigV3Schema } from "../contracts/review-run-config.js";
import type { ReviewMessageV1, ReviewProviderResponseV1 } from "../provider/review-provider.js";
/** OpenRouter unit prices are expressed in dollars per million tokens. */
export const TOKENS_PER_UNIT_PRICE_V1 = 1_000_000;

export type ReviewRunConfigV3 = z.infer<typeof ReviewRunConfigV3Schema>;

/** Upper bound in dollars for a known token split at the configured unit-price ceiling. */
export function priceCeilingCostUsd(
  promptTokens: number,
  completionTokens: number,
  config: ReviewRunConfigV3,
): number {
  const { prompt, completion, request } = config.providerRouting.maxPrice;
  return (
    (promptTokens / TOKENS_PER_UNIT_PRICE_V1) * prompt +
    (completionTokens / TOKENS_PER_UNIT_PRICE_V1) * completion +
    request
  );
}

/** Price known prompt/output reservations separately, including each request fee. */
export function reservationCostUsd(
  reservedTokens: number,
  config: ReviewRunConfigV3,
  calls = 1,
): number {
  const completionTokens = calls * config.budgets.maxOutputTokensPerCall;
  return (
    priceCeilingCostUsd(reservedTokens - completionTokens, completionTokens, config) +
    (calls - 1) * config.providerRouting.maxPrice.request
  );
}

/**
 * What a completed call cost. Unknown cost is never treated as zero: it falls back to the
 * unit-price ceiling over reported tokens, and to the reservation where tokens are missing too.
 */
export function callCostUsd(
  response: ReviewProviderResponseV1,
  config: ReviewRunConfigV3,
  reservedInputTokens: number,
): number {
  if (response.usage.cost !== null) {
    return response.usage.cost;
  }
  return priceCeilingCostUsd(
    response.usage.promptTokens ?? reservedInputTokens,
    response.usage.completionTokens ?? config.budgets.maxOutputTokensPerCall,
    config,
  );
}

/**
 * Tracks run spend against budgets.maxTotalCostUsd. maxPrice bounds unit rates on the provider
 * side and maxTotalTokens bounds tokens, but neither bounds the bill for one run: the same token
 * budget is a different amount of money on a different model.
 */
export class RunCostLedgerV1 {
  #spentUsd = 0;

  constructor(private readonly ceilingUsd: number) {}

  get spentUsd(): number {
    return this.#spentUsd;
  }

  record(costUsd: number): void {
    this.#spentUsd += costUsd;
  }

  exceededBy(additionalUsd: number): number {
    return this.#spentUsd + additionalUsd - this.ceilingUsd;
  }
}

export function chargedTokens(response: Pick<ReviewProviderResponseV1, "usage">): number | null {
  const { promptTokens, completionTokens, totalTokens } = response.usage;
  if (promptTokens === null || completionTokens === null || totalTokens === null) {
    return null;
  }
  if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) {
    return null;
  }
  if (
    !Number.isSafeInteger(promptTokens) ||
    promptTokens < 0 ||
    !Number.isSafeInteger(completionTokens) ||
    completionTokens < 0
  ) {
    return null;
  }
  if (promptTokens + completionTokens !== totalTokens) {
    return null;
  }
  return totalTokens;
}

/**
 * An upper bound on the tokens one call's input can consume, measured in UTF-8 bytes.
 *
 * Bytes bound tokens from above: no tokenizer emits a token shorter than one byte, so the encoded
 * size of the payload is a ceiling on its token count no matter which model runs. The per-message
 * addend covers chat-template and role framing the payload itself does not carry. That makes this
 * safe to reserve against and safe to price at the unit-price ceiling, in the conservative
 * direction in both cases.
 *
 * It is not an estimate of the real token count, and it is not close to one. English prose and
 * JSON run roughly 3-4 bytes per token, so this typically overshoots by a factor of about four.
 * Anything shown to a user must therefore describe it as a reservation, never as a token count
 * they could check against a model's context window (#135).
 */
export function conservativeInputTokenUpperBound(
  messages: ReviewMessageV1[],
  responseSchema: unknown,
): number {
  const bytes = Buffer.byteLength(JSON.stringify({ messages, responseSchema }), "utf8");
  return bytes + messages.length * 256;
}
