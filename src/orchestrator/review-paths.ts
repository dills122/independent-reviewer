import { join } from "node:path";
/**
 * Every path one review writes under a packet.
 *
 * Built once so the two entry points cannot disagree about where an artifact lives. They used to
 * construct overlapping lists independently, and `resumeFinalReview` has to find exactly what
 * `runTwoStageReview` wrote -- a mismatch would surface as a missing-file failure partway through
 * a resume rather than as anything a reader could see (#123).
 */
export interface ReviewOutputPathsV1 {
  reviewDirectory: string;
  briefPath: string;
  planPath: string;
  preliminaryPath: string;
  findingVerificationPath: string;
  finalPath: string;
  markdownPath: string;
  reportMetadataPath: string;
  runRecordPath: string;
  preliminaryProviderPath: string;
  preliminaryRepairProviderPath: string;
  findingVerificationProviderPath: string;
  finalProviderPath: string;
  finalResumeClaimPath: string;
}

export function reviewOutputPathsV1(packetPath: string): ReviewOutputPathsV1 {
  const reviewDirectory = join(packetPath, "review");
  const at = (name: string): string => join(reviewDirectory, name);
  return {
    reviewDirectory,
    briefPath: at("neutral-review-brief.json"),
    planPath: at("review-unit-plan.json"),
    preliminaryPath: at("preliminary.json"),
    findingVerificationPath: at("finding-verification.json"),
    finalPath: at("final.json"),
    markdownPath: at("report.md"),
    reportMetadataPath: at("report-metadata.json"),
    runRecordPath: at("run-record.jsonl"),
    preliminaryProviderPath: at("preliminary-provider-response.json"),
    preliminaryRepairProviderPath: at("preliminary-repair-provider-response.json"),
    findingVerificationProviderPath: at("finding-verification-provider-response.json"),
    finalProviderPath: at("final-provider-response.json"),
    finalResumeClaimPath: at("final-resume-claim.json"),
  };
}
