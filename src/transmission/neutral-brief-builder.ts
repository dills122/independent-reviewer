import { matchesGlob } from "node:path";
import { finalizeReviewBrief } from "../contracts/artifact-identity.js";
import {
  computeInitialEvidenceContentDigestV1,
  type NeutralReviewBriefV1,
  type SnapshotContentV1,
} from "../contracts/index.js";
import { NeutralReviewBriefV1Schema, type ReviewBrief } from "../contracts/neutral-review-brief.js";
import { canonicalInputList, selectedRules } from "../contracts/standards-review.js";
import { inspectSnapshotPacket, readSnapshotBlobV1 } from "../snapshot/snapshot-packet.js";
import { renderUnifiedDiff } from "./unified-diff.js";

/**
 * How a captured side renders: either a standalone label, or a pointer to source bytes the caller
 * must read from the packet. The two outcomes are distinct types so neither can be confused for
 * the other by inspecting a string.
 */
type CapturedRenderingV1 =
  | { readonly kind: "LABEL"; readonly label: string }
  | { readonly kind: "SOURCE"; readonly content: SnapshotContentV1 };

function contentRendering(content: SnapshotContentV1): CapturedRenderingV1 {
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

async function capturedSource(
  packetPath: string,
  content: SnapshotContentV1 | null,
): Promise<string> {
  if (content === null) {
    return "";
  }
  const rendering = contentRendering(content);
  if (rendering.kind === "LABEL") {
    return rendering.label;
  }
  return Buffer.from(await readSnapshotBlobV1(packetPath, rendering.content.digest)).toString(
    "utf8",
  );
}

async function capturedText(
  packetPath: string,
  content: SnapshotContentV1 | null,
): Promise<string> {
  const source = await capturedSource(packetPath, content);
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
export async function buildReviewBrief(
  packetPath: string,
  maxInitialEvidenceBytes: number,
): Promise<ReviewBrief> {
  if (!Number.isSafeInteger(maxInitialEvidenceBytes) || maxInitialEvidenceBytes < 1) {
    throw new TypeError("maxInitialEvidenceBytes must be a positive safe integer.");
  }
  const packet = await inspectSnapshotPacket(packetPath);
  const canonicalInputIds = canonicalInputList(packet.canonicalInputs).map((input) => input.id);
  const standardsRules =
    "standards" in packet.canonicalInputs ? selectedRules(packet.canonicalInputs) : undefined;
  const isOutsideSelectedStandards = (path: string): boolean =>
    standardsRules !== undefined &&
    !standardsRules.some((rule) => rule.paths.some((pattern) => matchesGlob(path, pattern)));

  let transmittedBytes = 0;
  const initialEvidence = [];
  const evidencePaths = packet.manifest.paths.filter(
    (entry) => !isOutsideSelectedStandards(entry.path),
  );
  for (const [index, entry] of evidencePaths.entries()) {
    const before = await capturedSource(packetPath, entry.before);
    const after = await capturedSource(packetPath, entry.after);
    const previous = "previousPath" in entry ? ` (from ${entry.previousPath})` : "";
    const diff = await renderUnifiedDiff(
      before,
      after,
      "previousPath" in entry ? entry.previousPath : entry.path,
      entry.path,
    );
    const content = [`Change: ${entry.changeType} ${entry.path}${previous}`, diff.content].join(
      "\n",
    );
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

  /**
   * Referenced context shares the evidence budget but never displaces the change under review:
   * a file that no longer fits is dropped and declared, so the reviewer knows a contract it needs
   * is absent and can leave the affected rule unassessed instead of guessing.
   */
  const referencedSources = [];
  const droppedReferencedPaths: string[] = [];
  for (const entry of packet.manifest.referencedSources) {
    const content = await capturedText(packetPath, entry.content);
    const rendered = Buffer.byteLength(content, "utf8");
    if (content.length === 0 || transmittedBytes + rendered > maxInitialEvidenceBytes) {
      droppedReferencedPaths.push(entry.path);
      continue;
    }
    transmittedBytes += rendered;
    referencedSources.push({
      path: entry.path,
      importedBy: [...entry.importedBy],
      content,
    });
  }

  const coverageConstraints = [
    ...(standardsRules
      ? packet.manifest.paths
          .filter((entry) => isOutsideSelectedStandards(entry.path))
          .map((entry) => ({
            type: "OUT_OF_SCOPE" as const,
            detail: "No selected standard applies to this changed path.",
            paths: [entry.path],
          }))
      : []),
    ...packet.manifest.exclusions
      .filter((exclusion) => exclusion.reason !== "RUNNER_CONTROL")
      .map((exclusion) => ({
        type:
          exclusion.reason === "PATH_POLICY" || exclusion.reason === "GENERATED_POLICY"
            ? ("OUT_OF_SCOPE" as const)
            : ("EXCLUDED_PATH" as const),
        detail: `${exclusion.reason}: ${exclusion.detail}`,
        paths: [exclusion.path],
      })),
    ...packet.manifest.omissions.map((omission) => ({
      type: "OMITTED_CONTENT" as const,
      detail: `${omission.scope}: ${omission.reason}: ${omission.detail}`,
      paths: [],
    })),
    ...(droppedReferencedPaths.length > 0
      ? [
          {
            type: "EVIDENCE_BUDGET" as const,
            detail:
              "Imported source was not transmitted, so contracts it defines are unavailable to this review.",
            paths: droppedReferencedPaths,
          },
        ]
      : []),
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

  return finalizeReviewBrief({
    ...("standards" in packet.canonicalInputs
      ? { schemaVersion: 2, mode: "STANDARDS" }
      : { schemaVersion: 1 }),
    briefId: `brief_${packet.manifest.snapshotDigest.value.slice(0, 24)}`,
    objective: {
      text:
        "standards" in packet.canonicalInputs
          ? "Assess the frozen code against the selected standards; reconcile author explanation only after the independent assessment."
          : "Independently assess the frozen change against its canonical requirements, implementation plan, and project guidance.",
      canonicalInputIds,
    },
    successCriteria: ("standards" in packet.canonicalInputs
      ? packet.canonicalInputs.standards
      : packet.canonicalInputs.requirements
    ).map((requirement) => ({
      text:
        "standards" in packet.canonicalInputs
          ? `Assess the selected standards in ${requirement.title}.`
          : requirement.content,
      canonicalInputIds: [requirement.id],
    })),
    canonicalInputs: packet.canonicalInputs,
    snapshotManifest: packet.manifest,
    initialEvidence,
    referencedSources,
    coverageConstraints,
  });
}

export async function buildNeutralReviewBriefV1(
  packetPath: string,
  maxInitialEvidenceBytes: number,
): Promise<NeutralReviewBriefV1> {
  return NeutralReviewBriefV1Schema.parse(
    await buildReviewBrief(packetPath, maxInitialEvidenceBytes),
  );
}
