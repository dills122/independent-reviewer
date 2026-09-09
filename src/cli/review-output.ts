import { stripVTControlCharacters } from "node:util";
import type { ReviewReport } from "../contracts/standards-results.js";
import type { ReviewProgress } from "../orchestrator/progress.js";
import { reviewVerdictLabel } from "../report/markdown.js";
export function terminalText(text: string): string {
  return stripVTControlCharacters(text)
    .split("")
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159) ? " " : char;
    })
    .join("");
}
export function createProgressOutput(write: (message: string) => void, quiet: boolean) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const emit = (text: string) => {
    if (!quiet) write(text);
  };
  return {
    close,
    observe(event: ReviewProgress) {
      if (event.type === "CALL_STARTED") {
        close();
        const label =
          event.stage === "PRELIMINARY"
            ? "Reviewing code against standards"
            : "Reconciling author explanation";
        emit(`${label}…`);
        const start = Date.now();
        if (!quiet) {
          timer = setInterval(() => {
            try {
              emit(`${label} — ${Math.floor((Date.now() - start) / 1000)}s elapsed`);
            } catch {
              close();
            }
          }, 10000);
          timer.unref();
        }
      }
      if (["CALL_SUCCEEDED", "CALL_FAILED", "RUN_COMPLETED", "RUN_FAILED"].includes(event.type))
        close();
      if (event.type === "PRELIMINARY_PERSISTED") emit("Initial assessment saved.");
      if (event.type === "PROVIDER_RETRY_REQUESTED")
        emit(
          `Provider call failed. Retrying in ${Math.ceil((event.delayMs ?? 0) / 1000)}s; saved work retained.`,
        );
    },
  };
}
export function terminalReviewSummary(report: ReviewReport): string {
  return [
    reviewVerdictLabel(report),
    ...report.findings.map((finding) => {
      const location = finding.evidence[0];
      const anchor = location
        ? `${location.path}:${location.anchor === "LINE_RANGE" ? location.startLine : location.symbol}`
        : "";
      return `${finding.severity}: ${finding.title} (${anchor})\n${"ruleIds" in finding ? `Standards: ${finding.ruleIds.join(", ")}. ` : ""}Correction: ${finding.correction}`;
    }),
    ...report.limitations.map((text) => `Limitation: ${text}`),
  ]
    .map(terminalText)
    .join("\n");
}

export function formatRunCost(events: Record<string, unknown>[]): string {
  let reported = 0;
  let unknown = 0;
  for (const event of events) {
    if (event.type !== "CALL_SUCCEEDED" && event.type !== "CALL_FAILED") continue;
    const metadata = event.responseMetadata;
    const usage =
      event.type === "CALL_SUCCEEDED"
        ? event.usage
        : metadata && typeof metadata === "object"
          ? (metadata as Record<string, unknown>).usage
          : undefined;
    const cost =
      usage && typeof usage === "object" ? (usage as Record<string, unknown>).cost : undefined;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) reported += cost;
    else unknown++;
  }
  return `Provider-reported cost: $${reported.toFixed(6)}${unknown ? `; ${unknown} call(s) have unknown cost.` : "."} Budget reservations are not confirmed charges.`;
}
