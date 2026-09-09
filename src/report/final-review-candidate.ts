import {
  FinalReviewCandidateV1Schema,
  FinalReviewCandidateV2Schema,
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
    throw new Error(
      `${label} must reference indices ${JSON.stringify(Array.from({ length: count }, (_, index) => index))} exactly once; received ${JSON.stringify(indices)}.`,
    );
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

export function materializeFinalReviewCandidateV2(
  value: unknown,
  preliminary: PreliminaryAssessmentV1,
  claims: AuthorPacketV1["claimedVerification"],
): FinalReviewReportV1 {
  const { findings, withdrawnPreliminaryFindings, ...candidate } =
    FinalReviewCandidateV2Schema.parse(value);
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
  return materializeFinalReviewCandidateV1(
    {
      ...candidate,
      schemaVersion: 1,
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
    preliminary,
    claims,
  );
}
