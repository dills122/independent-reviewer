import {
  canonicalizeJson,
  cloneCanonicalJson,
  digestCanonicalJson,
} from "../contracts/canonical-json.js";
import {
  assertClaimVerificationV1,
  type ClaimVerificationAssessmentV1,
  type ClaimVerificationV1,
} from "../contracts/claim-verification.js";
import { compareUtf16 } from "../contracts/primitives.js";
import {
  assembleReviewClaimSetV1,
  type IdentifiedReviewClaimV1,
  type ReviewClaimCoreV1,
  ReviewClaimCoreV1Schema,
  type ReviewClaimSetV1,
  ReviewClaimSetV1Schema,
} from "../contracts/review-claims.js";

export {
  type ClaimTransitionProposalV1,
  ClaimTransitionProposalV1Schema,
} from "../contracts/final-claim-candidate.js";

import {
  type ClaimTransitionProposalV1,
  ClaimTransitionProposalV1Schema,
} from "../contracts/final-claim-candidate.js";

type TransitionKind = "CONTINUED" | "WITHDRAWAL_PROPOSED" | "NEW_OR_CHANGED" | "REJECTED_CARRIED";

function binding(set: ReviewClaimSetV1) {
  return { snapshotDigest: set.snapshotDigest, briefDigest: set.briefDigest };
}
function empty(set: ReviewClaimSetV1) {
  return assembleReviewClaimSetV1(binding(set), []);
}

/** A source ID is provenance only. Content identity decides which judgments can carry. */
export function planClaimTransitionsV1(
  priorInput: ReviewClaimSetV1,
  verificationInput: ClaimVerificationV1,
  proposalInput: ClaimTransitionProposalV1,
) {
  const prior = ReviewClaimSetV1Schema.parse(cloneCanonicalJson(priorInput));
  const verification = assertClaimVerificationV1(verificationInput, prior, empty(prior));
  if (verification.stage !== "FINDING_VERIFICATION")
    throw new Error("Prior claims require blind verification.");
  const proposal = ClaimTransitionProposalV1Schema.parse(cloneCanonicalJson(proposalInput));
  const mentioned = [...proposal.continuedClaimIds, ...proposal.withdrawnClaimIds];
  const priorIds = new Set(prior.claims.map(({ claimId }) => claimId));
  if (
    mentioned.length !== priorIds.size ||
    new Set(mentioned).size !== mentioned.length ||
    mentioned.some((id) => !priorIds.has(id))
  )
    throw new Error("Every prior claim must be continued or proposed for withdrawal exactly once.");
  const additions = assembleReviewClaimSetV1(binding(prior), proposal.newClaims);
  if (additions.claims.some(({ claimId }) => priorIds.has(claimId)))
    throw new Error("An existing claim must use its prior transition, not a new claim.");
  if (new Set([...prior.claims, ...additions.claims].map(({ core }) => core.mode)).size > 1)
    throw new Error("Claim transitions cannot mix review modes.");
  const withdrawn = new Set(proposal.withdrawnClaimIds);
  const transitions: Array<{ claimId: string; kind: TransitionKind }> = [];
  const targets: ReviewClaimCoreV1[] = additions.claims.map(({ core }) => core);
  const catalog: ReviewClaimCoreV1[] = [];
  for (const [index, claim] of prior.claims.entries()) {
    const status = verification.assessments[index]?.status;
    const kind: TransitionKind =
      status === "REJECTED"
        ? "REJECTED_CARRIED"
        : withdrawn.has(claim.claimId)
          ? "WITHDRAWAL_PROPOSED"
          : "CONTINUED";
    transitions.push({ claimId: claim.claimId, kind });
    if (kind === "WITHDRAWAL_PROPOSED") targets.push(claim.core);
    if (kind === "CONTINUED") catalog.push(claim.core);
  }
  for (const claim of additions.claims)
    transitions.push({ claimId: claim.claimId, kind: "NEW_OR_CHANGED" });
  transitions.sort((left, right) => compareUtf16(left.claimId, right.claimId));
  return {
    schemaVersion: 1 as const,
    ...binding(prior),
    priorSetDigest: digestCanonicalJson(prior),
    priorVerificationDigest: digestCanonicalJson(verification),
    proposalDigest: digestCanonicalJson(proposal),
    transitions,
    targets: assembleReviewClaimSetV1(binding(prior), targets),
    catalog: assembleReviewClaimSetV1(binding(prior), catalog),
  };
}

type EligibleClaim = { claim: IdentifiedReviewClaimV1; assessment: ClaimVerificationAssessmentV1 };
function effectRank(core: ReviewClaimCoreV1): number {
  if (core.effect.kind === "REQUIREMENTS")
    return ["P0", "P1", "P2", "P3"].indexOf(core.effect.severity);
  return core.effect.kind === "STANDARDS" && core.effect.enforcement === "RECOMMENDED" ? 2 : 0;
}
function blocking(core: ReviewClaimCoreV1): boolean {
  return effectRank(core) < 2;
}
function canonicalUnion<T>(values: T[]): T[] {
  return [...new Map(values.map((value) => [canonicalizeJson(value), value])).entries()]
    .sort(([a], [b]) => compareUtf16(a, b))
    .map(([, value]) => value);
}

function groupFindings(eligible: EligibleClaim[]) {
  const demonstrated = eligible.filter(
    ({ claim, assessment }) =>
      claim.core.kind === "VIOLATION" && assessment.status === "DEMONSTRATED",
  );
  const byId = new Map(demonstrated.map((item) => [item.claim.claimId, item]));
  const parent = new Map(demonstrated.map(({ claim }) => [claim.claimId, claim.claimId]));
  const root = (id: string): string => {
    let current = id;
    const visited = new Set<string>();
    while (parent.get(current) !== current) {
      if (visited.has(current)) throw new Error("Cyclic duplicate claim relation.");
      visited.add(current);
      const next = parent.get(current);
      if (!next) throw new Error("Missing duplicate claim root.");
      current = next;
    }
    return current;
  };
  for (const item of demonstrated) {
    const other = item.assessment.duplicateOf;
    if (other && byId.has(other)) parent.set(root(item.claim.claimId), root(other));
  }
  const groups = new Map<string, EligibleClaim[]>();
  for (const item of demonstrated) {
    const key = root(item.claim.claimId);
    const members = groups.get(key) ?? [];
    members.push(item);
    groups.set(key, members);
  }
  return [...groups.values()]
    .map((members) => {
      members.sort(
        (left, right) =>
          effectRank(left.claim.core) - effectRank(right.claim.core) ||
          compareUtf16(left.claim.claimId, right.claim.claimId),
      );
      const strongest = members[0];
      if (!strongest) throw new Error("Empty claim group.");
      const representative =
        members.find(
          (item) =>
            effectRank(item.claim.core) === effectRank(strongest.claim.core) &&
            item.assessment.correctionStatus === "SUPPORTED",
        ) ?? strongest;
      const core = ReviewClaimCoreV1Schema.parse({
        ...representative.claim.core,
        obligations: canonicalUnion(members.flatMap(({ claim }) => claim.core.obligations)),
        evidence: canonicalUnion(members.flatMap(({ claim }) => claim.core.evidence)),
      });
      return {
        claimIds: members.map(({ claim }) => claim.claimId).sort(compareUtf16),
        representativeClaimId: representative.claim.claimId,
        core,
        correction:
          representative.assessment.correctionStatus === "SUPPORTED" && core.correction !== null
            ? core.correction
            : `Determine a supported correction for ${representative.claim.claimId}; no correction has been verified.`,
      };
    })
    .sort(
      (left, right) =>
        effectRank(left.core) - effectRank(right.core) ||
        compareUtf16(left.representativeClaimId, right.representativeClaimId),
    );
}

/** Pure projection: no free-form model summary, disposition or correction gains authority here. */
export function projectVerifiedClaimsV1(
  priorInput: ReviewClaimSetV1,
  verificationInput: ClaimVerificationV1,
  proposalInput: ClaimTransitionProposalV1,
  finalInput: ClaimVerificationV1 | null,
  coverageLimitations: string[] = [],
) {
  const plan = planClaimTransitionsV1(priorInput, verificationInput, proposalInput);
  const prior = ReviewClaimSetV1Schema.parse(cloneCanonicalJson(priorInput));
  const previous = assertClaimVerificationV1(verificationInput, prior, empty(prior));
  const final =
    finalInput === null ? null : assertClaimVerificationV1(finalInput, plan.targets, plan.catalog);
  if (
    (plan.targets.claims.length > 0 && final === null) ||
    (final && final.stage !== "FINAL_CLAIM_VERIFICATION")
  )
    throw new Error("Final claims require matching post-author verification before projection.");
  const priorById = new Map(prior.claims.map((claim) => [claim.claimId, claim]));
  const priorJudgments = new Map(previous.assessments.map((item) => [item.claimId, item]));
  const targetById = new Map(plan.targets.claims.map((claim) => [claim.claimId, claim]));
  const finalJudgments = new Map(final?.assessments.map((item) => [item.claimId, item]) ?? []);
  const eligible: EligibleClaim[] = [];
  const rejectedClaimIds: string[] = [];
  for (const transition of plan.transitions) {
    const claim = priorById.get(transition.claimId) ?? targetById.get(transition.claimId);
    if (!claim) throw new Error("Missing transition claim.");
    let assessment =
      transition.kind === "NEW_OR_CHANGED"
        ? finalJudgments.get(claim.claimId)
        : priorJudgments.get(claim.claimId);
    if (
      transition.kind === "WITHDRAWAL_PROPOSED" &&
      finalJudgments.get(claim.claimId)?.status === "REJECTED"
    )
      assessment = finalJudgments.get(claim.claimId);
    if (!assessment) throw new Error("Missing verified claim judgment.");
    if (assessment.status === "REJECTED") rejectedClaimIds.push(claim.claimId);
    else eligible.push({ claim, assessment });
  }
  const findings = groupFindings(eligible);
  const uncertainties: Array<{ claimId: string; blocking: boolean; assertion: string }> = [];
  const standardStates: Array<{
    claimId: string;
    ruleId: string;
    status: "CONFLICT" | "UNASSESSED";
    conflictingRuleIds: string[];
  }> = [];
  for (const { claim, assessment } of eligible) {
    if (claim.core.effect.kind === "STANDARD_STATUS") {
      standardStates.push({
        claimId: claim.claimId,
        ruleId: claim.core.effect.ruleId,
        status: assessment.status === "INCONCLUSIVE" ? "UNASSESSED" : claim.core.effect.status,
        conflictingRuleIds:
          assessment.status === "INCONCLUSIVE" ? [] : claim.core.effect.conflictingRuleIds,
      });
    } else if (claim.core.kind === "BLOCKING_UNCERTAINTY" || assessment.status === "INCONCLUSIVE") {
      uncertainties.push({
        claimId: claim.claimId,
        blocking: blocking(claim.core),
        assertion: claim.core.assertion,
      });
    }
  }
  const blockers = findings
    .filter(({ core }) => blocking(core))
    .map(({ correction }) => correction);
  const fastFollows = findings
    .filter(({ core }) => !blocking(core))
    .map(({ correction }) => correction);
  for (const uncertainty of uncertainties.filter((item) => !item.blocking))
    fastFollows.push(`Verify unresolved claim ${uncertainty.claimId}.`);
  const limitations = [
    ...new Set([
      ...coverageLimitations,
      ...uncertainties
        .filter((item) => item.blocking)
        .map((item) => `Unresolved claim ${item.claimId}: ${item.assertion}`),
      ...standardStates.map(
        (item) => `Standard ${item.ruleId} remains ${item.status}: ${item.claimId}.`,
      ),
    ]),
  ];
  const standards = [...prior.claims, ...plan.targets.claims].some(
    ({ core }) => core.mode === "STANDARDS",
  );
  const verdict =
    limitations.length > 0 && (standards || blockers.length === 0)
      ? "UNABLE_TO_VERIFY"
      : blockers.length > 0
        ? "NOT_READY"
        : fastFollows.length > 0
          ? "READY_WITH_FOLLOW_UPS"
          : "READY";
  return {
    findings,
    uncertainties,
    standardStates,
    rejectedClaimIds,
    verdict,
    blockers,
    fastFollows,
    limitations,
    summary: `${verdict}: ${findings.length} verified finding(s), ${fastFollows.length} follow-up(s), ${limitations.length} blocking uncertainty or coverage limitation(s).`,
  };
}
