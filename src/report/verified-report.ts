import type * as z from "zod";
import { canonicalizeJson, digestCanonicalJson } from "../contracts/canonical-json.js";
import { assertClaimScopeV1 } from "../contracts/claim-scope.js";
import type { ClaimVerificationV1 } from "../contracts/claim-verification.js";
import {
  assembleFinalClaimCandidateV4,
  type FinalClaimCandidateV4,
} from "../contracts/final-claim-candidate.js";
import type { ReviewBrief } from "../contracts/neutral-review-brief.js";
import { compareUtf16 } from "../contracts/primitives.js";
import type { ReviewClaimSetV1 } from "../contracts/review-claims.js";
import type { AuthorPacketV1 } from "../contracts/review-request.js";
import type { ReportAuthorContextV1Schema } from "../contracts/standards-results.js";
import { selectedRules } from "../contracts/standards-review.js";
import {
  CLAIM_PROJECTION_POLICY_VERSION_V1,
  FinalReviewReportV2Schema,
  StandardsReportV4Schema,
  type VerifiedReviewReport,
} from "../contracts/verified-report.js";
import { planClaimTransitionsV1, projectVerifiedClaimsV1 } from "./claim-projection.js";
import type { RunnerOwnedFinalCoverageV1 } from "./final-review-candidate.js";

export interface VerifiedReportInputV1 {
  brief: ReviewBrief;
  prior: ReviewClaimSetV1;
  priorVerification: ClaimVerificationV1;
  candidate: FinalClaimCandidateV4;
  finalVerification: ClaimVerificationV1 | null;
  coverage: RunnerOwnedFinalCoverageV1;
  claimedVerification: AuthorPacketV1["claimedVerification"];
  authorContext: z.infer<typeof ReportAuthorContextV1Schema> | null;
  authorStatements: string[];
}

/** Publish only independently eligible semantic claims and runner-owned attribution. */
export function materializeVerifiedReportV1(input: VerifiedReportInputV1): VerifiedReviewReport {
  const { brief, prior, priorVerification, finalVerification, coverage } = input;
  const candidate = assembleFinalClaimCandidateV4(prior, input.candidate);
  const mode = brief.schemaVersion === 1 ? "REQUIREMENTS" : "STANDARDS";
  if (
    candidate.mode !== mode ||
    canonicalizeJson([prior.snapshotDigest, prior.briefDigest]) !==
      canonicalizeJson([brief.snapshotManifest.snapshotDigest, brief.briefDigest])
  )
    throw new Error("Report binding or mode mismatch");
  if (
    input.authorContext?.status === "DECLINED" &&
    (input.authorStatements.length || input.claimedVerification.length)
  )
    throw new Error("Declined author context cannot carry author evidence");
  const proposal = {
    continuedClaimIds: candidate.continuedClaimIds,
    withdrawnClaimIds: candidate.withdrawnClaimIds,
    newClaims: candidate.newClaims,
  };
  const plan = planClaimTransitionsV1(prior, priorVerification, proposal);
  const canonicalIds = new Set(brief.snapshotManifest.canonicalInputs.map((entry) => entry.id));
  const rules = brief.schemaVersion === 1 ? [] : selectedRules(brief.canonicalInputs);
  assertClaimScopeV1(prior, brief);
  assertClaimScopeV1(plan.targets, brief);
  function completeScope(actual: string[], expected: string[]) {
    if (
      canonicalizeJson([...actual].sort(compareUtf16)) !==
      canonicalizeJson([...expected].sort(compareUtf16))
    )
      throw new Error("Report coverage must match frozen scope exactly");
  }
  completeScope(
    coverage.changedPathCoverage.map((entry) => entry.path),
    brief.snapshotManifest.paths.map((entry) => entry.path),
  );
  completeScope(
    coverage.canonicalInputCoverage.map((entry) => entry.canonicalInputId),
    [...canonicalIds],
  );
  const changedPathCoverage = coverage.changedPathCoverage.map(({ path, status }) => ({
    path,
    status,
    explanation: `Persisted blind scope records this path as ${status}.`,
  }));
  const canonicalInputCoverage = coverage.canonicalInputCoverage.map(
    ({ canonicalInputId, status }) => ({
      canonicalInputId,
      status,
      explanation: `Persisted blind scope records this canonical input as ${status}.`,
    }),
  );
  const limitations = [
    ...(coverage.blockingLimitations ?? []),
    ...changedPathCoverage
      .filter((entry) => entry.status === "UNASSESSED")
      .map((entry) => `Unassessed changed path: ${entry.path}.`),
    ...canonicalInputCoverage
      .filter((entry) => entry.status === "UNASSESSED")
      .map((entry) => `Unassessed canonical input: ${entry.canonicalInputId}.`),
  ];
  const projected = projectVerifiedClaimsV1(
    prior,
    priorVerification,
    proposal,
    finalVerification,
    limitations,
  );
  const priorIds = new Set(prior.claims.map((claim) => claim.claimId));
  const findings = projected.findings.map((finding) => {
    const finalOnly = !finding.claimIds.some((id) => priorIds.has(id));
    const common = {
      id: `finding_${finding.representativeClaimId.slice(6)}`,
      claimIds: finding.claimIds,
      representativeClaimId: finding.representativeClaimId,
      title: `Verified claim ${finding.representativeClaimId}`,
      impact: "Fresh claim verification demonstrated the stated violation.",
      evidence: finding.core.evidence.map((anchor) => ({
        ...anchor,
        detail: "Frozen evidence bound to the verified claim.",
      })),
      correction: finding.correction,
      origin: finalOnly ? "FINAL_ONLY" : "PRELIMINARY",
      emergenceRationale: finalOnly ? "New claim received fresh post-author verification." : null,
    };
    return finding.core.effect.kind === "REQUIREMENTS"
      ? { ...common, severity: finding.core.effect.severity, scenario: finding.core.assertion }
      : {
          ...common,
          severity:
            finding.core.effect.kind === "STANDARDS" ? finding.core.effect.enforcement : "REQUIRED",
          problem: finding.core.assertion,
          ruleIds: [
            ...new Set(
              finding.core.obligations.flatMap((ref) => (ref.ruleId === null ? [] : [ref.ruleId])),
            ),
          ].sort(compareUtf16),
        };
  });
  const common = {
    stage: "FINAL",
    snapshotDigest: prior.snapshotDigest,
    briefDigest: prior.briefDigest,
    summary: projected.summary,
    findings,
    uncertainties: projected.uncertainties,
    preliminaryFindingDispositions: [],
    preliminaryConcernDispositions: [],
    authorClaims: input.authorStatements.map((claim) => ({
      claim,
      status: "UNVERIFIED",
      explanation: "Author-provided statement; not independently observed by the runner.",
    })),
    authorVerificationClaims: input.claimedVerification.map((claim, claimIndex) => ({
      claimIndex,
      command: claim.command,
      claimedOutcome: claim.outcome,
      claimedSummary: claim.summary,
      status: "UNVERIFIED",
      explanation: "Author-reported command result; the runner did not execute this command.",
    })),
    authorContext: input.authorContext,
    changedPathCoverage,
    canonicalInputCoverage,
    limitations: projected.limitations,
    verdict: projected.verdict,
    nextActions: { blockers: projected.blockers, fastFollows: projected.fastFollows },
    projection: {
      policyVersion: CLAIM_PROJECTION_POLICY_VERSION_V1,
      priorClaimSetDigest: digestCanonicalJson(prior),
      priorVerificationDigest: digestCanonicalJson(priorVerification),
      candidateDigest: digestCanonicalJson(candidate),
      transitionDigest: digestCanonicalJson(plan),
      finalVerificationDigest:
        finalVerification === null ? null : digestCanonicalJson(finalVerification),
    },
  };
  if (mode === "REQUIREMENTS")
    return FinalReviewReportV2Schema.parse({ ...common, schemaVersion: 2, mode });
  const ruleAssessments = rules.map((rule) => {
    const states = projected.standardStates.filter((state) => state.ruleId === rule.id);
    const conflicts = states.filter((state) => state.status === "CONFLICT");
    return {
      ruleId: rule.id,
      status: conflicts.length ? "CONFLICT" : states.length ? "UNASSESSED" : "ASSESSED",
      conflictingRuleIds: [...new Set(conflicts.flatMap((state) => state.conflictingRuleIds))].sort(
        compareUtf16,
      ),
      explanation: states.length
        ? "Fresh claim verification leaves this rule unresolved."
        : "No eligible adverse rule-state claim remains.",
    };
  });
  return StandardsReportV4Schema.parse({ ...common, schemaVersion: 4, mode, ruleAssessments });
}
