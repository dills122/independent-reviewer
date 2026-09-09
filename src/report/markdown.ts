import type { FinalReviewReportV1 } from "../contracts/index.js";
import type { ReviewReport } from "../contracts/standards-results.js";
import type { selectedRules } from "../contracts/standards-review.js";

/** Human-readable verdict names, shared with the CLI so the two cannot disagree. */
export const VERDICT_LABELS_V1: Record<FinalReviewReportV1["verdict"], string> = {
  READY: "Ready",
  READY_WITH_FOLLOW_UPS: "Ready with non-blocking follow-ups",
  NOT_READY: "Not ready",
  UNABLE_TO_VERIFY: "Unable to verify",
};

function escapeMarkdown(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]{}()#+\-.!|])/g, "\\$1");
}

function list(items: string[]): string {
  return items.length === 0 ? "None." : items.map((item) => `- ${escapeMarkdown(item)}`).join("\n");
}

function lineItems(items: string[]): string {
  return items.length === 0 ? "None." : items.map((item) => `- ${item}`).join("\n");
}

/** Renders only validated report fields; it does not infer or change a verdict. */
export function renderReviewMarkdown(
  report: ReviewReport,
  rules: ReturnType<typeof selectedRules> = [],
): string {
  const findings =
    report.findings.length === 0
      ? "None."
      : report.findings
          .map(
            (finding) =>
              `### ${finding.severity}: ${escapeMarkdown(finding.title)}\n\nOrigin: ${finding.origin === "FINAL_ONLY" ? `Final-only — ${escapeMarkdown(finding.emergenceRationale ?? "")}` : "Preliminary assessment"}\n\n${escapeMarkdown("problem" in finding ? finding.problem : finding.scenario)}${"ruleIds" in finding ? `\n\nStandards: ${finding.ruleIds.map(escapeMarkdown).join(", ")}` : ""}\n\nImpact: ${escapeMarkdown(finding.impact)}\n\nCorrection: ${escapeMarkdown(finding.correction)}\n\nEvidence:\n${finding.evidence
                .map((evidence) => {
                  const location =
                    evidence.anchor === "LINE_RANGE"
                      ? `${evidence.side} lines ${evidence.startLine}-${evidence.endLine}`
                      : `${evidence.side} symbol ${escapeMarkdown(evidence.symbol)}`;
                  return `- ${escapeMarkdown(evidence.path)} (${location}): ${escapeMarkdown(evidence.detail)}`;
                })
                .join("\n")}`,
          )
          .join("\n\n");

  const preliminaryFindingDispositions = report.preliminaryFindingDispositions.map(
    (item) =>
      `${escapeMarkdown(item.preliminaryFindingId)}: ${item.disposition}${item.finalFindingId ? ` as ${escapeMarkdown(item.finalFindingId)}` : ""} — ${escapeMarkdown(item.rationale)}`,
  );
  const preliminaryConcernDispositions = report.preliminaryConcernDispositions.map(
    (item) =>
      `${item.kind} ${item.disposition}: ${escapeMarkdown(item.preliminaryConcern)} — ${escapeMarkdown(item.rationale)}`,
  );
  const authorClaims = report.authorClaims.map(
    (item) => `${item.status}: ${escapeMarkdown(item.claim)} — ${escapeMarkdown(item.explanation)}`,
  );
  const authorVerificationClaims = report.authorVerificationClaims.map(
    (item) =>
      `Claim ${item.claimIndex} (${escapeMarkdown(item.command)}, author reported ${item.claimedOutcome}: ${escapeMarkdown(item.claimedSummary)}): ${item.status} — ${escapeMarkdown(item.explanation)}`,
  );
  const changedPathCoverage = report.changedPathCoverage.map(
    (item) => `${escapeMarkdown(item.path)}: ${item.status} — ${escapeMarkdown(item.explanation)}`,
  );
  const canonicalInputCoverage = report.canonicalInputCoverage.map(
    (item) =>
      `${escapeMarkdown(item.canonicalInputId)}: ${item.status} — ${escapeMarkdown(item.explanation)}`,
  );

  return [
    report.schemaVersion === 2 ? "# Standards review" : "# Independent review",
    "",
    `Verdict: ${reviewVerdictLabel(report)}`,
    "",
    escapeMarkdown(report.summary),
    "",
    "## Findings",
    "",
    findings,
    "",
    ...(report.schemaVersion === 2
      ? [
          "## Rule assessments",
          "",
          ...report.ruleAssessments.map(
            (entry) =>
              `- ${escapeMarkdown(entry.ruleId)}: ${entry.status}${entry.conflictingRuleIds.length ? ` (conflicts: ${entry.conflictingRuleIds.map(escapeMarkdown).join(", ")})` : ""} — ${escapeMarkdown(entry.explanation)}`,
          ),
          "",
          "## Selected standards",
          "",
          ...rules.map(
            (rule) =>
              `- ${escapeMarkdown(rule.id)} (${rule.enforcement}): ${escapeMarkdown(rule.text)} Source: ${escapeMarkdown(rule.source)}. Applies to: ${rule.paths.map(escapeMarkdown).join(", ")}. Exceptions: ${escapeMarkdown(rule.exceptions ?? "None declared.")}`,
          ),
          "",
          "This result covers selected standards only; it is not a bug-free or deployment-readiness assessment.",
          "",
        ]
      : []),
    "## Preliminary finding dispositions",
    "",
    lineItems(preliminaryFindingDispositions),
    "",
    "## Preliminary concern dispositions",
    "",
    lineItems(preliminaryConcernDispositions),
    "",
    "## Author claims",
    "",
    lineItems(authorClaims),
    "",
    "## Author verification claims",
    "",
    lineItems(authorVerificationClaims),
    "",
    "## Changed-path coverage",
    "",
    lineItems(changedPathCoverage),
    "",
    "## Canonical-input coverage",
    "",
    lineItems(canonicalInputCoverage),
    "",
    "## Blockers",
    "",
    list(report.nextActions.blockers),
    "",
    "## Fast follows",
    "",
    list(report.nextActions.fastFollows),
    "",
    "## Limitations",
    "",
    list(report.limitations),
    "",
  ].join("\n");
}

export const STANDARDS_VERDICT_LABELS = {
  READY: "Standards satisfied",
  READY_WITH_FOLLOW_UPS: "Standards review: non-blocking recommendations",
  NOT_READY: "Standards review: changes requested",
  UNABLE_TO_VERIFY: "Standards review: unable to assess",
};
export function reviewVerdictLabel(report: ReviewReport): string {
  return (report.schemaVersion === 2 ? STANDARDS_VERDICT_LABELS : VERDICT_LABELS_V1)[
    report.verdict
  ];
}
export function renderFinalReviewMarkdownV1(report: FinalReviewReportV1): string {
  return renderReviewMarkdown(report);
}
