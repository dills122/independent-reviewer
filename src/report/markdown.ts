import type { FinalReviewReportV1 } from "../contracts/index.js";

const verdictLabels: Record<FinalReviewReportV1["verdict"], string> = {
  READY: "Ready",
  READY_WITH_FOLLOW_UPS: "Ready with non-blocking follow-ups",
  NOT_READY: "Not ready",
  UNABLE_TO_VERIFY: "Unable to verify",
};

function list(items: string[]): string {
  return items.length === 0 ? "None." : items.map((item) => `- ${item}`).join("\n");
}

/** Renders only validated report fields; it does not infer or change a verdict. */
export function renderFinalReviewMarkdownV1(report: FinalReviewReportV1): string {
  const findings =
    report.findings.length === 0
      ? "None."
      : report.findings
          .map(
            (finding) =>
              `### ${finding.severity}: ${finding.title}\n\n${finding.scenario}\n\nImpact: ${finding.impact}\n\nCorrection: ${finding.correction}\n\nEvidence:\n${finding.evidence.map((evidence) => `- \`${evidence.path}\`: ${evidence.detail}`).join("\n")}`,
          )
          .join("\n\n");

  return [
    "# Independent review",
    "",
    `Verdict: ${verdictLabels[report.verdict]}`,
    "",
    report.summary,
    "",
    "## Findings",
    "",
    findings,
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
