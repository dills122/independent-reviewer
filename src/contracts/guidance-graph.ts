import * as z from "zod";

import { canonicalizeJson, cloneCanonicalJson, digestCanonicalJson } from "./canonical-json.js";
import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import { compareUtf16, prefixedIdentifier } from "./primitives.js";
import {
  type DigestV1,
  DigestV1Schema,
  GitObjectIdSchema,
  type SnapshotManifestV1,
  SnapshotPathV1Schema,
} from "./snapshot-manifest.js";

export const GuidanceFamilyV1Schema = z.enum([
  "CODEX",
  "CLAUDE",
  "GEMINI",
  "KIRO",
  "COPILOT",
  "CURSOR",
  "INDEPENDENT_REVIEWER",
]);

export const GuidanceSourceKindV1Schema = z.enum([
  "CODEX_AGENTS",
  "CODEX_AGENTS_OVERRIDE",
  "CLAUDE_MD",
  "CLAUDE_DOT_CLAUDE_MD",
  "CLAUDE_RULE",
  "GEMINI_CONTEXT",
  "KIRO_AGENTS",
  "KIRO_STEERING",
  "COPILOT_REPOSITORY",
  "COPILOT_MODULAR",
  "COPILOT_AGENTS",
  "COPILOT_CLAUDE",
  "COPILOT_DOT_CLAUDE",
  "COPILOT_GEMINI",
  "CURSOR_RULE",
  "REVIEWER_RULES",
]);

export const DirectRecognitionV1Schema = z.strictObject({
  familyId: GuidanceFamilyV1Schema,
  sourceKind: GuidanceSourceKindV1Schema,
  nativeOrder: z.int().nonnegative(),
  applicableTargetId: prefixedIdentifier("guidance_target"),
  discoveredPath: SnapshotPathV1Schema,
});

export const GuidanceTargetV1Schema = z.strictObject({
  targetId: prefixedIdentifier("guidance_target"),
  manifestPath: SnapshotPathV1Schema,
  applicabilityPath: SnapshotPathV1Schema,
  side: z.enum(["BASE", "HEAD"]),
  role: z.enum(["PRIMARY", "RELOCATION_SOURCE"]),
  changeType: z.enum([
    "ADDED",
    "COPIED",
    "DELETED",
    "MODIFIED",
    "RENAMED",
    "TYPE_CHANGED",
    "UNTRACKED",
  ]),
});

export const GuidanceSourceNodeV1Schema = z.strictObject({
  sourceId: prefixedIdentifier("guidance_source"),
  resolvedPath: SnapshotPathV1Schema,
  contentDigest: DigestV1Schema,
  semanticTier: z.enum(["REPOSITORY_PEER", "REVIEWER_SPECIFIC"]),
  applicableTargetIds: z.array(prefixedIdentifier("guidance_target")),
  directRecognitions: z.array(DirectRecognitionV1Schema),
});

export const GuidanceOccurrenceV1Schema = z.strictObject({
  occurrenceId: prefixedIdentifier("guidance_occurrence"),
  familyId: GuidanceFamilyV1Schema,
  syntaxKind: z.enum([
    "CLAUDE_AT_PATH",
    "GEMINI_AT_PATH",
    "KIRO_FILE_REFERENCE",
    "COPILOT_AT_PATH",
    "CURSOR_AT_FILENAME",
  ]),
  importerSourceId: prefixedIdentifier("guidance_source"),
  requestedSpecifier: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => !/[\r\n\0]/.test(value)),
  startUtf16: z.int().nonnegative(),
  endUtf16: z.int().positive(),
});

export const GuidanceEdgeV1Schema = z.strictObject({
  edgeId: prefixedIdentifier("guidance_edge"),
  occurrenceId: prefixedIdentifier("guidance_occurrence"),
  importedSourceId: prefixedIdentifier("guidance_source"),
  applicableTargetId: prefixedIdentifier("guidance_target"),
});

export const GuidanceDiagnosticV1Schema = z.strictObject({
  diagnosticId: prefixedIdentifier("guidance_diagnostic"),
  code: z.enum([
    "UNSELECTED_MANUAL_MODE",
    "UNSELECTED_MODEL_SELECTED_MODE",
    "EMPTY_SOURCE",
    "UNKNOWN_SETTING_IGNORED",
    "MARKDOWN_SYNTAX_WARNING",
    "MARKDOWN_STYLE_WARNING",
    "DIAGNOSTIC_LIMIT_EXCEEDED",
  ]),
  severity: z.enum(["EXCLUSION", "WARNING"]),
  path: SnapshotPathV1Schema.nullable(),
  startUtf16: z.int().nonnegative().nullable(),
  omittedCount: z.int().positive().nullable(),
});

const GuidanceGraphBaseV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  graphId: prefixedIdentifier("guidance"),
  snapshotDigest: DigestV1Schema,
  baseCommit: GitObjectIdSchema,
  targets: z.array(GuidanceTargetV1Schema),
  nodes: z.array(GuidanceSourceNodeV1Schema),
  occurrences: z.array(GuidanceOccurrenceV1Schema),
  edges: z.array(GuidanceEdgeV1Schema),
  diagnostics: z.array(GuidanceDiagnosticV1Schema),
});

function identifier(prefix: string, value: unknown): string {
  return `${prefix}_${digestCanonicalJson(value).value}`;
}

function expectedTargetId(
  snapshotDigest: DigestV1,
  target: Omit<z.infer<typeof GuidanceTargetV1Schema>, "targetId">,
): string {
  return identifier("guidance_target", { schemaVersion: 1, snapshotDigest, ...target });
}

function sourceIdentityInput(
  baseCommit: string,
  source: Pick<z.infer<typeof GuidanceSourceNodeV1Schema>, "resolvedPath" | "contentDigest">,
): unknown {
  return {
    schemaVersion: 1,
    baseCommit,
    resolvedPath: source.resolvedPath,
    contentDigest: source.contentDigest,
  };
}

function withoutId<T extends Record<string, unknown>, K extends keyof T>(
  value: T,
  id: K,
): Omit<T, K> {
  const clone = { ...value };
  delete clone[id];
  return clone;
}

function compareFields(left: readonly (string | number)[], right: readonly (string | number)[]) {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (typeof a === "number" && typeof b === "number" && a !== b) return a - b;
    if (typeof a === "string" && typeof b === "string") {
      const compared = compareUtf16(a, b);
      if (compared !== 0) return compared;
    }
  }
  return left.length - right.length;
}

function targetOrder(
  left: z.infer<typeof GuidanceTargetV1Schema>,
  right: z.infer<typeof GuidanceTargetV1Schema>,
): number {
  return compareFields(
    [
      left.applicabilityPath,
      left.side,
      left.role,
      left.manifestPath,
      left.changeType,
      left.targetId,
    ],
    [
      right.applicabilityPath,
      right.side,
      right.role,
      right.manifestPath,
      right.changeType,
      right.targetId,
    ],
  );
}

function recognitionOrder(
  left: z.infer<typeof DirectRecognitionV1Schema>,
  right: z.infer<typeof DirectRecognitionV1Schema>,
): number {
  return compareFields(
    [
      left.familyId,
      left.nativeOrder,
      left.applicableTargetId,
      left.discoveredPath,
      left.sourceKind,
    ],
    [
      right.familyId,
      right.nativeOrder,
      right.applicableTargetId,
      right.discoveredPath,
      right.sourceKind,
    ],
  );
}

function diagnosticOrder(
  left: z.infer<typeof GuidanceDiagnosticV1Schema>,
  right: z.infer<typeof GuidanceDiagnosticV1Schema>,
): number {
  return compareFields(
    [left.code, left.path ?? "", left.startUtf16 ?? -1, left.diagnosticId],
    [right.code, right.path ?? "", right.startUtf16 ?? -1, right.diagnosticId],
  );
}

function alreadyCanonical<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
): boolean {
  return values.every((value, index) => index === 0 || compare(values[index - 1] as T, value) < 0);
}

const FAMILY_SOURCE_KINDS: Readonly<
  Record<z.infer<typeof GuidanceFamilyV1Schema>, readonly string[]>
> = {
  CODEX: ["CODEX_AGENTS", "CODEX_AGENTS_OVERRIDE"],
  CLAUDE: ["CLAUDE_MD", "CLAUDE_DOT_CLAUDE_MD", "CLAUDE_RULE"],
  GEMINI: ["GEMINI_CONTEXT"],
  KIRO: ["KIRO_AGENTS", "KIRO_STEERING"],
  COPILOT: [
    "COPILOT_REPOSITORY",
    "COPILOT_MODULAR",
    "COPILOT_AGENTS",
    "COPILOT_CLAUDE",
    "COPILOT_DOT_CLAUDE",
    "COPILOT_GEMINI",
  ],
  CURSOR: ["CURSOR_RULE"],
  INDEPENDENT_REVIEWER: ["REVIEWER_RULES"],
};

function validateGraph(graph: z.infer<typeof GuidanceGraphBaseV1Schema>, context: z.RefinementCtx) {
  if (!alreadyCanonical(graph.targets, targetOrder))
    context.addIssue({
      code: "custom",
      path: ["targets"],
      message: "must be canonical and unique",
    });
  if (!alreadyCanonical(graph.nodes, (left, right) => compareUtf16(left.sourceId, right.sourceId)))
    context.addIssue({ code: "custom", path: ["nodes"], message: "must be canonical and unique" });
  if (
    !alreadyCanonical(graph.occurrences, (left, right) =>
      compareUtf16(left.occurrenceId, right.occurrenceId),
    )
  )
    context.addIssue({
      code: "custom",
      path: ["occurrences"],
      message: "must be canonical and unique",
    });
  if (!alreadyCanonical(graph.edges, (left, right) => compareUtf16(left.edgeId, right.edgeId)))
    context.addIssue({ code: "custom", path: ["edges"], message: "must be canonical and unique" });
  if (!alreadyCanonical(graph.diagnostics, diagnosticOrder))
    context.addIssue({
      code: "custom",
      path: ["diagnostics"],
      message: "must be canonical and unique",
    });

  const targetIds = new Set(graph.targets.map(({ targetId }) => targetId));
  graph.targets.forEach((target, index) => {
    const { targetId, ...input } = target;
    if (targetId !== expectedTargetId(graph.snapshotDigest, input))
      context.addIssue({
        code: "custom",
        path: ["targets", index, "targetId"],
        message: "must match target identity",
      });
  });
  const nodeIds = new Set(graph.nodes.map(({ sourceId }) => sourceId));
  const occurrenceIds = new Set(graph.occurrences.map(({ occurrenceId }) => occurrenceId));
  const sourceIdentityByPath = new Map<string, string>();
  const recognitionSlots = new Map<string, string>();

  graph.nodes.forEach((node, index) => {
    if (
      node.sourceId !== identifier("guidance_source", sourceIdentityInput(graph.baseCommit, node))
    )
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "sourceId"],
        message: "must match source identity",
      });
    const sourceIdentity = canonicalizeJson(node.contentDigest);
    const priorSourceIdentity = sourceIdentityByPath.get(node.resolvedPath);
    if (priorSourceIdentity !== undefined && priorSourceIdentity !== sourceIdentity)
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "resolvedPath"],
        message: "one BASE path must have one content identity",
      });
    sourceIdentityByPath.set(node.resolvedPath, sourceIdentity);
    if (!alreadyCanonical(node.directRecognitions, recognitionOrder))
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "directRecognitions"],
        message: "must be canonical and unique",
      });
    node.directRecognitions.forEach((recognition, recognitionIndex) => {
      if (!FAMILY_SOURCE_KINDS[recognition.familyId].includes(recognition.sourceKind))
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "directRecognitions", recognitionIndex, "sourceKind"],
          message: "must match familyId",
        });
      if (!targetIds.has(recognition.applicableTargetId))
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "directRecognitions", recognitionIndex, "applicableTargetId"],
          message: "must identify a graph target",
        });
      const slot = canonicalizeJson({
        familyId: recognition.familyId,
        applicableTargetId: recognition.applicableTargetId,
        discoveredPath: recognition.discoveredPath,
      });
      const owner = canonicalizeJson({
        sourceId: node.sourceId,
        sourceKind: recognition.sourceKind,
        nativeOrder: recognition.nativeOrder,
      });
      const priorOwner = recognitionSlots.get(slot);
      if (priorOwner !== undefined && priorOwner !== owner)
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "directRecognitions", recognitionIndex],
          message: "recognition slot has multiple owners",
        });
      recognitionSlots.set(slot, owner);
    });
    const derivedTier = node.directRecognitions.some(
      ({ sourceKind }) => sourceKind === "REVIEWER_RULES",
    )
      ? "REVIEWER_SPECIFIC"
      : "REPOSITORY_PEER";
    if (node.semanticTier !== derivedTier)
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "semanticTier"],
        message: "must equal derived semantic tier",
      });
    const applicable = [
      ...node.directRecognitions.map(({ applicableTargetId }) => applicableTargetId),
      ...graph.edges
        .filter(({ importedSourceId }) => importedSourceId === node.sourceId)
        .map(({ applicableTargetId }) => applicableTargetId),
    ].sort(compareUtf16);
    const uniqueApplicable = [...new Set(applicable)];
    if (canonicalizeJson(node.applicableTargetIds) !== canonicalizeJson(uniqueApplicable))
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "applicableTargetIds"],
        message: "must equal derived applicability",
      });
  });

  const syntaxFamily = {
    CLAUDE_AT_PATH: "CLAUDE",
    GEMINI_AT_PATH: "GEMINI",
    KIRO_FILE_REFERENCE: "KIRO",
    COPILOT_AT_PATH: "COPILOT",
    CURSOR_AT_FILENAME: "CURSOR",
  } as const;
  graph.occurrences.forEach((occurrence, index) => {
    if (occurrence.endUtf16 <= occurrence.startUtf16)
      context.addIssue({
        code: "custom",
        path: ["occurrences", index, "endUtf16"],
        message: "must end after startUtf16",
      });
    if (!nodeIds.has(occurrence.importerSourceId))
      context.addIssue({
        code: "custom",
        path: ["occurrences", index, "importerSourceId"],
        message: "must identify a source",
      });
    if (syntaxFamily[occurrence.syntaxKind] !== occurrence.familyId)
      context.addIssue({
        code: "custom",
        path: ["occurrences", index, "familyId"],
        message: "must match syntaxKind",
      });
    if (
      occurrence.occurrenceId !==
      identifier("guidance_occurrence", {
        schemaVersion: 1,
        ...withoutId(occurrence, "occurrenceId"),
      })
    )
      context.addIssue({
        code: "custom",
        path: ["occurrences", index, "occurrenceId"],
        message: "must match occurrence identity",
      });
  });
  graph.edges.forEach((edge, index) => {
    if (
      !occurrenceIds.has(edge.occurrenceId) ||
      !nodeIds.has(edge.importedSourceId) ||
      !targetIds.has(edge.applicableTargetId)
    )
      context.addIssue({
        code: "custom",
        path: ["edges", index],
        message: "must reference graph members",
      });
    if (
      edge.edgeId !==
      identifier("guidance_edge", { schemaVersion: 1, ...withoutId(edge, "edgeId") })
    )
      context.addIssue({
        code: "custom",
        path: ["edges", index, "edgeId"],
        message: "must match edge identity",
      });
  });
  graph.diagnostics.forEach((diagnostic, index) => {
    const excluded =
      diagnostic.code === "UNSELECTED_MANUAL_MODE" ||
      diagnostic.code === "UNSELECTED_MODEL_SELECTED_MODE";
    if (diagnostic.severity !== (excluded ? "EXCLUSION" : "WARNING"))
      context.addIssue({
        code: "custom",
        path: ["diagnostics", index, "severity"],
        message: "must match diagnostic code",
      });
    if (
      (diagnostic.startUtf16 !== null && diagnostic.path === null) ||
      (diagnostic.code === "DIAGNOSTIC_LIMIT_EXCEEDED") !== (diagnostic.omittedCount !== null)
    )
      context.addIssue({
        code: "custom",
        path: ["diagnostics", index],
        message: "contains inconsistent nullable fields",
      });
    if (
      diagnostic.diagnosticId !==
      identifier("guidance_diagnostic", {
        schemaVersion: 1,
        ...withoutId(diagnostic, "diagnosticId"),
      })
    )
      context.addIssue({
        code: "custom",
        path: ["diagnostics", index, "diagnosticId"],
        message: "must match diagnostic identity",
      });
  });

  const { graphId: _graphId, ...input } = graph;
  if (graph.graphId !== identifier("guidance", input))
    context.addIssue({
      code: "custom",
      path: ["graphId"],
      message: "must match complete graph identity",
    });
}

export const GuidanceGraphV1Schema = GuidanceGraphBaseV1Schema.superRefine(validateGraph);
export type GuidanceGraphV1 = z.infer<typeof GuidanceGraphV1Schema>;
export type GuidanceTargetV1 = z.infer<typeof GuidanceTargetV1Schema>;
export type GuidanceDiagnosticV1 = z.infer<typeof GuidanceDiagnosticV1Schema>;
export type DirectGuidanceRecognitionV1 = z.infer<typeof DirectRecognitionV1Schema>;

export interface DirectGuidanceSourceInputV1 {
  resolvedPath: string;
  contentDigest: DigestV1;
  directRecognitions: DirectGuidanceRecognitionV1[];
}

/** Creates one content-free, digest-identified guidance diagnostic. */
export function createGuidanceDiagnosticV1(
  value: Omit<GuidanceDiagnosticV1, "diagnosticId">,
): GuidanceDiagnosticV1 {
  return GuidanceDiagnosticV1Schema.parse({
    ...value,
    diagnosticId: identifier("guidance_diagnostic", { schemaVersion: 1, ...value }),
  });
}

/** Projects manifest entries into exact paths/sides used for guidance applicability. */
export function projectGuidanceTargetsV1(manifest: SnapshotManifestV1): GuidanceTargetV1[] {
  const targets = manifest.paths.flatMap((entry) => {
    const primary = {
      manifestPath: entry.path,
      applicabilityPath: entry.path,
      side: entry.changeType === "DELETED" ? ("BASE" as const) : ("HEAD" as const),
      role: "PRIMARY" as const,
      changeType: entry.changeType,
    };
    return entry.changeType === "RENAMED"
      ? [
          primary,
          {
            manifestPath: entry.path,
            applicabilityPath: entry.previousPath,
            side: "BASE" as const,
            role: "RELOCATION_SOURCE" as const,
            changeType: entry.changeType,
          },
        ]
      : [primary];
  });
  return targets
    .map((target) => ({ ...target, targetId: expectedTargetId(manifest.snapshotDigest, target) }))
    .sort(targetOrder);
}

/** Finalizes a fully populated graph and binds its exact canonical content to graphId. */
export function finalizeGuidanceGraphV1(value: Omit<GuidanceGraphV1, "graphId">): GuidanceGraphV1 {
  const cloned = cloneCanonicalJson(value);
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned))
    throw new TypeError("guidance graph draft must be an object");
  if (Object.hasOwn(cloned, "graphId"))
    throw new TypeError("guidance graph draft must not contain graphId");
  return GuidanceGraphV1Schema.parse({
    ...cloned,
    graphId: identifier("guidance", cloned),
  });
}

/** Merges direct adapter output into canonical source nodes without adapter-order authority. */
export function buildDirectGuidanceGraphV1(
  manifest: SnapshotManifestV1,
  inputSources: readonly DirectGuidanceSourceInputV1[],
  diagnostics: GuidanceDiagnosticV1[] = [],
): GuidanceGraphV1 {
  const targets = projectGuidanceTargetsV1(manifest);
  const targetIds = new Set(targets.map(({ targetId }) => targetId));
  const sourcesByIdentity = new Map<
    string,
    Omit<
      z.infer<typeof GuidanceSourceNodeV1Schema>,
      "sourceId" | "semanticTier" | "applicableTargetIds"
    >
  >();
  const identityByResolvedPath = new Map<string, string>();
  const recognitionSlots = new Map<string, string>();

  for (const input of inputSources) {
    const parsedPath = SnapshotPathV1Schema.parse(input.resolvedPath);
    const contentDigest = DigestV1Schema.parse(input.contentDigest);
    if (input.directRecognitions.length === 0)
      throw new Error("Direct guidance source must contain at least one recognition.");
    const sourceIdentity = canonicalizeJson({ parsedPath, contentDigest });
    const priorIdentity = identityByResolvedPath.get(parsedPath);
    if (priorIdentity !== undefined && priorIdentity !== sourceIdentity)
      throw new Error(`Guidance source ${parsedPath} has conflicting BASE content identity.`);
    identityByResolvedPath.set(parsedPath, sourceIdentity);
    const existing = sourcesByIdentity.get(sourceIdentity) ?? {
      resolvedPath: parsedPath,
      contentDigest,
      directRecognitions: [],
    };
    const recognitions = new Map(
      existing.directRecognitions.map((recognition) => [
        canonicalizeJson(recognition),
        recognition,
      ]),
    );
    for (const candidate of input.directRecognitions) {
      const recognition = DirectRecognitionV1Schema.parse(candidate);
      if (!targetIds.has(recognition.applicableTargetId))
        throw new Error(
          `Guidance recognition identifies unknown target ${recognition.applicableTargetId}.`,
        );
      const slot = canonicalizeJson({
        familyId: recognition.familyId,
        applicableTargetId: recognition.applicableTargetId,
        discoveredPath: recognition.discoveredPath,
      });
      const owner = canonicalizeJson({
        sourceIdentity,
        sourceKind: recognition.sourceKind,
        nativeOrder: recognition.nativeOrder,
      });
      const priorOwner = recognitionSlots.get(slot);
      if (priorOwner !== undefined && priorOwner !== owner)
        throw new Error("GUIDANCE_RECOGNITION_CONFLICT: one recognition slot has multiple owners.");
      recognitionSlots.set(slot, owner);
      recognitions.set(canonicalizeJson(recognition), recognition);
    }
    existing.directRecognitions = [...recognitions.values()].sort(recognitionOrder);
    sourcesByIdentity.set(sourceIdentity, existing);
  }

  const nodes = [...sourcesByIdentity.values()]
    .map((source) => {
      const applicableTargetIds = [
        ...new Set(source.directRecognitions.map(({ applicableTargetId }) => applicableTargetId)),
      ].sort(compareUtf16);
      const semanticTier = source.directRecognitions.some(
        ({ sourceKind }) => sourceKind === "REVIEWER_RULES",
      )
        ? ("REVIEWER_SPECIFIC" as const)
        : ("REPOSITORY_PEER" as const);
      return {
        sourceId: identifier(
          "guidance_source",
          sourceIdentityInput(manifest.source.baseCommit, source),
        ),
        ...source,
        semanticTier,
        applicableTargetIds,
      };
    })
    .sort((left, right) => compareUtf16(left.sourceId, right.sourceId));

  return finalizeGuidanceGraphV1({
    schemaVersion: 1,
    snapshotDigest: manifest.snapshotDigest,
    baseCommit: manifest.source.baseCommit,
    targets,
    nodes,
    occurrences: [],
    edges: [],
    diagnostics: [...diagnostics].sort(diagnosticOrder),
  });
}

/** Builds the no-import graph for the explicit BASE reviewer-rules source. */
export function buildReviewerRulesGuidanceGraphV1(
  manifest: SnapshotManifestV1,
  contentDigest?: DigestV1,
  diagnostics: GuidanceDiagnosticV1[] = [],
): GuidanceGraphV1 {
  const targets = projectGuidanceTargetsV1(manifest);
  return buildDirectGuidanceGraphV1(
    manifest,
    contentDigest
      ? [
          {
            resolvedPath: ".independent-reviewer/rules.md",
            contentDigest,
            directRecognitions: targets.map((target) => ({
              familyId: "INDEPENDENT_REVIEWER",
              sourceKind: "REVIEWER_RULES",
              nativeOrder: 0,
              applicableTargetId: target.targetId,
              discoveredPath: ".independent-reviewer/rules.md",
            })),
          },
        ]
      : [],
    diagnostics,
  );
}

export function guidanceGraphDigestV1(graph: GuidanceGraphV1): DigestV1 {
  return { algorithm: "SHA256", value: graph.graphId.slice("guidance_".length) };
}

export function verifyGuidanceGraphIdentityV1(value: unknown): value is GuidanceGraphV1 {
  try {
    return GuidanceGraphV1Schema.safeParse(cloneCanonicalJson(value)).success;
  } catch {
    return false;
  }
}

/** Cross-checks graph identity and exact target projection against one verified packet manifest. */
export function assertGuidanceGraphMatchesSnapshotV1(
  value: unknown,
  manifest: SnapshotManifestV1,
): asserts value is GuidanceGraphV1 {
  const graph = GuidanceGraphV1Schema.parse(value);
  if (
    graph.snapshotDigest.value !== manifest.snapshotDigest.value ||
    graph.baseCommit !== manifest.source.baseCommit
  ) {
    throw new Error("Guidance graph belongs to a different snapshot.");
  }
  if (canonicalizeJson(graph.targets) !== canonicalizeJson(projectGuidanceTargetsV1(manifest))) {
    throw new Error("Guidance graph target projection does not match the snapshot.");
  }
}

export const GUIDANCE_GRAPH_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:guidance-graph:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(GuidanceGraphV1Schema, { target: "draft-2020-12", io: "output" }),
};
