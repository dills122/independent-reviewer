import type { AuthorPacketV1, PreliminaryAssessmentV1 } from "../contracts/index.js";

/**
 * The subset of JSON Schema this module traverses. The input is `z.toJSONSchema` output, so the
 * shape is produced by a pinned dependency: every access is validated rather than cast, and a
 * shape change fails loudly at a named path instead of silently constraining nothing.
 */
export interface JsonSchemaNodeV1 {
  type?: unknown;
  const?: unknown;
  enum?: unknown;
  properties?: unknown;
  items?: unknown;
  minItems?: unknown;
  maxItems?: unknown;
  maxLength?: unknown;
  [key: string]: unknown;
}

/** Ceiling on any prose string the schema does not already pin with `const` or `enum`. */
const DEFAULT_PROSE_MAX_LENGTH_V1 = 400;

/**
 * Named ceiling for every unbounded array in the response schemas, keyed by property name.
 *
 * A blanket cap previously applied 12 to every array, which structurally forbade a reviewer from
 * reporting more than 12 findings, blockers, or pieces of evidence per finding. Every array now
 * carries a deliberate limit, and an array with no entry here is an error rather than a silent
 * default, so a new array in a future schema must be given one.
 */
const RESPONSE_ARRAY_LIMITS_V1: Readonly<Record<string, number>> = {
  authorClaims: 24,
  sourceFindingIds: 40,
  ruleIds: 12,
  conflictingRuleIds: 12,
  withdrawnPreliminaryFindings: 40,
  blockers: 12,
  evidence: 8,
  evidenceGaps: 24,
  fastFollows: 12,
  findings: 40,
  inspectedPaths: 200,
  limitations: 12,
  preliminaryConcernDispositions: 36,
  preliminaryFindingDispositions: 40,
};

/** Evidence anchors whose `path` must be pinned to the frozen snapshot. */
const PATH_ANCHORED_EVIDENCE_KINDS_V1 = new Set(["LINE_RANGE", "SYMBOL"]);

export interface ConstrainResponseSchemaOptionsV1 {
  ruleIds?: string[];
  evidencePaths: string[];
  changedPaths: string[];
  canonicalInputIds: string[];
  identities: { snapshotDigest: string; briefDigest: string };
  authorVerificationClaims: AuthorPacketV1["claimedVerification"];
}

export interface ConstrainedResponseSchemaV1 {
  schema: JsonSchemaNodeV1;
  /** The limits actually applied, so a bounded review is auditable in the run record. */
  appliedArrayLimits: Record<string, number>;
}

export class ResponseSchemaShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponseSchemaShapeError";
  }
}

function requireNode(value: unknown, path: string): JsonSchemaNodeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResponseSchemaShapeError(
      `Provider response schema node is not an object at ${path}.`,
    );
  }
  return value as JsonSchemaNodeV1;
}

function optionalNode(value: unknown): JsonSchemaNodeV1 | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonSchemaNodeV1)
    : undefined;
}

function requireProperties(node: JsonSchemaNodeV1, path: string): Record<string, unknown> {
  const properties = node.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new ResponseSchemaShapeError(
      `Provider response schema does not expose properties at ${path}.`,
    );
  }
  return properties as Record<string, unknown>;
}

function optionalProperties(node: JsonSchemaNodeV1 | undefined): Record<string, unknown> {
  const properties = node?.properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? (properties as Record<string, unknown>)
    : {};
}

/** Visits every schema node, parents before children, reporting the owning property name. */
function visitNodes(
  value: unknown,
  visit: (node: JsonSchemaNodeV1, propertyName: string | undefined) => void,
  propertyName?: string,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitNodes(item, visit, propertyName);
    }
    return;
  }
  const node = optionalNode(value);
  if (!node) {
    return;
  }
  visit(node, propertyName);
  const properties = optionalProperties(node);
  for (const [name, child] of Object.entries(properties)) {
    visitNodes(child, visit, name);
  }
  for (const [key, child] of Object.entries(node)) {
    if (key !== "properties") {
      visitNodes(child, visit, propertyName);
    }
  }
}

/** Pass 1: pins the snapshot and brief identities the reviewer must echo back. */
function pinIdentityConstants(
  root: JsonSchemaNodeV1,
  identities: ConstrainResponseSchemaOptionsV1["identities"],
): void {
  const properties = requireProperties(root, "(root)");
  for (const [propertyName, expectedValue] of [
    ["snapshotDigest", identities.snapshotDigest],
    ["briefDigest", identities.briefDigest],
  ] as const) {
    const digest = requireNode(properties[propertyName], propertyName);
    const digestProperties = requireProperties(digest, propertyName);
    const value = requireNode(digestProperties.value, `${propertyName}.value`);
    value.const = expectedValue;
  }
}

/**
 * Pass 2: restricts path-anchored finding evidence to paths captured in the frozen snapshot.
 *
 * Each evidence array's items carry one variant per path-anchored anchor kind, so the number of
 * constrained variants is checked against the number of evidence arrays rather than against a
 * parity heuristic that any even count would satisfy.
 */
function constrainEvidencePaths(root: JsonSchemaNodeV1, paths: string[]): void {
  let evidenceArrays = 0;
  let constrainedVariants = 0;

  visitNodes(root, (node, propertyName) => {
    if (propertyName === "evidence" && node.type === "array") {
      evidenceArrays += 1;
    }
    const properties = optionalProperties(node);
    const anchor = optionalNode(properties.anchor);
    const path = optionalNode(properties.path);
    if (!anchor || !path || typeof anchor.const !== "string") {
      return;
    }
    if (PATH_ANCHORED_EVIDENCE_KINDS_V1.has(anchor.const)) {
      properties.path = { ...path, enum: paths };
      constrainedVariants += 1;
    }
  });

  const expectedVariants = evidenceArrays * PATH_ANCHORED_EVIDENCE_KINDS_V1.size;
  if (evidenceArrays === 0 || constrainedVariants !== expectedVariants) {
    throw new ResponseSchemaShapeError(
      `Provider response schema exposed ${constrainedVariants} path-anchored evidence variants across ${evidenceArrays} evidence arrays; expected ${expectedVariants}.`,
    );
  }
}

/**
 * Pass 3: pins each coverage ledger to exactly the identifiers it must account for.
 *
 * Must run before `boundUnspecifiedProse`, which skips arrays that already carry `maxItems`: a
 * ledger bounded afterwards would take the generic array limit and make any review of a change
 * with more entries than that limit structurally impossible.
 */
function constrainLedgers(root: JsonSchemaNodeV1, options: ConstrainResponseSchemaOptionsV1): void {
  const properties = requireProperties(root, "(root)");
  const stage = optionalNode(properties.stage)?.const;

  const constrainLedger = (
    propertyName: string,
    itemPropertyName: string,
    allowedValues: Array<string | number>,
    required: boolean,
  ): void => {
    const ledger = optionalNode(properties[propertyName]);
    if (!ledger) {
      if (required) {
        throw new ResponseSchemaShapeError(
          `Provider response schema does not expose ${propertyName}.`,
        );
      }
      return;
    }
    const items = requireNode(ledger.items, `${propertyName}.items`);
    const itemProperties = requireProperties(items, `${propertyName}.items`);
    const itemIdentifier = requireNode(
      itemProperties[itemPropertyName],
      `${propertyName}.items.${itemPropertyName}`,
    );
    ledger.minItems = allowedValues.length;
    ledger.maxItems = allowedValues.length;
    itemIdentifier.enum = allowedValues;
  };

  constrainLedger(
    "canonicalInputCoverage",
    "canonicalInputId",
    options.canonicalInputIds,
    stage === "PRELIMINARY",
  );
  constrainLedger("changedPathCoverage", "path", options.changedPaths, false);
  constrainLedger(
    "authorVerificationClaims",
    "claimIndex",
    options.authorVerificationClaims.map((_, index) => index),
    false,
  );
}

/**
 * Pass 4: bounds every prose string and every array the earlier passes left unbounded.
 *
 * Must run after `constrainLedgers`.
 */
function boundUnspecifiedProse(
  root: JsonSchemaNodeV1,
  inspectedPathLimit: number,
): Record<string, number> {
  const applied: Record<string, number> = {};

  visitNodes(root, (node, propertyName) => {
    if (node.type === "string" && node.const === undefined && node.enum === undefined) {
      node.maxLength = DEFAULT_PROSE_MAX_LENGTH_V1;
    }
    if (node.type !== "array" || node.maxItems !== undefined) {
      return;
    }
    if (propertyName === undefined) {
      throw new ResponseSchemaShapeError(
        "Provider response schema exposes an unnamed array with no item limit.",
      );
    }
    const limit =
      propertyName === "inspectedPaths"
        ? inspectedPathLimit
        : RESPONSE_ARRAY_LIMITS_V1[propertyName];
    if (limit === undefined) {
      throw new ResponseSchemaShapeError(
        `Provider response schema exposes array ${propertyName} with no configured item limit.`,
      );
    }
    node.maxItems = limit;
    applied[propertyName] = limit;
  });

  return applied;
}

/**
 * Builds the JSON Schema that constrains one provider call, over a single clone.
 *
 * The passes are ordered and each states what it depends on; the order is load-bearing, and a new
 * pass must say where it belongs.
 */
export function constrainResponseSchemaV1(
  schema: unknown,
  options: ConstrainResponseSchemaOptionsV1,
): ConstrainedResponseSchemaV1 {
  const root = requireNode(structuredClone(schema), "(root)");
  pinIdentityConstants(root, options.identities);
  constrainEvidencePaths(root, options.evidencePaths);
  constrainLedgers(root, options);
  if (options.ruleIds)
    visitNodes(root, (node, name) => {
      if ((name === "ruleIds" || name === "conflictingRuleIds") && node.type === "array") {
        const item = requireNode(node.items, "ruleIds.items");
        item.enum = options.ruleIds;
      }
      if (name === "ruleId") node.enum = options.ruleIds;
      if (name === "ruleAssessments" && node.type === "array") {
        node.minItems = options.ruleIds?.length;
        node.maxItems = options.ruleIds?.length;
      }
    });
  const appliedArrayLimits = boundUnspecifiedProse(root, Math.max(options.changedPaths.length, 1));
  const concerns = optionalNode(optionalProperties(root).preliminaryConcernDispositions);
  if (concerns) {
    // Reserve the widest count/index digits now; actual scope only shrinks after call one.
    concerns.minItems = concerns.maxItems;
    const fields = requireProperties(requireNode(concerns.items, "concern.items"), "concern.items");
    if (fields.concernIndex)
      requireNode(fields.concernIndex, "concernIndex").maximum =
        Math.max(
          RESPONSE_ARRAY_LIMITS_V1.evidenceGaps ?? 0,
          RESPONSE_ARRAY_LIMITS_V1.limitations ?? 0,
        ) - 1;
  }
  return { schema: root, appliedArrayLimits };
}

/** Narrow concern scope before call two without enlarging its reserved schema. */
export function constrainFinalConcernScopeV1(
  final: ConstrainedResponseSchemaV1,
  preliminary: Pick<PreliminaryAssessmentV1, "evidenceGaps" | "limitations">,
): ConstrainedResponseSchemaV1 {
  const schema = structuredClone(final.schema);
  const properties = requireProperties(schema, "(root)");
  const concerns = requireNode(
    properties.preliminaryConcernDispositions,
    "preliminaryConcernDispositions",
  );
  const count = preliminary.evidenceGaps.length + preliminary.limitations.length;
  if (
    count > Number(concerns.maxItems) ||
    preliminary.evidenceGaps.length > (RESPONSE_ARRAY_LIMITS_V1.evidenceGaps ?? 0) ||
    preliminary.limitations.length > (RESPONSE_ARRAY_LIMITS_V1.limitations ?? 0)
  )
    throw new ResponseSchemaShapeError(
      "Preliminary concerns exceed the admitted final response capacity.",
    );
  concerns.minItems = count;
  concerns.maxItems = count;
  const fields = requireProperties(requireNode(concerns.items, "concern.items"), "concern.items");
  if (fields.concernIndex)
    requireNode(fields.concernIndex, "concernIndex").maximum = Math.max(
      0,
      preliminary.evidenceGaps.length - 1,
      preliminary.limitations.length - 1,
    );
  if (count > 0) {
    const items = requireProperties(requireNode(concerns.items, "concern.items"), "concern.items");
    requireNode(items.kind, "concern.kind").enum = [
      ...(preliminary.evidenceGaps.length ? ["EVIDENCE_GAP"] : []),
      ...(preliminary.limitations.length ? ["LIMITATION"] : []),
    ];
  }
  return {
    schema,
    appliedArrayLimits: {
      ...final.appliedArrayLimits,
      preliminaryConcernDispositions: Number(concerns.maxItems),
    },
  };
}

/**
 * Specializes the optional repair after the preliminary has been persisted. Its complete
 * schema must be included in repair admission; it is not part of the initial call reservation.
 */
export function constrainRepairReferencesV1(
  final: ConstrainedResponseSchemaV1,
  preliminary: Pick<PreliminaryAssessmentV1, "evidenceGaps" | "limitations"> & {
    findings: { id: string }[];
  },
): ConstrainedResponseSchemaV1 {
  const schema = structuredClone(final.schema);
  const properties = requireProperties(schema, "(root)");
  const appliedArrayLimits = { ...final.appliedArrayLimits };
  if (properties.withdrawnPreliminaryFindings) {
    const ids = preliminary.findings.map((finding) => finding.id);
    visitNodes(schema, (node, name) => {
      if (name === "sourceFindingIds" && node.type === "array") {
        requireNode(node.items, "sourceFindingIds.items").enum = ids;
        node.maxItems = ids.length;
      }
      if (name === "preliminaryFindingId") node.enum = ids;
      if (name === "withdrawnPreliminaryFindings" && node.type === "array")
        node.maxItems = ids.length;
    });
  }

  const pin = (name: string, field: string, values: Array<string | number>): void => {
    const ledger = requireNode(properties[name], name);
    ledger.minItems = values.length;
    ledger.maxItems = values.length;
    appliedArrayLimits[name] = values.length;
    const items = requireProperties(requireNode(ledger.items, `${name}.items`), `${name}.items`);
    const reference = requireNode(items[field], `${name}.items.${field}`);
    reference.enum = [...new Set(values)];
  };
  if (!properties.withdrawnPreliminaryFindings)
    pin(
      "preliminaryFindingDispositions",
      "preliminaryFindingId",
      preliminary.findings.map((finding) => finding.id),
    );
  pin("preliminaryConcernDispositions", "concernIndex", [
    ...preliminary.evidenceGaps.map((_, index) => index),
    ...preliminary.limitations.map((_, index) => index),
  ]);
  const concerns = requireNode(
    properties.preliminaryConcernDispositions,
    "preliminaryConcernDispositions",
  );
  const concernProperties = requireProperties(
    requireNode(concerns.items, "preliminaryConcernDispositions.items"),
    "preliminaryConcernDispositions.items",
  );
  requireNode(concernProperties.kind, "preliminaryConcernDispositions.items.kind").enum = [
    ...(preliminary.evidenceGaps.length > 0 ? ["EVIDENCE_GAP"] : []),
    ...(preliminary.limitations.length > 0 ? ["LIMITATION"] : []),
  ];
  // Kind/index pairing, unique coverage, and finding relationships remain locally validated.
  return { schema, appliedArrayLimits };
}
