import {
  type AuthorPacketV1,
  FinalReviewCandidateV1Schema,
  FinalReviewCandidateV2Schema,
  FinalReviewCandidateV3Schema,
  type FinalReviewReportV1,
  FinalReviewReportV1Schema,
  type PreliminaryAssessmentV1,
} from "../contracts/index.js";
import {
  type ReviewPreliminary,
  type ReviewReport,
  StandardsCandidateV3Schema,
  StandardsExpandedCandidateV2Schema,
  StandardsReportV2Schema,
} from "../contracts/standards-results.js";

export type RunnerOwnedFinalCoverageV1 = Pick<
  FinalReviewReportV1,
  "changedPathCoverage" | "canonicalInputCoverage"
> & { blockingLimitations?: string[] };

const RUNNER_COVERAGE_LIMITATION_PREFIX =
  "Runner coverage is incomplete because the blind assessment did not record inspection of: ";

interface RunnerBookkeepingCandidateV1 extends Record<string, unknown> {
  findings: Array<{ severity: string; correction: string }>;
  limitations: string[];
  preliminaryConcernDispositions: Array<{
    disposition: string;
    kind?: string | undefined;
    preliminaryConcern?: string | undefined;
  }>;
  nextActions: { blockers: string[]; fastFollows: string[] };
  ruleAssessments?: Array<{ ruleId: string; status: string }>;
}

function applyRunnerCoverage(
  candidate: RunnerBookkeepingCandidateV1,
  coverage: RunnerOwnedFinalCoverageV1,
): RunnerBookkeepingCandidateV1 &
  Pick<FinalReviewReportV1, "changedPathCoverage" | "canonicalInputCoverage"> {
  const { blockingLimitations = [], ...finalCoverage } = coverage;
  const unassessed = coverage.changedPathCoverage
    .filter((entry) => entry.status === "UNASSESSED")
    .map((entry) => entry.path);
  const unassessedInputs = coverage.canonicalInputCoverage
    .filter((entry) => entry.status === "UNASSESSED")
    .map((entry) => entry.canonicalInputId);
  const missing = [...unassessed, ...unassessedInputs];
  const coverageLimitations = missing.length
    ? [`${RUNNER_COVERAGE_LIMITATION_PREFIX}${missing.join(", ")}.`]
    : [];
  const limitations = [
    ...new Set([...candidate.limitations, ...coverageLimitations, ...blockingLimitations]),
  ];
  return {
    ...candidate,
    ...finalCoverage,
    limitations,
  };
}

function applyRunnerBookkeeping(
  candidate: RunnerBookkeepingCandidateV1,
  standards: boolean,
): Record<string, unknown> {
  const blockingFindings = candidate.findings.filter((finding) =>
    ["P0", "P1", "REQUIRED"].includes(finding.severity),
  );
  const nonBlockingCorrections = candidate.findings
    .filter((finding) => !["P0", "P1", "REQUIRED"].includes(finding.severity))
    .map((finding) => finding.correction);
  const blockers = [...new Set(blockingFindings.map((finding) => finding.correction))];
  const fastFollows = [
    ...new Set([...nonBlockingCorrections, ...candidate.nextActions.fastFollows]),
  ];
  const unresolvedConcernLimitations = candidate.preliminaryConcernDispositions.flatMap(
    (disposition) => {
      if (disposition.disposition !== "REMAINS" || !disposition.preliminaryConcern) return [];
      const kind = disposition.kind === "EVIDENCE_GAP" ? "evidence gap" : "limitation";
      return [`Preliminary ${kind} remains unresolved: ${disposition.preliminaryConcern}`];
    },
  );
  const unassessedRuleIds = (candidate.ruleAssessments ?? [])
    .filter((assessment) => assessment.status === "UNASSESSED")
    .map((assessment) => assessment.ruleId)
    .sort();
  const conflictedRuleIds = (candidate.ruleAssessments ?? [])
    .filter((assessment) => assessment.status === "CONFLICT")
    .map((assessment) => assessment.ruleId)
    .sort();
  const standardsLimitations = [
    ...(unassessedRuleIds.length
      ? [`Standards remain unassessed: ${unassessedRuleIds.join(", ")}.`]
      : []),
    ...(conflictedRuleIds.length
      ? [`Standards conflict remains unresolved: ${conflictedRuleIds.join(", ")}.`]
      : []),
  ];
  const limitations = [
    ...new Set([
      ...candidate.limitations,
      ...unresolvedConcernLimitations,
      ...standardsLimitations,
    ]),
  ];
  const incomplete =
    limitations.length > 0 ||
    candidate.preliminaryConcernDispositions.some(
      (disposition) => disposition.disposition === "REMAINS",
    );
  const verdict =
    (standards && incomplete) || (blockingFindings.length === 0 && incomplete)
      ? "UNABLE_TO_VERIFY"
      : blockingFindings.length > 0
        ? "NOT_READY"
        : fastFollows.length > 0
          ? "READY_WITH_FOLLOW_UPS"
          : "READY";
  return {
    ...candidate,
    limitations,
    verdict,
    nextActions: { blockers, fastFollows },
  };
}

function assertCompleteIndices(indices: number[], count: number, label: string): void {
  if (
    indices.length !== count ||
    new Set(indices).size !== count ||
    indices.some((index) => index >= count)
  ) {
    throw new Error(
      `${label} must reference indices ${JSON.stringify(Array.from({ length: count }, (_, index) => index))} exactly once; received ${JSON.stringify(indices)}.`,
    );
  }
}

/** Resolves source references without changing any model judgment or source text. */
function materializeExpandedCandidate(
  value: unknown,
  preliminary: Pick<PreliminaryAssessmentV1, "evidenceGaps" | "limitations">,
  claims: AuthorPacketV1["claimedVerification"],
  standards = false,
  runnerOwnsBookkeeping = false,
): ReviewReport {
  const candidate = standards
    ? StandardsExpandedCandidateV2Schema.parse(value)
    : FinalReviewCandidateV1Schema.parse(value);
  assertCompleteIndices(
    candidate.authorVerificationClaims.map((claim) => claim.claimIndex),
    claims.length,
    "Author verification claims",
  );
  const concerns = {
    EVIDENCE_GAP: preliminary.evidenceGaps,
    LIMITATION: preliminary.limitations,
  };
  for (const kind of ["EVIDENCE_GAP", "LIMITATION"] as const) {
    assertCompleteIndices(
      candidate.preliminaryConcernDispositions
        .filter((entry) => entry.kind === kind)
        .map((entry) => entry.concernIndex),
      concerns[kind].length,
      `Preliminary ${kind} dispositions`,
    );
  }
  const expandedCandidate = {
    ...candidate,
    authorVerificationClaims: candidate.authorVerificationClaims.map((claim) => {
      const source = claims[claim.claimIndex];
      if (!source) throw new Error("Unknown author claim index.");
      return {
        ...claim,
        command: source.command,
        claimedOutcome: source.outcome,
        claimedSummary: source.summary,
      };
    }),
    preliminaryConcernDispositions: candidate.preliminaryConcernDispositions.map(
      ({ concernIndex, ...disposition }) => ({
        ...disposition,
        preliminaryConcern: concerns[disposition.kind][concernIndex],
      }),
    ),
  };
  const report = (standards ? StandardsReportV2Schema : FinalReviewReportV1Schema).parse(
    runnerOwnsBookkeeping
      ? applyRunnerBookkeeping(expandedCandidate, standards)
      : expandedCandidate,
  );
  // Missing evidence requests are review workflow, not permission to invent standards or edit code.
  if (
    report.schemaVersion === 2 &&
    report.findings.length === 0 &&
    report.ruleAssessments.every((entry) => entry.status === "UNASSESSED")
  ) {
    return {
      ...report,
      nextActions: {
        blockers: [
          `Supply the existing authoritative evidence identified in limitations for unassessed standards: ${report.ruleAssessments
            .map((entry) => entry.ruleId)
            .sort()
            .join(
              ", ",
            )}. Do not change code or invent standards merely because evidence is unavailable.`,
        ],
        fastFollows: [],
      },
    };
  }
  // Conflict-only follow-up is a runner-owned workflow action, not a code correction.
  // Preserve the model's assessment and raw candidate; never invent a winning rule.
  if (
    report.schemaVersion === 2 &&
    report.findings.length === 0 &&
    report.ruleAssessments.every((entry) => entry.status === "CONFLICT")
  ) {
    const conflicts = report.ruleAssessments
      .filter((entry) => entry.status === "CONFLICT")
      .map((entry) => entry.ruleId)
      .sort();
    if (conflicts.length)
      return {
        ...report,
        nextActions: {
          blockers: [
            `Clarify precedence, applicability, or exceptions for conflicting standards: ${conflicts.join(", ")}. Do not change code merely to satisfy one conflicting rule.`,
          ],
          fastFollows: [],
        },
      };
  }
  return report;
}

export function materializeFinalCandidate(
  value: unknown,
  preliminary: ReviewPreliminary,
  claims: AuthorPacketV1["claimedVerification"],
  coverage: RunnerOwnedFinalCoverageV1,
): ReviewReport {
  const standards = preliminary.schemaVersion === 2;
  const { findings, withdrawnPreliminaryFindings, ...candidate } = (
    standards ? StandardsCandidateV3Schema : FinalReviewCandidateV3Schema
  ).parse(value);
  const expected = new Set(preliminary.findings.map((finding) => finding.id));
  const actual = [
    ...findings.flatMap((finding) => finding.sourceFindingIds),
    ...withdrawnPreliminaryFindings.map((finding) => finding.preliminaryFindingId),
  ];
  const missing = [...expected].filter((id) => !actual.includes(id));
  const unknown = actual.filter((id) => !expected.has(id));
  const duplicates = actual.filter((id, index) => actual.indexOf(id) !== index);
  if (missing.length || unknown.length || duplicates.length) {
    throw new Error(
      `Preliminary references: missing=${JSON.stringify(missing)}, unknown=${JSON.stringify(unknown)}, duplicate=${JSON.stringify(duplicates)}. Each source belongs to one final finding or one explicit withdrawal.`,
    );
  }
  const finalFindings = findings.map(
    ({ sourceFindingIds, reconciliationRationale, ...finding }, index) => ({
      ...finding,
      id: `finding_final_${index + 1}`,
      origin: sourceFindingIds.length ? "PRELIMINARY" : "FINAL_ONLY",
      emergenceRationale: sourceFindingIds.length ? null : reconciliationRationale,
    }),
  );
  return materializeExpandedCandidate(
    applyRunnerCoverage(
      {
        ...candidate,
        schemaVersion: standards ? 2 : 1,
        findings: finalFindings,
        preliminaryFindingDispositions: [
          ...findings.flatMap((finding, index) =>
            finding.sourceFindingIds.map((id) => ({
              preliminaryFindingId: id,
              disposition: finding.sourceFindingIds.length > 1 ? "MERGED" : "REVISED",
              finalFindingId: finalFindings[index]?.id,
              rationale: finding.reconciliationRationale,
            })),
          ),
          ...withdrawnPreliminaryFindings.map((finding) => ({
            ...finding,
            disposition: "WITHDRAWN",
            finalFindingId: null,
          })),
        ],
      },
      coverage,
    ),
    preliminary,
    claims,
    standards,
    true,
  );
}

export function materializeFinalReviewCandidateV1(
  value: unknown,
  preliminary: Pick<PreliminaryAssessmentV1, "evidenceGaps" | "limitations">,
  claims: AuthorPacketV1["claimedVerification"],
): FinalReviewReportV1 {
  return FinalReviewReportV1Schema.parse(materializeExpandedCandidate(value, preliminary, claims));
}
export function materializeFinalReviewCandidateV2(
  value: unknown,
  preliminary: PreliminaryAssessmentV1,
  claims: AuthorPacketV1["claimedVerification"],
): FinalReviewReportV1 {
  const {
    changedPathCoverage,
    canonicalInputCoverage,
    schemaVersion: _schemaVersion,
    ...candidate
  } = FinalReviewCandidateV2Schema.parse(value);
  return FinalReviewReportV1Schema.parse(
    materializeFinalCandidate({ ...candidate, schemaVersion: 3 }, preliminary, claims, {
      changedPathCoverage,
      canonicalInputCoverage,
    }),
  );
}
