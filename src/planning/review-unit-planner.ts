import { createHash } from "node:crypto";

import parseDiff from "parse-diff";

import { verifyReviewBriefIdentity } from "../contracts/artifact-identity.js";
import type { ReviewBrief } from "../contracts/neutral-review-brief.js";
import { compareUtf16 } from "../contracts/primitives.js";
import {
  type ReviewContextMapV1,
  verifyReviewContextMapIdentityV1,
} from "../contracts/review-context-map.js";
import { finalizeReviewUnitPlanV1, type ReviewUnitPlanV1 } from "../contracts/review-unit-plan.js";
import { canonicalInputList } from "../contracts/standards-review.js";

export interface ReviewUnitPlannerOptionsV1 {
  policyVersion: string;
  maxSupportingBytesPerUnit: number;
}

function stableIdentifier(prefix: "plan" | "unit", value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function changedLinesBySide(evidence: ReviewBrief["initialEvidence"][number]): {
  BASE: Set<number>;
  HEAD: Set<number>;
} {
  if (evidence.type === "SOURCE_CONTEXT") {
    return {
      BASE:
        evidence.side === "BASE"
          ? new Set(
              Array.from(
                { length: evidence.endLine - evidence.startLine + 1 },
                (_, index) => evidence.startLine + index,
              ),
            )
          : new Set(),
      HEAD:
        evidence.side === "HEAD"
          ? new Set(
              Array.from(
                { length: evidence.endLine - evidence.startLine + 1 },
                (_, index) => evidence.startLine + index,
              ),
            )
          : new Set(),
    };
  }
  const lines = { BASE: new Set<number>(), HEAD: new Set<number>() };
  for (const file of parseDiff(evidence.content)) {
    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        if (change.type === "del") lines.BASE.add(change.ln);
        if (change.type === "add") lines.HEAD.add(change.ln);
      }
    }
  }
  return lines;
}

function primaryRegionsForPath(
  path: string,
  basePath: string,
  evidence: ReviewBrief["initialEvidence"],
  contextMap: ReviewContextMapV1,
): string[] {
  const changedLines = { BASE: new Set<number>(), HEAD: new Set<number>() };
  const diffEvidence = evidence.filter((item) => item.type === "DIFF_HUNK");
  const seedEvidence = diffEvidence.length > 0 ? diffEvidence : evidence;
  for (const item of seedEvidence) {
    const itemLines = changedLinesBySide(item);
    for (const line of itemLines.BASE) changedLines.BASE.add(line);
    for (const line of itemLines.HEAD) changedLines.HEAD.add(line);
  }
  const selected = new Set<string>();
  for (const side of ["BASE", "HEAD"] as const) {
    const declarations = contextMap.regions.filter(
      (region) =>
        region.origin === "CHANGED_PATH" &&
        region.path === (side === "BASE" ? basePath : path) &&
        region.side === side &&
        region.kind === "DECLARATION" &&
        region.range,
    );
    for (const line of changedLines[side]) {
      const smallest = declarations
        .filter(
          (region) =>
            region.range && line >= region.range.startLine && line <= region.range.endLine,
        )
        .sort(
          (left, right) =>
            (left.range?.contentByteLength ?? left.byteLength) -
              (right.range?.contentByteLength ?? right.byteLength) ||
            compareUtf16(left.regionId, right.regionId),
        )[0];
      if (smallest) selected.add(smallest.regionId);
    }
  }
  if (selected.size === 0) {
    const fallback = contextMap.regions
      .filter(
        (region) =>
          region.origin === "CHANGED_PATH" && region.path === path && region.kind === "FILE",
      )
      .sort((left, right) => (left.side === right.side ? 0 : left.side === "HEAD" ? -1 : 1))[0];
    if (fallback) selected.add(fallback.regionId);
  }
  return [...selected].sort(compareUtf16);
}

/**
 * Produces one logical unit per changed path and attaches only direct supporting regions.
 * Provider-call batching remains a later orchestration concern; this artifact owns coverage only.
 */
export function planReviewUnitsV1(
  brief: ReviewBrief,
  contextMap: ReviewContextMapV1,
  options: ReviewUnitPlannerOptionsV1,
): ReviewUnitPlanV1 {
  if (
    !Number.isSafeInteger(options.maxSupportingBytesPerUnit) ||
    options.maxSupportingBytesPerUnit < 0
  ) {
    throw new TypeError("maxSupportingBytesPerUnit must be a non-negative safe integer");
  }
  if (options.policyVersion.length === 0) {
    throw new TypeError("policyVersion must not be empty");
  }
  if (!verifyReviewBriefIdentity(brief)) {
    throw new Error("Review brief identity is invalid");
  }
  if (!verifyReviewContextMapIdentityV1(contextMap)) {
    throw new Error("Review context map identity is invalid");
  }
  if (brief.snapshotManifest.snapshotDigest.value !== contextMap.snapshotDigest.value) {
    throw new Error("Review context map belongs to a different snapshot");
  }

  const regionById = new Map(contextMap.regions.map((region) => [region.regionId, region]));
  const transmittedSupportingPaths = new Set(brief.referencedSources.map((source) => source.path));
  const canonicalInputIds = canonicalInputList(brief.canonicalInputs)
    .map((input) => input.id)
    .sort(compareUtf16);
  const evidenceByPath = new Map<string, ReviewBrief["initialEvidence"]>();
  for (const evidence of brief.initialEvidence) {
    const entries = evidenceByPath.get(evidence.path) ?? [];
    entries.push(evidence);
    evidenceByPath.set(evidence.path, entries);
  }
  const units = [...evidenceByPath]
    .sort(([leftPath], [rightPath]) => compareUtf16(leftPath, rightPath))
    .map(([path, pathEvidence]) => {
      pathEvidence.sort((left, right) => compareUtf16(left.evidenceId, right.evidenceId));
      const changedRegionIds = new Set(
        contextMap.regions
          .filter((region) => region.origin === "CHANGED_PATH" && region.path === path)
          .map((region) => region.regionId),
      );
      const relatedSupportingRegions = contextMap.relations
        .filter((relation) => changedRegionIds.has(relation.sourceRegionId))
        .map((relation) => ({ relation, region: regionById.get(relation.targetRegionId) }))
        .filter(
          (
            candidate,
          ): candidate is {
            relation: ReviewContextMapV1["relations"][number];
            region: ReviewContextMapV1["regions"][number];
          } => candidate.region?.origin === "SUPPORTING_CONTEXT",
        )
        .sort((left, right) => {
          const pathOrder = compareUtf16(left.region.path, right.region.path);
          return (
            pathOrder ||
            compareUtf16(left.region.regionId, right.region.regionId) ||
            compareUtf16(left.relation.relationId, right.relation.relationId)
          );
        });

      let supportingBytes = 0;
      const supportingRegionIds: string[] = [];
      const relationIds: string[] = [];
      const limitations: string[] = [];
      const unavailableSupportingPaths = new Set<string>();
      for (const { relation, region } of relatedSupportingRegions) {
        if (!transmittedSupportingPaths.has(region.path)) {
          unavailableSupportingPaths.add(region.path);
          continue;
        }
        if (supportingRegionIds.includes(region.regionId)) continue;
        const regionBytes = region.range?.contentByteLength ?? region.byteLength;
        if (supportingBytes + regionBytes > options.maxSupportingBytesPerUnit) {
          limitations.push(
            `${region.path} requires ${regionBytes} bytes and exceeds the remaining ${options.maxSupportingBytesPerUnit - supportingBytes}-byte supporting-context budget.`,
          );
          continue;
        }
        supportingBytes += regionBytes;
        supportingRegionIds.push(region.regionId);
        relationIds.push(relation.relationId);
      }
      for (const supportingPath of [...unavailableSupportingPaths].sort(compareUtf16)) {
        limitations.push(
          `${supportingPath} was captured as related context but was not transmitted in the neutral review brief.`,
        );
      }

      const evidenceBytes = pathEvidence.reduce(
        (total, evidence) => total + Buffer.byteLength(evidence.content, "utf8"),
        0,
      );
      const primaryEvidenceIds = pathEvidence.map((evidence) => evidence.evidenceId);
      const manifestEntry = brief.snapshotManifest.paths.find((entry) => entry.path === path);
      const basePath =
        manifestEntry && "previousPath" in manifestEntry ? manifestEntry.previousPath : path;
      const primaryRegionIds = primaryRegionsForPath(path, basePath, pathEvidence, contextMap);
      if (primaryRegionIds.length === 0) {
        throw new Error(`Review context map has no captured region for changed path ${path}`);
      }
      return {
        unitId: stableIdentifier(
          "unit",
          `${brief.briefDigest.value}:${contextMap.contextMapDigest.value}:${path}:${options.policyVersion}`,
        ),
        targetPaths: [path],
        primaryEvidenceIds,
        primaryRegionIds,
        supportingRegionIds,
        relationIds,
        canonicalInputIds,
        estimatedInputBytes: evidenceBytes + supportingBytes,
        limitations,
      };
    });

  const planId = stableIdentifier(
    "plan",
    `${brief.briefDigest.value}:${contextMap.contextMapDigest.value}:${options.policyVersion}`,
  );
  return finalizeReviewUnitPlanV1({
    schemaVersion: 1,
    planId,
    snapshotDigest: brief.snapshotManifest.snapshotDigest,
    briefDigest: brief.briefDigest,
    contextMapDigest: contextMap.contextMapDigest,
    plannerPolicyVersion: options.policyVersion,
    units,
    exclusions: [],
  });
}
