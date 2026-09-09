import {
  computeInitialEvidenceContentDigestV1,
  finalizeNeutralReviewBriefV1,
  type NeutralReviewBriefV1,
  type SnapshotContentV1,
} from "../contracts/index.js";
import { inspectSnapshotPacketV1, readSnapshotBlobV1 } from "../snapshot/snapshot-packet.js";

/**
 * How a captured side renders: either a standalone label, or a pointer to source bytes the caller
 * must read from the packet. The two outcomes are distinct types so neither can be confused for
 * the other by inspecting a string.
 */
type CapturedRenderingV1 =
  | { readonly kind: "LABEL"; readonly label: string }
  | { readonly kind: "SOURCE"; readonly content: SnapshotContentV1 };

function contentRendering(content: SnapshotContentV1 | null): CapturedRenderingV1 {
  if (content === null) {
    return { kind: "LABEL", label: "<absent>" };
  }
  switch (content.kind) {
    case "UNSUPPORTED":
      return { kind: "LABEL", label: `<unsupported ${content.gitMode}: ${content.reason}>` };
    case "BINARY":
    case "SUBMODULE":
      return {
        kind: "LABEL",
        label: `<${content.kind.toLowerCase()} sha256:${content.digest.value} ${content.byteLength} bytes>`,
      };
    case "TEXT":
    case "SYMLINK":
      return { kind: "SOURCE", content };
  }
}

async function capturedText(
  packetPath: string,
  content: SnapshotContentV1 | null,
): Promise<string> {
  const rendering = contentRendering(content);
  if (rendering.kind === "LABEL") {
    return rendering.label;
  }
  const source = Buffer.from(
    await readSnapshotBlobV1(packetPath, rendering.content.digest),
  ).toString("utf8");
  if (source.length === 0) {
    return "";
  }
  const lines = source.split(/\r\n|[\r\n]/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.map((line, index) => `${index + 1} | ${line}`).join("\n");
}

/**
 * Builds the complete small-change blind payload. It fails instead of silently
 * truncating evidence when the configured transmission budget is exceeded.
 */
export async function buildNeutralReviewBriefV1(
  packetPath: string,
  maxInitialEvidenceBytes: number,
): Promise<NeutralReviewBriefV1> {
  if (!Number.isSafeInteger(maxInitialEvidenceBytes) || maxInitialEvidenceBytes < 1) {
    throw new TypeError("maxInitialEvidenceBytes must be a positive safe integer.");
  }
  const packet = await inspectSnapshotPacketV1(packetPath);
  const canonicalInputIds = [
    ...packet.canonicalInputs.requirements.map((input) => input.id),
    packet.canonicalInputs.implementationPlan.id,
    ...packet.canonicalInputs.projectGuidance.map((input) => input.id),
  ];

  let transmittedBytes = 0;
  const initialEvidence = [];
  for (const [index, entry] of packet.manifest.paths.entries()) {
    const before = await capturedText(packetPath, entry.before);
    const after = await capturedText(packetPath, entry.after);
    const previous = "previousPath" in entry ? ` (from ${entry.previousPath})` : "";
    const content = [
      `Change: ${entry.changeType} ${entry.path}${previous}`,
      `--- BASE/${"previousPath" in entry ? entry.previousPath : entry.path}`,
      before,
      `+++ HEAD/${entry.path}`,
      after,
    ].join("\n");
    transmittedBytes += Buffer.byteLength(content, "utf8");
    if (transmittedBytes > maxInitialEvidenceBytes) {
      throw new Error(
        `Initial evidence requires ${transmittedBytes} bytes, exceeding the ${maxInitialEvidenceBytes}-byte evidence budget.`,
      );
    }
    initialEvidence.push({
      type: "DIFF_HUNK" as const,
      evidenceId: `evidence_change_${String(index + 1).padStart(4, "0")}`,
      path: entry.path,
      hunkId: `hunk_change_${String(index + 1).padStart(4, "0")}`,
      content,
      digest: computeInitialEvidenceContentDigestV1(content),
    });
  }

  const coverageConstraints = [
    ...packet.manifest.exclusions
      .filter((exclusion) => exclusion.reason !== "RUNNER_CONTROL")
      .map((exclusion) => ({
        type: "EXCLUDED_PATH" as const,
        detail: `${exclusion.reason}: ${exclusion.detail}`,
        paths: [exclusion.path],
      })),
    ...packet.manifest.omissions.map((omission) => ({
      type: "OMITTED_CONTENT" as const,
      detail: `${omission.scope}: ${omission.reason}: ${omission.detail}`,
      paths: [],
    })),
    ...packet.manifest.paths
      .filter(
        (entry) =>
          entry.before?.kind === "BINARY" ||
          entry.before?.kind === "SUBMODULE" ||
          entry.before?.kind === "UNSUPPORTED" ||
          entry.after?.kind === "BINARY" ||
          entry.after?.kind === "SUBMODULE" ||
          entry.after?.kind === "UNSUPPORTED",
      )
      .map((entry) => ({
        type: "UNSUPPORTED_CONTENT" as const,
        detail: "At least one side of this changed path has unsupported captured content.",
        paths: [entry.path],
      })),
  ];

  return finalizeNeutralReviewBriefV1({
    schemaVersion: 1,
    briefId: `brief_${packet.manifest.snapshotDigest.value.slice(0, 24)}`,
    objective: {
      text: "Independently assess the frozen change against its canonical requirements, implementation plan, and project guidance.",
      canonicalInputIds,
    },
    successCriteria: packet.canonicalInputs.requirements.map((requirement) => ({
      text: requirement.content,
      canonicalInputIds: [requirement.id],
    })),
    canonicalInputs: packet.canonicalInputs,
    snapshotManifest: packet.manifest,
    initialEvidence,
    coverageConstraints,
    // Reserved contract surface: there is no evidence service in v1, so these stay empty.
    capabilities: {
      evidenceOperations: [],
      verificationChecks: [],
    },
  });
}
