import { matchesGlob } from "node:path";
import parseDiff from "parse-diff";
import { finalizeReviewBrief } from "../contracts/artifact-identity.js";
import {
  computeInitialEvidenceContentDigestV1,
  type NeutralReviewBriefV1,
  resolveSnapshotSourceContentV1,
  type SnapshotContentV1,
} from "../contracts/index.js";
import { NeutralReviewBriefV1Schema, type ReviewBrief } from "../contracts/neutral-review-brief.js";
import { compareUtf16 } from "../contracts/primitives.js";
import {
  canonicalInputList,
  selectedReferences,
  selectedRules,
} from "../contracts/standards-review.js";
import { renderGuidancePromptPresentationV1 } from "../guidance/presentation.js";
import { inspectSnapshotPacket, readSnapshotBlobV1 } from "../snapshot/snapshot-packet.js";
import { renderUnifiedDiff } from "./unified-diff.js";

const CHANGED_SOURCE_CONTEXT_RADIUS_V1 = 12;

type SourceContextRangeV1 = { readonly startLine: number; readonly endLine: number };

function logicalLines(source: string): string[] {
  if (source.length === 0) return [];
  const lines = source.split(/\r\n|[\r\n]/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function changedLinesBySide(diff: string): { BASE: number[]; HEAD: number[] } {
  const changed = { BASE: new Set<number>(), HEAD: new Set<number>() };
  for (const file of parseDiff(diff)) {
    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        if (change.type === "del") changed.BASE.add(change.ln);
        if (change.type === "add") changed.HEAD.add(change.ln);
      }
    }
  }
  return {
    BASE: [...changed.BASE].sort((left, right) => left - right),
    HEAD: [...changed.HEAD].sort((left, right) => left - right),
  };
}

function boundedContextRanges(
  changedLines: readonly number[],
  lineCount: number,
): SourceContextRangeV1[] {
  const ranges: SourceContextRangeV1[] = [];
  for (const line of changedLines) {
    const candidate = {
      startLine: Math.max(1, line - CHANGED_SOURCE_CONTEXT_RADIUS_V1),
      endLine: Math.min(lineCount, line + CHANGED_SOURCE_CONTEXT_RADIUS_V1),
    };
    const previous = ranges.at(-1);
    if (previous && candidate.startLine <= previous.endLine + 1) {
      ranges[ranges.length - 1] = {
        startLine: previous.startLine,
        endLine: Math.max(previous.endLine, candidate.endLine),
      };
    } else {
      ranges.push(candidate);
    }
  }
  return ranges;
}

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
  if (packet.guidanceGraph && !("standards" in packet.canonicalInputs)) {
    throw new Error("Guidance-capable briefs require standards review mode.");
  }
  const guidancePresentation = packet.guidanceGraph
    ? await renderGuidancePromptPresentationV1(packetPath, packet.guidanceGraph)
    : undefined;
  const canonicalInputIds = canonicalInputList(packet.canonicalInputs).map((input) => input.id);
  const standardsRules =
    "standards" in packet.canonicalInputs ? selectedRules(packet.canonicalInputs) : undefined;
  const standardsReferences =
    "standards" in packet.canonicalInputs ? selectedReferences(packet.canonicalInputs) : [];
  const declaredReferencePaths = new Set(standardsReferences.map(({ path }) => path));
  const isOutsideSelectedStandards = (path: string): boolean =>
    standardsRules !== undefined &&
    !declaredReferencePaths.has(path) &&
    !standardsRules.some((rule) => rule.paths.some((pattern) => matchesGlob(path, pattern)));

  let transmittedBytes = 0;
  const initialEvidence: ReviewBrief["initialEvidence"] = [];
  const droppedChangedContextPaths = new Set<string>();
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
    if (diff.form === "UNIFIED_HUNKS") {
      const changedLines = changedLinesBySide(diff.content);
      const sides = [
        {
          side: "BASE" as const,
          path: "previousPath" in entry ? entry.previousPath : entry.path,
          source: before,
          changedLines: changedLines.BASE,
        },
        { side: "HEAD" as const, path: entry.path, source: after, changedLines: changedLines.HEAD },
      ];
      for (const side of sides) {
        const lines = logicalLines(side.source);
        for (const [rangeIndex, range] of boundedContextRanges(
          side.changedLines,
          lines.length,
        ).entries()) {
          const context = lines.slice(range.startLine - 1, range.endLine).join("\n");
          const rendered = Buffer.byteLength(context, "utf8");
          if (context.length === 0 || transmittedBytes + rendered > maxInitialEvidenceBytes) {
            droppedChangedContextPaths.add(entry.path);
            continue;
          }
          transmittedBytes += rendered;
          initialEvidence.push({
            type: "SOURCE_CONTEXT",
            evidenceId: `evidence_context_${String(index + 1).padStart(4, "0")}_${side.side.toLowerCase()}_${String(rangeIndex + 1).padStart(4, "0")}`,
            path: side.path,
            side: side.side,
            startLine: range.startLine,
            endLine: range.endLine,
            content: context,
            digest: computeInitialEvidenceContentDigestV1(context),
          });
        }
      }
    }
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
      standardReferenceIds: [...(entry.standardReferenceIds ?? [])],
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
    ...(droppedChangedContextPaths.size > 0
      ? [
          {
            type: "EVIDENCE_BUDGET" as const,
            detail:
              "Bounded changed-file context was not transmitted, so nearby behavior outside the unified hunk is unavailable to this review.",
            paths: [...droppedChangedContextPaths].sort(compareUtf16),
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

  const referenceEvidence = standardsReferences.map((reference) => {
    const target = packet.manifest.paths.find(({ path }) => path === reference.path);
    const applicableBindings = reference.bindings.filter((binding) =>
      packet.manifest.paths.some((entry) =>
        binding.paths.some((pattern) => matchesGlob(entry.path, pattern)),
      ),
    );
    const required = applicableBindings.some((binding) => binding.required);
    const capturedAsContext = packet.manifest.referencedSources.some(
      ({ path }) => path === reference.path,
    );
    const capturedAtBase = target
      ? resolveSnapshotSourceContentV1(packet.manifest.paths, reference.path, "BASE") !== undefined
      : capturedAsContext;
    const omitted = packet.manifest.omissions.some(({ scope }) => scope === reference.path);
    return {
      referenceId: reference.id,
      path: reference.path,
      roles: [...(target ? (["REVIEW_TARGET"] as const) : []), "SUPPORTING_REFERENCE" as const],
      captureStatus:
        target || applicableBindings.length > 0
          ? capturedAtBase
            ? ("CAPTURED" as const)
            : omitted
              ? ("OMITTED" as const)
              : ("UNAVAILABLE" as const)
          : ("OUT_OF_SCOPE" as const),
      authoritySide: "BASE" as const,
      required,
      boundRuleIds: reference.bindings.map(({ ruleId }) => ruleId),
    };
  });

  return finalizeReviewBrief({
    ...("standards" in packet.canonicalInputs
      ? packet.guidanceGraph && packet.guidanceGraphDigest && guidancePresentation
        ? {
            schemaVersion: 3,
            mode: "STANDARDS",
            referenceEvidence,
            guidanceGraph: {
              graphId: packet.guidanceGraph.graphId,
              guidanceGraphDigest: packet.guidanceGraphDigest,
            },
            guidancePresentation,
          }
        : { schemaVersion: 2, mode: "STANDARDS", referenceEvidence }
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
