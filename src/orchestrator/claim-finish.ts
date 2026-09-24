import { digestCanonicalJson } from "../contracts/canonical-json.js";
import {
  type DigestV1,
  jsonDocument,
  ReviewReportMetadataV1Schema,
  sha256Utf8,
} from "../contracts/index.js";
import type { ReviewBrief } from "../contracts/neutral-review-brief.js";
import type { RunRecordEventPayloadV2 } from "../contracts/run-record-v2.js";
import {
  ReportAuthorContextV1Schema,
  type ReviewPreliminary,
} from "../contracts/standards-results.js";
import { selectedRules } from "../contracts/standards-review.js";
import { CLAIM_PROJECTION_POLICY_VERSION_V1 } from "../contracts/verified-report.js";
import { renderReviewMarkdown } from "../report/markdown.js";
import { materializeVerifiedReportV1 } from "../report/verified-report.js";
import { ensureClaimArtifactV1, writeClaimArtifactV1 } from "./claim-artifacts.js";
import { FINAL_CLAIM_RESPONSE_SCHEMA_V4 } from "./claim-policy.js";
import type { completeClaimStagesV1 } from "./claim-stages.js";
import { runnerOwnedFinalCoverage } from "./response-validation.js";
import type { ReleasedAuthorContextV1 } from "./review-input.js";
import type { ReviewOutputPathsV1 } from "./review-paths.js";
import {
  isStandardsBrief,
  preliminarySchemaNameForBrief,
  promptVersionForBrief,
} from "./review-policy.js";

export async function finishClaimReviewV1(input: {
  brief: ReviewBrief;
  preliminary: ReviewPreliminary;
  released: ReleasedAuthorContextV1;
  completed: Awaited<ReturnType<typeof completeClaimStagesV1>>;
  paths: ReviewOutputPathsV1;
  durable(event: RunRecordEventPayloadV2): Promise<void>;
  resume?: boolean;
  reportCheckpoint?: DigestV1;
}) {
  const { brief, preliminary, released, completed, paths, durable, reportCheckpoint } = input;
  const preliminaryPromptVersion = `${promptVersionForBrief(brief)}/claim-preliminary-v1`;
  const write = input.resume ? ensureClaimArtifactV1 : writeClaimArtifactV1;
  const authorContext = released.binding
    ? ReportAuthorContextV1Schema.parse({
        status: released.binding.status,
        digest: released.binding.digest,
        noteCode: released.binding.status === "DECLINED" ? "AUTHOR_CONTEXT_DECLINED" : null,
      })
    : null;
  const authorStatements = released.authorPacket
    ? [
        "overview" in released.authorPacket
          ? released.authorPacket.overview
          : JSON.stringify({ ...released.authorPacket, claimedVerification: undefined }),
      ]
    : [];
  const report = materializeVerifiedReportV1({
    brief,
    ...completed,
    coverage: runnerOwnedFinalCoverage(preliminary, brief),
    claimedVerification: released.claimedVerification,
    authorContext,
    authorStatements,
  });
  const document = jsonDocument(report);
  if (reportCheckpoint && reportCheckpoint.value !== digestCanonicalJson(report).value)
    throw new Error("Persisted final report disagrees with current projection");
  await write(paths.finalPath, document);
  if (!reportCheckpoint)
    await durable({
      type: "FINAL_REPORT_PERSISTED",
      reportDigest: digestCanonicalJson(report),
      projectionPolicyVersion: CLAIM_PROJECTION_POLICY_VERSION_V1,
    });
  await write(
    paths.reportMetadataPath,
    jsonDocument(
      ReviewReportMetadataV1Schema.parse({
        schemaVersion: 1,
        snapshotDigest: brief.snapshotManifest.snapshotDigest,
        briefDigest: brief.briefDigest,
        guidanceGraphDigest:
          brief.schemaVersion === 3 ? brief.guidanceGraph.guidanceGraphDigest : null,
        reportDigest: sha256Utf8(document),
        promptVersion: preliminaryPromptVersion,
        preliminarySchema: preliminarySchemaNameForBrief(brief),
        finalSchema: FINAL_CLAIM_RESPONSE_SCHEMA_V4.name,
      }),
    ),
  );
  await write(
    paths.markdownPath,
    renderReviewMarkdown(
      report,
      isStandardsBrief(brief) ? selectedRules(brief.canonicalInputs) : [],
      brief.coverageConstraints,
    ),
  );
  await durable({ type: "RUN_COMPLETED", terminalState: report.verdict });
  return {
    report,
    briefPath: paths.briefPath,
    preliminaryPath: paths.preliminaryPath,
    findingVerificationPath: paths.findingVerificationPath,
    finalPath: paths.finalPath,
    markdownPath: paths.markdownPath,
    reportMetadataPath: paths.reportMetadataPath,
    runRecordPath: paths.runRecordPath,
  };
}
