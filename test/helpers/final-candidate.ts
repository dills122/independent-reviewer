/** Adapts existing readable report fixtures to the reduced provider-output contract. */
export function asFinalCandidateV3(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const report = value as Record<string, unknown>;
  if (report.stage !== "FINAL" || report.schemaVersion !== 1) return value;
  const {
    findings,
    preliminaryFindingDispositions,
    changedPathCoverage: _changedPathCoverage,
    canonicalInputCoverage: _canonicalInputCoverage,
    ...rest
  } = report;
  const dispositions = (preliminaryFindingDispositions ?? []) as Array<Record<string, unknown>>;
  return {
    ...rest,
    schemaVersion: 3,
    findings: (findings as Array<Record<string, unknown>>).map(
      ({ id, origin: _origin, emergenceRationale, ...finding }) => ({
        ...finding,
        sourceFindingIds: dispositions
          .filter((entry) => entry.finalFindingId === id && entry.disposition !== "WITHDRAWN")
          .map((entry) => entry.preliminaryFindingId),
        reconciliationRationale:
          emergenceRationale ?? "The supplied evidence supports this finding.",
      }),
    ),
    withdrawnPreliminaryFindings: dispositions
      .filter((entry) => entry.disposition === "WITHDRAWN")
      .map(({ preliminaryFindingId, rationale }) => ({ preliminaryFindingId, rationale })),
  };
}
