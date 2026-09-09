import * as z from "zod";
import { computeCanonicalInputDigestV1 } from "./canonical-input-identity.js";
import { sha256Utf8 } from "./canonical-json.js";
import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import { CanonicalInputIdSchema, NonEmptyTextSchema, prefixedIdentifier } from "./primitives.js";
import { PersistedCanonicalInputsV1Schema } from "./review-request.js";
import {
  DigestV1Schema,
  logicalLineCountV1,
  resolveSnapshotSourceContentV1,
  SnapshotManifestV1Schema,
  SnapshotPathV1Schema,
} from "./snapshot-manifest.js";
import {
  canonicalInputList,
  type ReviewCanonicalInputs,
  StandardsCanonicalInputsV2Schema,
} from "./standards-review.js";

const CanonicalStatementV1Schema = z.strictObject({
  text: NonEmptyTextSchema,
  canonicalInputIds: z.array(CanonicalInputIdSchema).min(1),
});

const DiffHunkEvidenceV1Schema = z.strictObject({
  type: z.literal("DIFF_HUNK"),
  evidenceId: prefixedIdentifier("evidence"),
  path: SnapshotPathV1Schema,
  hunkId: prefixedIdentifier("hunk"),
  content: NonEmptyTextSchema,
  digest: DigestV1Schema,
});

const SourceContextEvidenceV1Schema = z.strictObject({
  type: z.literal("SOURCE_CONTEXT"),
  evidenceId: prefixedIdentifier("evidence"),
  path: SnapshotPathV1Schema,
  side: z.enum(["BASE", "HEAD"]),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
  content: NonEmptyTextSchema,
  digest: DigestV1Schema,
});

export const InitialEvidenceV1Schema = z.discriminatedUnion("type", [
  DiffHunkEvidenceV1Schema,
  SourceContextEvidenceV1Schema,
]);

/** Computes the SHA-256 digest of the evidence content's exact UTF-8 bytes. */
export function computeInitialEvidenceContentDigestV1(
  content: string,
): z.infer<typeof DigestV1Schema> {
  if (content.length === 0) {
    throw new TypeError("initial evidence content must not be empty");
  }
  return sha256Utf8(content);
}

function sameProvenance(
  left: z.infer<typeof PersistedCanonicalInputsV1Schema>["requirements"][number]["provenance"],
  right: z.infer<typeof PersistedCanonicalInputsV1Schema>["requirements"][number]["provenance"],
): boolean {
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === "INLINE" && right.type === "INLINE") {
    return left.label === right.label;
  }
  return (
    left.type === "REPOSITORY_FILE" &&
    right.type === "REPOSITORY_FILE" &&
    left.path === right.path &&
    left.revision === right.revision
  );
}

const NeutralReviewBriefBaseV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  briefId: prefixedIdentifier("brief"),
  briefDigest: DigestV1Schema,
  objective: CanonicalStatementV1Schema,
  successCriteria: z.array(CanonicalStatementV1Schema).min(1),
  canonicalInputs: PersistedCanonicalInputsV1Schema,
  snapshotManifest: SnapshotManifestV1Schema,
  initialEvidence: z.array(InitialEvidenceV1Schema),
  coverageConstraints: z.array(
    z.strictObject({
      type: z.enum(["EXCLUDED_PATH", "OMITTED_CONTENT", "UNSUPPORTED_CONTENT", "EVIDENCE_BUDGET"]),
      detail: NonEmptyTextSchema,
      paths: z.array(SnapshotPathV1Schema),
    }),
  ),
});

function validateBrief(
  brief: Omit<
    z.infer<typeof NeutralReviewBriefBaseV1Schema>,
    "schemaVersion" | "canonicalInputs"
  > & { canonicalInputs: ReviewCanonicalInputs },
  context: z.RefinementCtx,
): void {
  const canonicalInputs = canonicalInputList(brief.canonicalInputs);
  const canonicalIds = new Set(canonicalInputs.map((input) => input.id));

  const statements = [brief.objective, ...brief.successCriteria];
  statements.forEach((statement, statementIndex) => {
    statement.canonicalInputIds.forEach((inputId, inputIndex) => {
      if (!canonicalIds.has(inputId)) {
        context.addIssue({
          code: "custom",
          message: "must identify a canonical input included in this brief",
          path:
            statementIndex === 0
              ? ["objective", "canonicalInputIds", inputIndex]
              : ["successCriteria", statementIndex - 1, "canonicalInputIds", inputIndex],
        });
      }
    });
  });

  const manifestInputById = new Map(
    brief.snapshotManifest.canonicalInputs.map((input) => [input.id, input]),
  );
  const canonicalInputsMatch =
    canonicalInputs.length === manifestInputById.size &&
    canonicalInputs.every((input) => {
      const manifestInput = manifestInputById.get(input.id);
      return (
        manifestInput !== undefined &&
        manifestInput.kind === input.kind &&
        sameProvenance(manifestInput.provenance, input.provenance) &&
        manifestInput.digest.value === computeCanonicalInputDigestV1(input).value
      );
    });
  if (!canonicalInputsMatch) {
    context.addIssue({
      code: "custom",
      message: "must exactly match canonical inputs included in this brief",
      path: ["snapshotManifest", "canonicalInputs"],
    });
  }

  const manifestPaths = new Set(
    brief.snapshotManifest.paths.flatMap((entry) =>
      "previousPath" in entry ? [entry.path, entry.previousPath] : [entry.path],
    ),
  );
  const evidenceIds = brief.initialEvidence.map((evidence) => evidence.evidenceId);
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    context.addIssue({
      code: "custom",
      message: "initial evidence identifiers must be unique",
      path: ["initialEvidence"],
    });
  }
  brief.initialEvidence.forEach((evidence, index) => {
    if (!manifestPaths.has(evidence.path)) {
      context.addIssue({
        code: "custom",
        message: "must identify a path declared by the snapshot manifest",
        path: ["initialEvidence", index, "path"],
      });
    }
    if (evidence.type === "SOURCE_CONTEXT" && evidence.startLine > evidence.endLine) {
      context.addIssue({
        code: "custom",
        message: "must be greater than or equal to startLine",
        path: ["initialEvidence", index, "endLine"],
      });
    }
    if (evidence.digest.value !== computeInitialEvidenceContentDigestV1(evidence.content).value) {
      context.addIssue({
        code: "custom",
        message: "must match the SHA-256 digest of the exact evidence content",
        path: ["initialEvidence", index, "digest"],
      });
    }
    if (
      evidence.type === "SOURCE_CONTEXT" &&
      logicalLineCountV1(evidence.content) !== evidence.endLine - evidence.startLine + 1
    ) {
      context.addIssue({
        code: "custom",
        message: "content must contain exactly the declared logical line range",
        path: ["initialEvidence", index, "content"],
      });
    }
    if (evidence.type === "SOURCE_CONTEXT") {
      const sourceContent = resolveSnapshotSourceContentV1(
        brief.snapshotManifest.paths,
        evidence.path,
        evidence.side,
      );
      if (sourceContent === undefined) {
        context.addIssue({
          code: "custom",
          message: "must identify a path that exists on the declared source side",
          path: ["initialEvidence", index, "side"],
        });
      } else if (sourceContent.kind !== "TEXT") {
        context.addIssue({
          code: "custom",
          message: "SOURCE_CONTEXT requires text content on the declared source side",
          path: ["initialEvidence", index, "type"],
        });
      }
    }
  });
}
export const NeutralReviewBriefV1Schema = NeutralReviewBriefBaseV1Schema.superRefine(validateBrief);
export const StandardsReviewBriefV2Schema = z
  .strictObject({
    ...NeutralReviewBriefBaseV1Schema.shape,
    schemaVersion: z.literal(2),
    mode: z.literal("STANDARDS"),
    canonicalInputs: StandardsCanonicalInputsV2Schema,
  })
  .superRefine(validateBrief);
export const ReviewBriefSchema = z.union([
  NeutralReviewBriefV1Schema,
  StandardsReviewBriefV2Schema,
]);
export type ReviewBrief = z.infer<typeof ReviewBriefSchema>;

export type NeutralReviewBriefV1 = z.infer<typeof NeutralReviewBriefV1Schema>;

export const NEUTRAL_REVIEW_BRIEF_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:neutral-review-brief:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(NeutralReviewBriefV1Schema, {
    target: "draft-2020-12",
    io: "output",
  }),
};
