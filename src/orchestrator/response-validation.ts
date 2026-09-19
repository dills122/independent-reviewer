import * as z from "zod";

import {
  type AuthorPacketV1,
  applyAdmissiblePreliminaryConcernsV1,
  assembleFindingVerificationV4,
  assertFindingVerificationScopeV4,
  FindingVerificationCandidateV4Schema,
  type FindingVerificationV4,
  FindingVerificationV4Schema,
  logicalLineCountV1,
  PreliminaryAssessmentV1Schema,
  type PreliminaryConcernIdentityV3,
  type ReviewFindingV1,
  resolveSnapshotSourceContentV1,
} from "../contracts/index.js";
import type { ReviewBrief } from "../contracts/neutral-review-brief.js";
import {
  type ReviewPreliminary,
  type ReviewReport,
  StandardsPreliminaryV2Schema,
} from "../contracts/standards-results.js";
import {
  materializeFinalCandidate,
  type RunnerOwnedFinalCoverageV1,
} from "../report/final-review-candidate.js";
import { readSnapshotBlobV1 } from "../snapshot/snapshot-packet.js";
import { isStandardsBrief } from "./review-policy.js";
import {
  applyRunnerOwnedStandardsSeverityV1,
  assertStandardsChangedPathScope,
  assertStandardsFindings,
  assertStandardsRuleCoverage,
} from "./standards-policy.js";
import { assertFindingsUseTransmittedEvidenceV1 } from "./transmitted-evidence.js";

/**
 * Turns a provider completion into a validated review document, or refuses it.
 *
 * Everything here answers one question: does this response describe the frozen snapshot the model
 * was actually shown? Schema parsing alone cannot — a well-formed response can still cite a path
 * that was never transmitted, quote a line the file does not contain, or drop a canonical input it
 * was required to cover. Those checks live together because they share that premise, and because a
 * response failing any of them must be rejected before it reaches the run record.
 *
 * The distinct error classes matter to callers: a PreliminaryOutputValidationError is repairable by
 * asking the model again, while a FrozenEvidenceValidationError means the response contradicts the
 * snapshot and no retry can fix it.
 */
export function allowedPaths(brief: ReviewBrief): Set<string> {
  return new Set(
    brief.snapshotManifest.paths.flatMap((entry) =>
      "previousPath" in entry ? [entry.path, entry.previousPath] : [entry.path],
    ),
  );
}

export function runnerOwnedFinalCoverage(
  preliminary: ReviewPreliminary,
  brief: ReviewBrief,
): RunnerOwnedFinalCoverageV1 {
  const inspectedPaths = new Set(preliminary.inspectedPaths);
  const outOfScopePaths = new Set(
    brief.coverageConstraints
      .filter((constraint) => constraint.type === "OUT_OF_SCOPE")
      .flatMap((constraint) => constraint.paths),
  );
  const canonicalCoverage = new Map(
    preliminary.canonicalInputCoverage.map((entry) => [entry.canonicalInputId, entry]),
  );
  return {
    blockingLimitations: brief.coverageConstraints
      .filter((constraint) => constraint.type !== "OUT_OF_SCOPE")
      .map(
        (constraint) =>
          `Runner snapshot coverage constraint (${constraint.type}): ${constraint.detail}`,
      ),
    changedPathCoverage: brief.snapshotManifest.paths.map(({ path }) =>
      outOfScopePaths.has(path)
        ? {
            path,
            status: "OUT_OF_SCOPE" as const,
            explanation: "Runner classification excluded this path from selected review scope.",
          }
        : inspectedPaths.has(path)
          ? {
              path,
              status: "INSPECTED" as const,
              explanation: "Persisted blind assessment records this path as inspected.",
            }
          : {
              path,
              status: "UNASSESSED" as const,
              explanation: "Persisted blind assessment does not record this path as inspected.",
            },
    ),
    canonicalInputCoverage: brief.snapshotManifest.canonicalInputs.map(({ id }) => {
      const coverage = canonicalCoverage.get(id);
      if (!coverage) {
        throw new Error(`Persisted preliminary assessment omitted canonical input ${id}.`);
      }
      return coverage;
    }),
  };
}

export async function assertFindingEvidenceAnchors(
  findings: Array<Pick<ReviewFindingV1, "evidence">>,
  brief: ReviewBrief,
  packetPath: string,
): Promise<void> {
  const textByDigest = new Map<string, string>();
  for (const finding of findings) {
    for (const evidence of finding.evidence) {
      const content = resolveSnapshotSourceContentV1(
        brief.snapshotManifest.paths,
        evidence.path,
        evidence.side,
      );
      if (!content) {
        throw new Error(
          `Finding evidence does not identify a captured ${evidence.side} source: ${evidence.path}`,
        );
      }
      if (content.kind !== "TEXT") {
        throw new Error(`Finding evidence is not anchored to text content: ${evidence.path}`);
      }
      let source = textByDigest.get(content.digest.value);
      if (source === undefined) {
        try {
          source = new TextDecoder("utf-8", { fatal: true }).decode(
            await readSnapshotBlobV1(packetPath, content.digest),
          );
        } catch (error) {
          throw new FrozenEvidenceValidationError(
            "Captured evidence could not be validated locally.",
            { cause: error },
          );
        }
        textByDigest.set(content.digest.value, source);
      }
      if (evidence.anchor === "LINE_RANGE") {
        if (evidence.endLine > logicalLineCountV1(source)) {
          throw new Error(
            `Finding line range is outside the frozen source: ${evidence.path}:${evidence.startLine}-${evidence.endLine}`,
          );
        }
      } else if (!source.includes(evidence.symbol)) {
        throw new Error(
          `Finding symbol is absent from the frozen source: ${evidence.path}:${evidence.symbol}`,
        );
      }
    }
  }
  assertFindingsUseTransmittedEvidenceV1(findings, brief);
}

export function assertExactLedger(label: string, expected: string[], actual: string[]): void {
  const actualSet = new Set(actual);
  if (expected.length !== actual.length || expected.some((item) => !actualSet.has(item))) {
    throw new Error(`${label} must account for every required item exactly once.`);
  }
}

export async function assertAssessmentAnchors(
  assessment: ReviewPreliminary,
  brief: ReviewBrief,
  packetPath: string,
): Promise<void> {
  if (
    assessment.snapshotDigest.value !== brief.snapshotManifest.snapshotDigest.value ||
    assessment.briefDigest.value !== brief.briefDigest.value
  ) {
    throw new Error("Preliminary assessment identities do not match the frozen brief.");
  }
  const paths = allowedPaths(brief);
  for (const path of assessment.inspectedPaths) {
    if (!paths.has(path)) {
      throw new Error(`Preliminary assessment references an uncaptured path: ${path}`);
    }
  }
  for (const finding of assessment.findings) {
    for (const evidence of finding.evidence) {
      if (!paths.has(evidence.path)) {
        throw new Error(`Preliminary finding references an uncaptured path: ${evidence.path}`);
      }
    }
  }
  assertExactLedger(
    "Preliminary canonical-input coverage",
    brief.snapshotManifest.canonicalInputs.map((input) => input.id),
    assessment.canonicalInputCoverage.map((coverage) => coverage.canonicalInputId),
  );
  assertStandardsRuleCoverage(assessment, brief);
  assertStandardsFindings(assessment.findings, brief);
  await assertFindingEvidenceAnchors(assessment.findings, brief, packetPath);
}

export async function assertFinalSemantics(
  report: ReviewReport,
  preliminary: ReviewPreliminary,
  findingVerification: FindingVerificationV4,
  brief: ReviewBrief,
  packetPath: string,
  authorVerificationClaims: AuthorPacketV1["claimedVerification"],
): Promise<void> {
  if (
    report.snapshotDigest.value !== brief.snapshotManifest.snapshotDigest.value ||
    report.briefDigest.value !== brief.briefDigest.value
  ) {
    throw new Error("Final report identities do not match the frozen brief.");
  }
  if (
    (report.verdict === "READY" || report.verdict === "READY_WITH_FOLLOW_UPS") &&
    brief.coverageConstraints.some((constraint) => constraint.type !== "OUT_OF_SCOPE")
  ) {
    throw new Error("A ready verdict is invalid while a snapshot coverage constraint remains.");
  }
  const paths = allowedPaths(brief);
  const finalFindingIds = new Set(report.findings.map((finding) => finding.id));
  for (const finding of report.findings) {
    for (const evidence of finding.evidence) {
      if (!paths.has(evidence.path)) {
        throw new Error(`Final finding references an uncaptured path: ${evidence.path}`);
      }
    }
  }
  assertExactLedger(
    "Final changed-path coverage",
    brief.snapshotManifest.paths.map((entry) => entry.path),
    report.changedPathCoverage.map((coverage) => coverage.path),
  );
  assertStandardsChangedPathScope(report, brief);
  assertExactLedger(
    "Final canonical-input coverage",
    brief.snapshotManifest.canonicalInputs.map((input) => input.id),
    report.canonicalInputCoverage.map((coverage) => coverage.canonicalInputId),
  );
  assertExactLedger(
    "Author verification-claim coverage",
    authorVerificationClaims.map((_, index) => String(index)),
    report.authorVerificationClaims.map((claim) => String(claim.claimIndex)),
  );
  for (const claim of report.authorVerificationClaims) {
    const source = authorVerificationClaims[claim.claimIndex];
    if (
      !source ||
      claim.command !== source.command ||
      claim.claimedOutcome !== source.outcome ||
      claim.claimedSummary !== source.summary
    ) {
      throw new Error(
        `Author verification claim ${claim.claimIndex} does not match the stored author packet.`,
      );
    }
  }
  const preliminaryIds = new Set(preliminary.findings.map((finding) => finding.id));
  const dispositionIds = new Set(
    report.preliminaryFindingDispositions.map((item) => item.preliminaryFindingId),
  );
  if (
    preliminaryIds.size !== dispositionIds.size ||
    [...preliminaryIds].some((id) => !dispositionIds.has(id))
  ) {
    throw new Error("Final report must disposition every preliminary finding exactly once.");
  }
  for (const disposition of report.preliminaryFindingDispositions) {
    const mustBeNull = disposition.disposition === "WITHDRAWN";
    if (mustBeNull !== (disposition.finalFindingId === null)) {
      throw new Error(
        "Withdrawn findings require a null final ID; other dispositions require one.",
      );
    }
    if (disposition.finalFindingId && !finalFindingIds.has(disposition.finalFindingId)) {
      throw new Error(
        `Final disposition references a missing finding: ${disposition.finalFindingId}`,
      );
    }
  }
  const dispositionByPreliminaryId = new Map(
    report.preliminaryFindingDispositions.map((disposition) => [
      disposition.preliminaryFindingId,
      disposition,
    ]),
  );
  for (const assessment of findingVerification.assessments) {
    if (
      assessment.status === "NO_VIOLATION" &&
      dispositionByPreliminaryId.get(assessment.preliminaryFindingId)?.disposition !== "WITHDRAWN"
    ) {
      throw new Error(
        `Adversarial verifier found no violation; preliminary finding must be withdrawn: ${assessment.preliminaryFindingId}`,
      );
    }
  }
  for (const assessment of findingVerification.concernAssessments) {
    const concerns =
      assessment.kind === "EVIDENCE_GAP" ? preliminary.evidenceGaps : preliminary.limitations;
    const source = concerns[assessment.concernIndex];
    const disposition = report.preliminaryConcernDispositions.find(
      (entry) => entry.kind === assessment.kind && entry.preliminaryConcern === source,
    );
    const expectedDisposition =
      assessment.status === "NO_BLOCKING_UNCERTAINTY" ? "RESOLVED" : "REMAINS";
    if (disposition?.disposition !== expectedDisposition) {
      throw new Error(
        `Adversarial verifier requires preliminary concern disposition ${expectedDisposition}: ${assessment.kind}:${assessment.concernIndex}`,
      );
    }
  }
  const dispositionFinalIds = new Set(
    report.preliminaryFindingDispositions.flatMap((item) =>
      item.finalFindingId === null ? [] : [item.finalFindingId],
    ),
  );
  for (const finding of report.findings) {
    const hasPreliminarySource = dispositionFinalIds.has(finding.id);
    if ((finding.origin === "PRELIMINARY") !== hasPreliminarySource) {
      throw new Error(
        `Final finding origin does not match its preliminary disposition provenance: ${finding.id}`,
      );
    }
  }
  const expectedConcerns = [
    ...preliminary.evidenceGaps.map((concern) => `EVIDENCE_GAP:${concern}`),
    ...preliminary.limitations.map((concern) => `LIMITATION:${concern}`),
  ];
  assertExactLedger(
    "Preliminary concern dispositions",
    expectedConcerns,
    report.preliminaryConcernDispositions.map(
      (disposition) => `${disposition.kind}:${disposition.preliminaryConcern}`,
    ),
  );
  assertStandardsRuleCoverage(report, brief);
  assertStandardsFindings(report.findings, brief);
  await assertFindingEvidenceAnchors(report.findings, brief, packetPath);
}

export class PreliminaryOutputValidationError extends Error {
  override readonly name = "PreliminaryOutputValidationError";
}

export class FrozenEvidenceValidationError extends Error {
  override readonly name = "FrozenEvidenceValidationError";
}

export async function parsePreliminary(
  value: unknown,
  brief: ReviewBrief,
  packetPath: string,
): Promise<ReviewPreliminary> {
  const parsed = (
    isStandardsBrief(brief) ? StandardsPreliminaryV2Schema : PreliminaryAssessmentV1Schema
  ).safeParse(
    applyAdmissiblePreliminaryConcernsV1(applyRunnerOwnedStandardsSeverityV1(value, brief)),
  );
  if (!parsed.success) {
    throw new PreliminaryOutputValidationError(
      `Invalid preliminary assessment: ${z.prettifyError(parsed.error)}`,
      { cause: parsed.error },
    );
  }
  try {
    await assertAssessmentAnchors(parsed.data, brief, packetPath);
    return parsed.data;
  } catch (error) {
    if (error instanceof FrozenEvidenceValidationError) throw error;
    const detail =
      error instanceof z.ZodError
        ? z.prettifyError(error)
        : error instanceof Error
          ? error.message
          : "semantic validation failed";
    throw new PreliminaryOutputValidationError(`Invalid preliminary assessment: ${detail}`, {
      cause: error,
    });
  }
}

export class ReviewOutputValidationError extends Error {
  override readonly name = "ReviewOutputValidationError";
}

export class FindingVerificationOutputValidationError extends Error {
  override readonly name = "FindingVerificationOutputValidationError";
}

export function preliminaryConcernIdentitiesV3(
  preliminary: Pick<ReviewPreliminary, "evidenceGaps" | "limitations">,
): PreliminaryConcernIdentityV3[] {
  return [
    ...preliminary.evidenceGaps.map((_, concernIndex) => ({
      kind: "EVIDENCE_GAP" as const,
      concernIndex,
    })),
    ...preliminary.limitations.map((_, concernIndex) => ({
      kind: "LIMITATION" as const,
      concernIndex,
    })),
  ];
}

export function parseFindingVerification(
  value: unknown,
  preliminary: ReviewPreliminary,
  brief: ReviewBrief,
): FindingVerificationV4 {
  const parsed = FindingVerificationV4Schema.safeParse(value);
  if (!parsed.success) {
    throw new FindingVerificationOutputValidationError(
      `Invalid finding verification: ${z.prettifyError(parsed.error)}`,
      { cause: parsed.error },
    );
  }
  if (
    parsed.data.snapshotDigest.value !== brief.snapshotManifest.snapshotDigest.value ||
    parsed.data.briefDigest.value !== brief.briefDigest.value
  ) {
    throw new FindingVerificationOutputValidationError(
      "Finding verification identities do not match the frozen brief.",
    );
  }
  try {
    assertFindingVerificationScopeV4(
      parsed.data,
      preliminary.findings.map((finding) => finding.id),
      preliminaryConcernIdentitiesV3(preliminary),
    );
  } catch (error) {
    throw new FindingVerificationOutputValidationError(
      error instanceof Error ? error.message : "Finding verification scope is invalid.",
      { cause: error },
    );
  }
  return parsed.data;
}

export function parseFindingVerificationCandidate(
  value: unknown,
  preliminary: ReviewPreliminary,
  brief: ReviewBrief,
): FindingVerificationV4 {
  const parsed = FindingVerificationCandidateV4Schema.safeParse(value);
  if (!parsed.success) {
    throw new FindingVerificationOutputValidationError(
      `Invalid finding verification: ${z.prettifyError(parsed.error)}`,
      { cause: parsed.error },
    );
  }
  if (
    parsed.data.snapshotDigest.value !== brief.snapshotManifest.snapshotDigest.value ||
    parsed.data.briefDigest.value !== brief.briefDigest.value
  ) {
    throw new FindingVerificationOutputValidationError(
      "Finding verification identities do not match the frozen brief.",
    );
  }
  try {
    return assembleFindingVerificationV4(
      parsed.data,
      preliminary.findings.map((finding) => finding.id),
      preliminaryConcernIdentitiesV3(preliminary),
    );
  } catch (error) {
    throw new FindingVerificationOutputValidationError(
      error instanceof Error ? error.message : "Finding verification scope is invalid.",
      { cause: error },
    );
  }
}

export async function parseFinal(
  value: unknown,
  preliminary: ReviewPreliminary,
  findingVerification: FindingVerificationV4,
  brief: ReviewBrief,
  packetPath: string,
  authorVerificationClaims: AuthorPacketV1["claimedVerification"],
): Promise<ReviewReport> {
  try {
    const report = materializeFinalCandidate(
      applyRunnerOwnedStandardsSeverityV1(value, brief),
      preliminary,
      authorVerificationClaims,
      runnerOwnedFinalCoverage(preliminary, brief),
    );
    await assertFinalSemantics(
      report,
      preliminary,
      findingVerification,
      brief,
      packetPath,
      authorVerificationClaims,
    );
    return report;
  } catch (error) {
    if (error instanceof FrozenEvidenceValidationError) throw error;
    const detail =
      error instanceof z.ZodError
        ? z.prettifyError(error)
        : error instanceof Error
          ? error.message
          : "semantic validation failed";
    throw new ReviewOutputValidationError(`Invalid final report: ${detail}`, { cause: error });
  }
}
