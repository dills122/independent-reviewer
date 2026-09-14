import {
  canonicalizeJson,
  compactGuidanceDiagnosticsV1,
  type DirectGuidanceRecognitionV1,
  type GuidanceDiagnosticV1,
  type GuidanceGraphV1,
  MAX_GUIDANCE_APPLICABILITY_PAIRS_V1,
  MAX_GUIDANCE_APPLICABILITY_PATHS_V1,
  MAX_GUIDANCE_DIRECT_CANDIDATES_V1,
  MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1,
  MAX_GUIDANCE_EDGES_V1,
  MAX_GUIDANCE_NODES_V1,
  MAX_GUIDANCE_OCCURRENCES_V1,
  MAX_GUIDANCE_SNAPSHOT_ENTRIES_V1,
  MAX_GUIDANCE_TARGETS_V1,
  projectGuidanceTargetsV1,
  type SnapshotManifestV1,
  SnapshotPathV1Schema,
} from "../contracts/index.js";
import { GuidanceCaptureError } from "./base-markdown-source.js";

type GuidanceNodeIdentityV1 = Pick<
  GuidanceGraphV1["nodes"][number],
  "resolvedPath" | "contentDigest"
>;

function limitError(resource: string, limit: number): never {
  throw new GuidanceCaptureError(
    "GUIDANCE_DISCOVERY_LIMIT_EXCEEDED",
    "guidance",
    `Guidance discovery limit exceeded: more than ${limit} ${resource}.`,
  );
}

function addWithinLimit(
  values: Set<string>,
  candidates: readonly string[],
  limit: number,
  label: string,
) {
  const additions = candidates.filter((candidate) => !values.has(candidate));
  if (values.size + new Set(additions).size > limit) limitError(label, limit);
  for (const candidate of additions) values.add(candidate);
}

function nodeIdentity(source: GuidanceNodeIdentityV1): string {
  return canonicalizeJson({
    resolvedPath: SnapshotPathV1Schema.parse(source.resolvedPath),
    contentDigest: source.contentDigest,
  });
}

/** Shared, synchronous cap accounting for one complete repository-guidance discovery. */
export class GuidanceDiscoverySessionV1 {
  readonly targets: ReturnType<typeof projectGuidanceTargetsV1>;
  readonly #candidates = new Set<string>();
  readonly #nodes = new Set<string>();
  readonly #recognitions = new Set<string>();
  readonly #applicabilityPairs = new Set<string>();
  readonly #occurrences = new Set<string>();
  readonly #edges = new Set<string>();
  readonly #diagnostics = new Map<string, GuidanceDiagnosticV1>();

  constructor(manifest: SnapshotManifestV1) {
    if (manifest.paths.length > MAX_GUIDANCE_SNAPSHOT_ENTRIES_V1)
      limitError("snapshot entries were admitted", MAX_GUIDANCE_SNAPSHOT_ENTRIES_V1);
    this.targets = projectGuidanceTargetsV1(manifest);
    if (this.targets.length > MAX_GUIDANCE_TARGETS_V1)
      limitError("canonical targets were projected", MAX_GUIDANCE_TARGETS_V1);
    const applicabilityPaths = new Set(
      this.targets.map(({ applicabilityPath }) => applicabilityPath),
    );
    if (applicabilityPaths.size > MAX_GUIDANCE_APPLICABILITY_PATHS_V1)
      limitError("target applicability paths were projected", MAX_GUIDANCE_APPLICABILITY_PATHS_V1);
  }

  claimDirectCandidates(paths: readonly string[]): void {
    addWithinLimit(
      this.#candidates,
      paths.map((path) => SnapshotPathV1Schema.parse(path)),
      MAX_GUIDANCE_DIRECT_CANDIDATES_V1,
      "direct candidates were recognized",
    );
  }

  claimDirectRecognition(
    source: GuidanceNodeIdentityV1,
    recognition: DirectGuidanceRecognitionV1,
  ): void {
    const sourceKey = nodeIdentity(source);
    const recognitionKey = canonicalizeJson({ source: sourceKey, recognition });
    const applicabilityKey = canonicalizeJson({
      source: sourceKey,
      targetId: recognition.applicableTargetId,
    });
    if (!this.#nodes.has(sourceKey) && this.#nodes.size >= MAX_GUIDANCE_NODES_V1)
      limitError("applicable source nodes were selected", MAX_GUIDANCE_NODES_V1);
    if (
      !this.#recognitions.has(recognitionKey) &&
      this.#recognitions.size >= MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1
    )
      limitError("direct recognitions were produced", MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1);
    if (
      !this.#applicabilityPairs.has(applicabilityKey) &&
      this.#applicabilityPairs.size >= MAX_GUIDANCE_APPLICABILITY_PAIRS_V1
    )
      limitError(
        "source/target applicability pairs were produced",
        MAX_GUIDANCE_APPLICABILITY_PAIRS_V1,
      );
    this.#nodes.add(sourceKey);
    this.#recognitions.add(recognitionKey);
    this.#applicabilityPairs.add(applicabilityKey);
  }

  claimOccurrence(value: unknown): string {
    const key = canonicalizeJson(value);
    addWithinLimit(
      this.#occurrences,
      [key],
      MAX_GUIDANCE_OCCURRENCES_V1,
      "canonical import occurrences were produced",
    );
    return key;
  }

  claimImportEdge(
    occurrenceKey: string,
    imported: GuidanceNodeIdentityV1,
    applicableTargetId: string,
  ): void {
    const sourceKey = nodeIdentity(imported);
    const applicabilityKey = canonicalizeJson({ source: sourceKey, targetId: applicableTargetId });
    const edgeKey = canonicalizeJson({
      occurrence: occurrenceKey,
      source: sourceKey,
      applicableTargetId,
    });
    if (!this.#nodes.has(sourceKey) && this.#nodes.size >= MAX_GUIDANCE_NODES_V1)
      limitError("applicable source nodes were selected", MAX_GUIDANCE_NODES_V1);
    if (
      !this.#applicabilityPairs.has(applicabilityKey) &&
      this.#applicabilityPairs.size >= MAX_GUIDANCE_APPLICABILITY_PAIRS_V1
    )
      limitError(
        "source/target applicability pairs were produced",
        MAX_GUIDANCE_APPLICABILITY_PAIRS_V1,
      );
    if (!this.#edges.has(edgeKey) && this.#edges.size >= MAX_GUIDANCE_EDGES_V1)
      limitError("expanded import edges were produced", MAX_GUIDANCE_EDGES_V1);
    this.#nodes.add(sourceKey);
    this.#applicabilityPairs.add(applicabilityKey);
    this.#edges.add(edgeKey);
  }

  addDiagnostic(diagnostic: GuidanceDiagnosticV1): void {
    if (diagnostic.code === "DIAGNOSTIC_LIMIT_EXCEEDED")
      throw new Error("Adapters cannot supply a diagnostic-overflow summary.");
    this.#diagnostics.set(diagnostic.diagnosticId, diagnostic);
  }

  finalizeDiagnostics(): GuidanceDiagnosticV1[] {
    return compactGuidanceDiagnosticsV1([...this.#diagnostics.values()]);
  }
}

export function createGuidanceDiscoverySessionV1(
  manifest: SnapshotManifestV1,
): GuidanceDiscoverySessionV1 {
  return new GuidanceDiscoverySessionV1(manifest);
}
