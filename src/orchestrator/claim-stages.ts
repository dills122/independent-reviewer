import { digestCanonicalJson } from "../contracts/canonical-json.js";
import { assertClaimScopeV1 } from "../contracts/claim-scope.js";
import {
  assembleClaimVerificationV1,
  assertClaimVerificationV1,
  type ClaimVerificationV1,
} from "../contracts/claim-verification.js";
import {
  assembleFinalClaimCandidateV4,
  type FinalClaimCandidateV4,
} from "../contracts/final-claim-candidate.js";
import type { ReviewBrief } from "../contracts/neutral-review-brief.js";
import { assembleReviewClaimSetV1, type ReviewClaimSetV1 } from "../contracts/review-claims.js";
import { permittedModelsV1 } from "../contracts/review-run-config.js";
import type { RunRecordEventPayloadV2 } from "../contracts/run-record-v2.js";
import type { ReviewPreliminary } from "../contracts/standards-results.js";
import type {
  ReviewProviderRequestV2,
  ReviewProviderResponseV1,
} from "../provider/review-provider.js";
import { planClaimTransitionsV1 } from "../report/claim-projection.js";
import type { ReviewRunConfigV3 } from "./call-accounting.js";
import { reviewClaimSetV1 } from "./claim-adapter.js";
import { assertClaimFragmentBudgetV1 } from "./claim-admission.js";
import {
  CLAIM_VERIFICATION_POLICY_VERSION_V1,
  claimVerificationMessagesV1,
  claimVerificationResponseSchemaV1,
  FINAL_CLAIM_POLICY_VERSION_V4,
  FINAL_CLAIM_RESPONSE_SCHEMA_V4,
  finalClaimMessagesV4,
} from "./claim-policy.js";

interface CompletedClaimCallV1 {
  response: ReviewProviderResponseV1;
  attemptNumber: number;
  responseArtifact: string;
}
export interface ClaimStagesInputV1 {
  brief: ReviewBrief;
  preliminary: ReviewPreliminary;
  blindEvidence: unknown;
  authorEvidence: unknown;
  authorRelease: Extract<
    RunRecordEventPayloadV2,
    { type: "AUTHOR_DELIVERED" | "AUTHOR_CONTEXT_RELEASED" }
  >;
  config: ReviewRunConfigV3;
  fragmentLimits: {
    claimSetBytes: number;
    verificationBytes: number;
    transitionClaimsBytes: number;
  };
  complete(request: ReviewProviderRequestV2, promptVersion: string): Promise<CompletedClaimCallV1>;
  persist(name: string, value: unknown): Promise<void>;
  durable(event: RunRecordEventPayloadV2): Promise<void>;
  validateEvidence(claims: ReviewClaimSetV1): Promise<void>;
}

/** The author-release boundary follows durable blind judgments; every new effect is reverified. */
export async function completeClaimStagesV1(input: ClaimStagesInputV1) {
  const { brief, fragmentLimits } = input;
  const prior = reviewClaimSetV1(brief, input.preliminary).set;
  assertClaimScopeV1(prior, brief);
  await input.validateEvidence(prior);
  assertClaimFragmentBudgetV1(prior, fragmentLimits.claimSetBytes, "Preliminary claim set");
  const empty = assembleReviewClaimSetV1(
    { snapshotDigest: prior.snapshotDigest, briefDigest: prior.briefDigest },
    [],
  );
  await input.persist("preliminary-claims.json", prior);
  await input.durable({
    type: "PRELIMINARY_CLAIMS_PERSISTED",
    claimSetDigest: digestCanonicalJson(prior),
  });

  const blind = await verifyClaimStageV1(input, "FINDING_VERIFICATION", prior, empty);
  const priorVerification = blind.verification;
  assertClaimFragmentBudgetV1(
    priorVerification,
    fragmentLimits.verificationBytes,
    "Blind claim verification",
  );
  await input.persist("finding-verification.json", priorVerification);
  await input.durable({
    type: "FINDING_VERIFICATION_PERSISTED",
    verificationDigest: digestCanonicalJson(priorVerification),
    providerCall: blind.call !== null,
    ...(blind.call ? { acceptedAttemptNumber: blind.call.attemptNumber } : {}),
    responseArtifact: blind.call?.responseArtifact ?? null,
  });
  await input.durable(input.authorRelease);

  return continueClaimStagesV1(input, prior, priorVerification);
}

async function completeClaimCallV1(
  input: ClaimStagesInputV1,
  stage: ReviewProviderRequestV2["stage"],
  messages: ReviewProviderRequestV2["messages"],
  responseSchema: ReviewProviderRequestV2["responseSchema"],
  promptVersion: string,
) {
  const { config } = input;
  if (Buffer.byteLength(JSON.stringify(messages), "utf8") > config.budgets.maxConversationBytes)
    throw new Error("Claim conversation exceeds its admitted byte budget");
  return input.complete(
    {
      stage,
      models: permittedModelsV1(config),
      maxOutputTokens: config.budgets.maxOutputTokensPerCall,
      timeoutMs: config.budgets.timeoutMs,
      messages,
      responseSchema,
    },
    promptVersion,
  );
}
async function verifyClaimStageV1(
  input: ClaimStagesInputV1,
  stage: "FINDING_VERIFICATION" | "FINAL_CLAIM_VERIFICATION",
  targets: ReviewClaimSetV1,
  catalog: ReviewClaimSetV1,
): Promise<{ verification: ClaimVerificationV1; call: CompletedClaimCallV1 | null }> {
  const call =
    targets.claims.length === 0
      ? null
      : await completeClaimCallV1(
          input,
          stage,
          claimVerificationMessagesV1(
            stage,
            input.blindEvidence,
            targets,
            catalog,
            stage === "FINAL_CLAIM_VERIFICATION" ? input.authorEvidence : undefined,
          ),
          claimVerificationResponseSchemaV1(stage, targets.claims.length),
          CLAIM_VERIFICATION_POLICY_VERSION_V1,
        );
  const verification = assembleClaimVerificationV1(
    targets,
    catalog,
    call?.response.value ?? { schemaVersion: 1, stage, assessments: [] },
  );
  if (verification.stage !== stage) throw new Error("Claim verification stage mismatch");
  return { verification, call };
}

/** Resume enters only after retained artifacts and the author release have been validated. */
export async function continueClaimStagesV1(
  input: ClaimStagesInputV1,
  prior: ReviewClaimSetV1,
  priorVerification: ClaimVerificationV1,
  retained?: { candidate: FinalClaimCandidateV4; finalVerification?: ClaimVerificationV1 },
) {
  const { brief, fragmentLimits } = input;
  assertClaimScopeV1(prior, brief);
  const empty = assembleReviewClaimSetV1(
    { snapshotDigest: prior.snapshotDigest, briefDigest: prior.briefDigest },
    [],
  );
  assertClaimVerificationV1(priorVerification, prior, empty);
  if (priorVerification.stage !== "FINDING_VERIFICATION")
    throw new Error("Retained prior verification must be blind");
  assertClaimFragmentBudgetV1(prior, fragmentLimits.claimSetBytes, "Retained prior claim set");
  assertClaimFragmentBudgetV1(
    priorVerification,
    fragmentLimits.verificationBytes,
    "Retained blind verification",
  );
  const final = retained
    ? null
    : await completeClaimCallV1(
        input,
        "FINAL",
        finalClaimMessagesV4(input.blindEvidence, prior, priorVerification, input.authorEvidence),
        FINAL_CLAIM_RESPONSE_SCHEMA_V4,
        FINAL_CLAIM_POLICY_VERSION_V4,
      );
  const candidate = assembleFinalClaimCandidateV4(
    prior,
    retained?.candidate ?? final?.response.value,
  );
  if (candidate.mode !== (brief.schemaVersion === 1 ? "REQUIREMENTS" : "STANDARDS"))
    throw new Error("Final claim candidate mode mismatch");
  const proposal = {
    continuedClaimIds: candidate.continuedClaimIds,
    withdrawnClaimIds: candidate.withdrawnClaimIds,
    newClaims: candidate.newClaims,
  };
  const plan = planClaimTransitionsV1(prior, priorVerification, proposal);
  assertClaimScopeV1(plan.targets, brief);
  await input.validateEvidence(plan.targets);
  assertClaimFragmentBudgetV1(
    {
      targets: plan.targets.claims.map((claim) => claim.core),
      carriedCatalog: plan.catalog.claims.map((claim) => claim.core),
    },
    fragmentLimits.transitionClaimsBytes,
    "Post-author claim targets and catalog",
  );
  if (!retained) {
    await input.persist("final-candidate.json", candidate);
    await input.persist("claim-transitions.json", plan);
    await input.persist("final-claim-targets.json", plan.targets);
    await input.persist("carried-claim-catalog.json", plan.catalog);
    await input.durable({
      type: "FINAL_CANDIDATE_PERSISTED",
      candidateDigest: digestCanonicalJson(candidate),
      transitionDigest: digestCanonicalJson(plan),
      targetSetDigest: digestCanonicalJson(plan.targets),
      catalogSetDigest: digestCanonicalJson(plan.catalog),
    });
  }
  if (retained?.finalVerification) {
    const finalVerification = assertClaimVerificationV1(
      retained.finalVerification,
      plan.targets,
      plan.catalog,
    );
    if (finalVerification.stage !== "FINAL_CLAIM_VERIFICATION")
      throw new Error("Retained final verification stage mismatch");
    return { prior, priorVerification, candidate, plan, finalVerification };
  }
  const post = await verifyClaimStageV1(
    input,
    "FINAL_CLAIM_VERIFICATION",
    plan.targets,
    plan.catalog,
  );
  await input.persist("final-claim-verification.json", post.verification);
  await input.durable({
    type: "FINAL_CLAIM_VERIFICATION_PERSISTED",
    verificationDigest: digestCanonicalJson(post.verification),
    providerCall: post.call !== null,
    ...(post.call ? { acceptedAttemptNumber: post.call.attemptNumber } : {}),
    responseArtifact: post.call?.responseArtifact ?? null,
  });
  return { prior, priorVerification, candidate, plan, finalVerification: post.verification };
}
