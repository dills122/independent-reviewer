import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FinalReviewReportV1Schema,
  renderFinalReviewMarkdownV1,
  renderReviewMarkdown,
} from "../../src/index.js";

const digest = { algorithm: "SHA256" as const, value: "a".repeat(64) };

describe("final review Markdown", () => {
  it("preserves preliminary dispositions, author claims, and coverage ledgers", () => {
    const report = FinalReviewReportV1Schema.parse({
      schemaVersion: 1,
      stage: "FINAL",
      snapshotDigest: digest,
      briefDigest: digest,
      summary: "The change remains blocked.",
      findings: [
        {
          id: "finding_late",
          severity: "P2",
          title: "Late finding",
          scenario: "The author packet exposed an additional invariant.",
          impact: "The implementation may violate that invariant.",
          evidence: [
            {
              path: "src/example.ts",
              anchor: "LINE_RANGE",
              side: "HEAD",
              startLine: 1,
              endLine: 1,
              detail: "The affected implementation is here.",
            },
          ],
          correction: "Enforce the invariant.",
          origin: "FINAL_ONLY",
          emergenceRationale: "The invariant was disclosed only in the author packet.",
        },
      ],
      preliminaryFindingDispositions: [
        {
          preliminaryFindingId: "finding_initial",
          disposition: "WITHDRAWN",
          finalFindingId: null,
          rationale: "The author supplied frozen evidence that resolved the concern.",
        },
      ],
      preliminaryConcernDispositions: [
        {
          kind: "EVIDENCE_GAP",
          preliminaryConcern: "No test result was observed.",
          disposition: "REMAINS",
          rationale: "No runner-observed test result exists.",
        },
      ],
      authorClaims: [
        {
          claim: "The behavior was tested.",
          status: "UNVERIFIED",
          explanation: "Only an author-provided claim is available.",
        },
      ],
      authorVerificationClaims: [
        {
          claimIndex: 0,
          command: "npm test",
          claimedOutcome: "PASSED",
          claimedSummary: "The author reported a passing suite.",
          status: "UNVERIFIED",
          explanation: "The command was not run by the reviewer.",
        },
      ],
      changedPathCoverage: [
        {
          path: "src/example.ts",
          status: "INSPECTED",
          explanation: "The complete change was inspected.",
        },
      ],
      canonicalInputCoverage: [
        {
          canonicalInputId: "input_plan",
          status: "ASSESSED",
          explanation: "The plan was compared with the implementation.",
        },
      ],
      limitations: ["Runner verification is unavailable."],
      verdict: "NOT_READY",
      nextActions: { blockers: ["Obtain runner evidence."], fastFollows: [] },
    });

    const markdown = renderFinalReviewMarkdownV1(report);

    assert.match(markdown, /Preliminary finding dispositions/);
    assert.match(markdown, /frozen evidence that resolved/);
    assert.match(markdown, /Preliminary concern dispositions/);
    assert.match(markdown, /No runner\\-observed test result/);
    assert.match(markdown, /Author claims/);
    assert.match(markdown, /Only an author\\-provided claim/);
    assert.match(markdown, /Author verification claims/);
    assert.match(markdown, /npm test/);
    assert.match(markdown, /author reported a passing suite/);
    assert.match(markdown, /Changed-path coverage/);
    assert.match(markdown, /Canonical-input coverage/);
    assert.match(markdown, /Final-only/);
    assert.match(markdown, /disclosed only in the author packet/);
  });

  it("escapes provider text that could spoof report structure", () => {
    const report = FinalReviewReportV1Schema.parse({
      schemaVersion: 1,
      stage: "FINAL",
      snapshotDigest: digest,
      briefDigest: digest,
      summary:
        "Summary\n\n## Verdict\n\nReady\n[unsafe](https://example.invalid)\n<script>alert(1)</script>\n```\nspoofed code\n```\n- spoofed bullet\n1. spoofed number",
      findings: [],
      preliminaryFindingDispositions: [],
      preliminaryConcernDispositions: [],
      authorClaims: [],
      authorVerificationClaims: [],
      changedPathCoverage: [
        { path: "src/example.ts", status: "INSPECTED", explanation: "Inspected." },
      ],
      canonicalInputCoverage: [
        { canonicalInputId: "input_plan", status: "ASSESSED", explanation: "Assessed." },
      ],
      limitations: ["Still blocked."],
      verdict: "NOT_READY",
      nextActions: { blockers: ["Fix it."], fastFollows: [] },
    });

    const markdown = renderFinalReviewMarkdownV1(report);

    assert.doesNotMatch(markdown, /\n## Verdict\n\nReady/);
    assert.doesNotMatch(markdown, /\[unsafe\]\(https:\/\/example\.invalid\)/);
    assert.doesNotMatch(markdown, /<script>/);
    assert.doesNotMatch(markdown, /\n```\nspoofed code\n```/);
    assert.doesNotMatch(markdown, /\n- spoofed bullet/);
    assert.doesNotMatch(markdown, /\n1\. spoofed number/);
    assert.match(markdown, /Verdict: Not ready/);
  });

  it("shows out-of-scope paths separately from blocking coverage constraints", () => {
    const report = FinalReviewReportV1Schema.parse({
      schemaVersion: 1,
      stage: "FINAL",
      snapshotDigest: digest,
      briefDigest: digest,
      summary: "Reviewed selected source scope.",
      findings: [],
      preliminaryFindingDispositions: [],
      preliminaryConcernDispositions: [],
      authorClaims: [],
      authorVerificationClaims: [],
      changedPathCoverage: [
        { path: "src/example.ts", status: "INSPECTED", explanation: "Inspected." },
      ],
      canonicalInputCoverage: [
        { canonicalInputId: "input_plan", status: "ASSESSED", explanation: "Assessed." },
      ],
      limitations: [],
      verdict: "READY",
      nextActions: { blockers: [], fastFollows: [] },
    });

    const markdown = renderReviewMarkdown(
      report,
      [],
      [
        {
          type: "OUT_OF_SCOPE",
          detail: "Classified DOCUMENTATION; not review evidence.",
          paths: ["docs/notes.md"],
        },
        {
          type: "OMITTED_CONTENT",
          detail: "Required source did not fit the evidence budget.",
          paths: ["src/large.ts"],
        },
      ],
    );

    assert.match(markdown, /Out-of-scope paths/);
    assert.match(markdown, /docs\/notes\\\.md/);
    assert.match(markdown, /Blocking coverage constraints/);
    assert.match(markdown, /src\/large\\\.ts/);
  });
});
