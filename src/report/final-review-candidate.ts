import {
  FinalReviewCandidateV1Schema,
  FinalReviewReportV1Schema,
  type AuthorPacketV1,
  type FinalReviewReportV1,
  type PreliminaryAssessmentV1,
} from "../contracts/index.js";

function assertCompleteIndices(indices: number[], count: number, label: string): void {
  if (
    indices.length !== count ||
    new Set(indices).size !== count ||
    indices.some((index) => index >= count)
  ) {
    throw new Error(`${label} must reference every source index exactly once.`);
  }
}

/** Resolves source references without changing any model judgment or source text. */
export function materializeFinalReviewCandidateV1(
  value: unknown,
  preliminary: Pick<PreliminaryAssessmentV1, "evidenceGaps" | "limitations">,
  claims: AuthorPacketV1["claimedVerification"],
): FinalReviewReportV1 {
  const candidate = FinalReviewCandidateV1Schema.parse(value);
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
  return FinalReviewReportV1Schema.parse({
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
  });
}
