import type { AuthorPacketV1, ReviewContextMapV1, ReviewUnitPlanV1 } from "../contracts/index.js";
import type { ReviewBrief } from "../contracts/neutral-review-brief.js";
import {
  type AuthorContextBindingV1,
  DECLINED_AUTHOR_CONTEXT_MARKER_V1,
  type ReviewAuthor,
} from "../contracts/standards-review.js";
import type { InspectedSnapshotPacket } from "../snapshot/snapshot-packet.js";
import { compactProjectGuidanceV1 } from "../transmission/project-guidance-digest.js";
export function focusedReviewContext(
  plan: ReviewUnitPlanV1,
  contextMap: ReviewContextMapV1,
): unknown {
  const regionIds = new Set(
    plan.units.flatMap((unit) => [...unit.primaryRegionIds, ...unit.supportingRegionIds]),
  );
  const relationIds = new Set(plan.units.flatMap((unit) => unit.relationIds));
  const relations = contextMap.relations.filter((relation) => relationIds.has(relation.relationId));
  const producerIds = new Set([
    ...contextMap.regions
      .filter((region) => regionIds.has(region.regionId))
      .map((region) => region.producerId),
    ...relations.map((relation) => relation.producerId),
    ...contextMap.producers
      .filter((producer) => producer.status !== "COMPLETE")
      .map((producer) => producer.producerId),
  ]);
  return {
    producers: contextMap.producers
      .filter((producer) => producerIds.has(producer.producerId))
      .map((producer) => ({
        producerId: producer.producerId,
        producerVersion: producer.producerVersion,
        status: producer.status,
        diagnostics: producer.diagnostics.slice(0, 8).map((diagnostic) => diagnostic.slice(0, 256)),
        diagnosticCount: producer.diagnostics.length,
      })),
    regions: contextMap.regions
      .filter((region) => regionIds.has(region.regionId))
      .map((region) => ({
        regionId: region.regionId,
        origin: region.origin,
        path: region.path,
        side: region.side,
        languageId: region.languageId,
        kind: region.kind,
        producerId: region.producerId,
        ...(region.range ? { range: region.range } : {}),
        ...(region.displayName ? { displayName: region.displayName } : {}),
      })),
    relations: relations.map((relation) => ({
      relationId: relation.relationId,
      sourceRegionId: relation.sourceRegionId,
      targetRegionId: relation.targetRegionId,
      kind: relation.kind,
      certainty: relation.certainty,
      producerId: relation.producerId,
    })),
  };
}

export function blindReviewEvidence(
  brief: ReviewBrief,
  plan: ReviewUnitPlanV1,
  contextMap: ReviewContextMapV1,
): unknown {
  const reviewPlanning = {
    reviewUnitPlan: {
      schemaVersion: plan.schemaVersion,
      units: plan.units.map((unit) => ({
        unitId: unit.unitId,
        targetPaths: unit.targetPaths,
        primaryEvidenceIds: unit.primaryEvidenceIds,
        primaryRegionIds: unit.primaryRegionIds,
        supportingRegionIds: unit.supportingRegionIds,
        limitations: unit.limitations,
      })),
    },
    reviewContext: focusedReviewContext(plan, contextMap),
  };
  if (brief.schemaVersion !== 1)
    return {
      ...brief,
      ...reviewPlanning,
      requiredCoverage: {
        changedPaths: brief.snapshotManifest.paths.map((entry) => entry.path),
        canonicalInputIds: brief.snapshotManifest.canonicalInputs.map((input) => input.id),
      },
    };
  const projectGuidanceDigest = compactProjectGuidanceV1(brief.canonicalInputs.projectGuidance);
  const truncatedGuidanceIds = projectGuidanceDigest
    .filter((entry) => entry.truncated)
    .map((entry) => entry.id);
  if (truncatedGuidanceIds.length > 0) {
    throw new Error(
      `Project guidance exceeds the compact transmission budget: ${truncatedGuidanceIds.join(", ")}.`,
    );
  }
  return {
    ...brief,
    ...reviewPlanning,
    requiredCoverage: {
      changedPaths: brief.snapshotManifest.paths.map((entry) => entry.path),
      canonicalInputIds: brief.snapshotManifest.canonicalInputs.map((entry) => entry.id),
    },
    canonicalInputs: {
      requirements: brief.canonicalInputs.requirements,
      implementationPlan: brief.canonicalInputs.implementationPlan,
    },
    projectGuidanceDigest,
  };
}

export interface ReleasedAuthorContextV1 {
  binding?: AuthorContextBindingV1;
  authorPacket?: ReviewAuthor;
  claimedVerification: AuthorPacketV1["claimedVerification"];
}

export function releasedAuthorContextV1(packet: InspectedSnapshotPacket): ReleasedAuthorContextV1 {
  if (packet.authorContext?.status === "DECLINED") {
    return { binding: packet.authorContext, claimedVerification: [] };
  }
  if (packet.authorPacket) {
    return {
      ...(packet.authorContext ? { binding: packet.authorContext } : {}),
      authorPacket: packet.authorPacket,
      claimedVerification: packet.authorPacket.claimedVerification,
    };
  }
  throw new Error("An author packet or explicit declined author context is required.");
}

export function authorReleaseMessageV1(
  brief: ReviewBrief,
  released: ReleasedAuthorContextV1,
): string {
  if (!released.binding) {
    return JSON.stringify({
      schemaVersion: 1,
      type: "AUTHOR_PACKET",
      snapshotDigest: brief.snapshotManifest.snapshotDigest,
      authorPacket: released.authorPacket,
    });
  }
  return JSON.stringify({
    schemaVersion: 1,
    type: "AUTHOR_CONTEXT_RELEASED",
    snapshotDigest: brief.snapshotManifest.snapshotDigest,
    authorContext: released.binding,
    ...(released.authorPacket
      ? { authorPacket: released.authorPacket }
      : { declinedMarker: DECLINED_AUTHOR_CONTEXT_MARKER_V1 }),
  });
}
