import type { ReviewMessageV1 } from "../provider/review-provider.js";
import {
  conservativeInputTokenUpperBound,
  priceCeilingCostUsd,
  type ReviewRunConfigV3,
  reservationCostUsd,
} from "./call-accounting.js";

export type ClaimReviewStageV1 =
  | "PRELIMINARY"
  | "FINDING_VERIFICATION"
  | "FINAL"
  | "FINAL_CLAIM_VERIFICATION";
export type ClaimCallSkeletonsV1 = Record<
  ClaimReviewStageV1,
  { messages: ReviewMessageV1[]; responseSchema: unknown }
>;

/** Bound the serialized fragment as it appears escaped inside a wire message, not model tokens. */
export function assertClaimFragmentBudgetV1(value: unknown, limit: number, label: string): void {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid claim fragment budget");
  const bytes = Buffer.byteLength(JSON.stringify(JSON.stringify(value)), "utf8");
  if (bytes > limit)
    throw new Error(
      `${label} requires ${bytes} escaped bytes, exceeding its reserved ${limit}-byte capacity.`,
    );
}

/** Every mandatory stage plus the largest retry is admitted before provider call one. */
export function reserveClaimCallsV1(skeletons: ClaimCallSkeletonsV1, config: ReviewRunConfigV3) {
  const { prompt, completion, request } = config.providerRouting.maxPrice;
  if ([prompt, completion, request].some((price) => !Number.isFinite(price) || price < 0))
    throw new Error("Claim admission requires known nonnegative price ceilings");
  const output = config.budgets.maxOutputTokensPerCall;
  const fragmentLimits = {
    claimSetBytes: 4 * output,
    verificationBytes: 2 * output,
    transitionClaimsBytes: 8 * output,
  };
  const future = {
    PRELIMINARY: 0,
    FINDING_VERIFICATION: fragmentLimits.claimSetBytes,
    FINAL: fragmentLimits.claimSetBytes + fragmentLimits.verificationBytes,
    FINAL_CLAIM_VERIFICATION: fragmentLimits.transitionClaimsBytes,
  };
  const stageReservations = {} as Record<ClaimReviewStageV1, number>;
  for (const stage of Object.keys(future) as ClaimReviewStageV1[]) {
    const skeleton = skeletons[stage];
    const conversationBytes =
      Buffer.byteLength(JSON.stringify(skeleton.messages), "utf8") + future[stage];
    if (conversationBytes > config.budgets.maxConversationBytes)
      throw new Error(`The ${stage} conversation cannot reserve all mandatory claim fragments.`);
    stageReservations[stage] =
      conservativeInputTokenUpperBound(skeleton.messages, skeleton.responseSchema) +
      output +
      future[stage];
  }
  const requiredTokens = Object.values(stageReservations).reduce((sum, count) => sum + count, 0);
  const retryReservation = Math.max(...Object.values(stageReservations));
  const requiredWithRetry = requiredTokens + retryReservation;
  if (requiredWithRetry > config.budgets.maxTotalTokens)
    throw new Error(
      `Claim review requires a ${requiredWithRetry}-unit reservation for four stages and one retry; configured total is ${config.budgets.maxTotalTokens}.`,
    );
  const reservedCostUsd =
    reservationCostUsd(requiredTokens, config, 4) +
    priceCeilingCostUsd(retryReservation - output, output, config);
  if (reservedCostUsd > config.budgets.maxTotalCostUsd)
    throw new Error(
      `Claim review cannot reserve four stages and one retry within its total cost budget.`,
    );
  return {
    stageReservations,
    requiredTokens,
    retryReservation,
    requiredWithRetry,
    reservedCostUsd,
    fragmentLimits,
  };
}
