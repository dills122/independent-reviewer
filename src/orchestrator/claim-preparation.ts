import {
  GuidancePromptPresentationSchema,
  PRELIMINARY_ASSESSMENT_V1_JSON_SCHEMA,
  type ReviewContextMapV1,
  type ReviewUnitPlanV1,
} from "../contracts/index.js";
import type { ReviewBrief } from "../contracts/neutral-review-brief.js";
import { STANDARDS_PRELIMINARY_V2_JSON_SCHEMA } from "../contracts/standards-results.js";
import { selectedRules } from "../contracts/standards-review.js";
import { parseStrictJsonV1 } from "../contracts/strict-json.js";
import type { ReviewMessageV1 } from "../provider/review-provider.js";
import type { ReviewRunConfigV3 } from "./call-accounting.js";
import { type ClaimCallSkeletonsV1, reserveClaimCallsV1 } from "./claim-admission.js";
import {
  claimVerificationMessagesV1,
  claimVerificationResponseSchemaV1,
  FINAL_CLAIM_RESPONSE_SCHEMA_V4,
  finalClaimMessagesV4,
} from "./claim-policy.js";
import { evaluateGuidanceAdmissionV2 } from "./guidance-admission.js";
import { constrainResponseSchemaV1 } from "./response-schema.js";
import {
  authorReleaseMessageV1,
  blindReviewEvidence,
  type ReleasedAuthorContextV1,
} from "./review-input.js";
import { isStandardsBrief, systemPolicyForBrief } from "./review-policy.js";
import { transmittedEvidencePathsV1 } from "./transmitted-evidence.js";

export const CLAIM_PRELIMINARY_POLICY_SUFFIX_V1 =
  " Each finding scenario/problem and correction, evidence gap, limitation, and adverse rule-state explanation must be trimmed single-line text of at most 600 Unicode scalar values and 2400 UTF-8 bytes. Describe one root cause per finding. Only exact semantic claims will be eligible for fresh verification; presentation prose cannot affect final outcome.";

export function prepareClaimReviewV1(
  brief: ReviewBrief,
  released: ReleasedAuthorContextV1,
  config: ReviewRunConfigV3,
  plan: ReviewUnitPlanV1,
  contextMap: ReviewContextMapV1,
) {
  const blindEvidence = blindReviewEvidence(brief, plan, contextMap);
  const preliminaryConstrained = constrainResponseSchemaV1(
    isStandardsBrief(brief)
      ? STANDARDS_PRELIMINARY_V2_JSON_SCHEMA
      : PRELIMINARY_ASSESSMENT_V1_JSON_SCHEMA,
    {
      evidencePaths: transmittedEvidencePathsV1(brief),
      changedPaths: brief.snapshotManifest.paths.map((entry) => entry.path).sort(),
      canonicalInputIds: brief.snapshotManifest.canonicalInputs.map((entry) => entry.id).sort(),
      identities: {
        snapshotDigest: brief.snapshotManifest.snapshotDigest.value,
        briefDigest: brief.briefDigest.value,
      },
      authorVerificationClaims: [],
      ...(isStandardsBrief(brief)
        ? { ruleIds: selectedRules(brief.canonicalInputs).map((rule) => rule.id) }
        : {}),
    },
  );
  const authorEvidence = parseStrictJsonV1(authorReleaseMessageV1(brief, released), {
    maxBytes: 64 * 1024 * 1024,
    source: "author release",
  });
  function skeletons(evidence: unknown): ClaimCallSkeletonsV1 {
    const preliminaryMessages: ReviewMessageV1[] = [
      { role: "system", content: systemPolicyForBrief(brief) + CLAIM_PRELIMINARY_POLICY_SUFFIX_V1 },
      { role: "user", content: JSON.stringify(evidence) },
    ];
    return {
      PRELIMINARY: { messages: preliminaryMessages, responseSchema: preliminaryConstrained.schema },
      FINDING_VERIFICATION: {
        messages: claimVerificationMessagesV1("FINDING_VERIFICATION", evidence, null, null),
        responseSchema: claimVerificationResponseSchemaV1("FINDING_VERIFICATION", 1024).schema,
      },
      FINAL: {
        messages: finalClaimMessagesV4(evidence, null, null, authorEvidence),
        responseSchema: FINAL_CLAIM_RESPONSE_SCHEMA_V4.schema,
      },
      FINAL_CLAIM_VERIFICATION: {
        messages: claimVerificationMessagesV1(
          "FINAL_CLAIM_VERIFICATION",
          evidence,
          null,
          null,
          authorEvidence,
        ),
        responseSchema: claimVerificationResponseSchemaV1("FINAL_CLAIM_VERIFICATION", 1024).schema,
      },
    };
  }
  const calls = skeletons(blindEvidence);
  let guidanceAdmission: ReturnType<typeof evaluateGuidanceAdmissionV2> | null = null;
  if (brief.schemaVersion === 3) {
    const presentation = GuidancePromptPresentationSchema.parse(
      parseStrictJsonV1(brief.guidancePresentation, {
        maxBytes: 64 * 1024 * 1024,
        source: "guidance presentation",
      }),
    );
    const {
      guidanceGraph: _graph,
      guidancePresentation: _presentation,
      ...baseline
    } = blindEvidence as Record<string, unknown>;
    const baselineCalls = skeletons(baseline);
    const delta = (stage: keyof ClaimCallSkeletonsV1) =>
      Buffer.byteLength(JSON.stringify(calls[stage].messages), "utf8") -
      Buffer.byteLength(JSON.stringify(baselineCalls[stage].messages), "utf8");
    guidanceAdmission = evaluateGuidanceAdmissionV2({
      contentBytes: presentation.sources.reduce(
        (total, source) => total + Buffer.byteLength(source.content, "utf8"),
        0,
      ),
      capacityBytes: config.budgets.maxConversationBytes,
      wireBytesByStage: {
        preliminary: delta("PRELIMINARY"),
        findingVerification: delta("FINDING_VERIFICATION"),
        final: delta("FINAL"),
        finalClaimVerification: delta("FINAL_CLAIM_VERIFICATION"),
      },
    });
    if (guidanceAdmission.status === "STOP")
      throw new Error(
        `Repository guidance admission stopped before provider access: ${guidanceAdmission.stopReasons.join(", ")}`,
      );
  }
  return {
    blindEvidence,
    authorEvidence,
    preliminaryConstrained,
    calls,
    admission: reserveClaimCallsV1(calls, config),
    guidanceAdmission,
  };
}
