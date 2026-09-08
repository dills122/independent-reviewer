import * as z from "zod";

import { computeCanonicalInputDigestV1 } from "./canonical-input-identity.js";
import { sha256Utf8 } from "./canonical-json.js";
import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import { PersistedCanonicalInputsV1Schema } from "./review-request.js";
import {
  DigestV1Schema,
  type SnapshotContentV1,
  SnapshotManifestV1Schema,
  SnapshotPathV1Schema,
} from "./snapshot-manifest.js";

function prefixedIdentifier(prefix: "brief" | "check" | "evidence" | "hunk"): z.ZodString {
  return z
    .string()
    .min(prefix.length + 2)
    .max(128)
    .regex(
      new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]*$`),
      `must use the ${prefix}_ identifier prefix`,
    );
}

const NonEmptyTextSchema = z.string().min(1);
const CanonicalInputIdSchema = z
  .string()
  .min(7)
  .max(128)
  .regex(/^input_[A-Za-z0-9][A-Za-z0-9_-]*$/, "must use the input_ identifier prefix");

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

function logicalLineCount(content: string): number {
  const lineSeparators = content.match(/\r\n|[\r\n]/g)?.length ?? 0;
  const endsWithLineSeparator = /(?:\r\n|[\r\n])$/.test(content);
  return lineSeparators + (endsWithLineSeparator ? 0 : 1);
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

type SnapshotPathEntryV1 = z.infer<typeof SnapshotManifestV1Schema>["paths"][number];

function sourceContentAt(
  entry: SnapshotPathEntryV1,
  path: string,
  side: "BASE" | "HEAD",
): SnapshotContentV1 | undefined {
  switch (entry.changeType) {
    case "ADDED":
    case "UNTRACKED":
      return side === "HEAD" && entry.path === path ? entry.after : undefined;
    case "DELETED":
      return side === "BASE" && entry.path === path ? entry.before : undefined;
    case "MODIFIED":
    case "TYPE_CHANGED":
      if (entry.path !== path) {
        return undefined;
      }
      return side === "BASE" ? entry.before : entry.after;
    case "RENAMED":
      if (side === "BASE" && entry.previousPath === path) {
        return entry.before;
      }
      return side === "HEAD" && entry.path === path ? entry.after : undefined;
    case "COPIED":
      if (entry.previousPath === path) {
        return entry.before;
      }
      return side === "HEAD" && entry.path === path ? entry.after : undefined;
  }
}

export const NeutralReviewBriefV1Schema = z
  .strictObject({
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
        type: z.enum([
          "EXCLUDED_PATH",
          "OMITTED_CONTENT",
          "UNSUPPORTED_CONTENT",
          "EVIDENCE_BUDGET",
        ]),
        detail: NonEmptyTextSchema,
        paths: z.array(SnapshotPathV1Schema),
      }),
    ),
    capabilities: z.strictObject({
      evidenceOperations: z.array(
        z.enum(["READ_SNAPSHOT_FILE", "READ_DIFF", "SEARCH_SNAPSHOT", "READ_CANONICAL_INPUT"]),
      ),
      verificationChecks: z.array(
        z.strictObject({
          id: prefixedIdentifier("check"),
          title: NonEmptyTextSchema,
        }),
      ),
    }),
  })
  .superRefine((brief, context) => {
    const canonicalInputs = [
      ...brief.canonicalInputs.requirements,
      brief.canonicalInputs.implementationPlan,
      ...brief.canonicalInputs.projectGuidance,
    ];
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
    const verificationCheckIds = brief.capabilities.verificationChecks.map((check) => check.id);
    if (new Set(verificationCheckIds).size !== verificationCheckIds.length) {
      context.addIssue({
        code: "custom",
        message: "verification-check identifiers must be unique",
        path: ["capabilities", "verificationChecks"],
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
        logicalLineCount(evidence.content) !== evidence.endLine - evidence.startLine + 1
      ) {
        context.addIssue({
          code: "custom",
          message: "content must contain exactly the declared logical line range",
          path: ["initialEvidence", index, "content"],
        });
      }
      if (evidence.type === "SOURCE_CONTEXT") {
        const sourceContent = brief.snapshotManifest.paths
          .map((entry) => sourceContentAt(entry, evidence.path, evidence.side))
          .find((content) => content !== undefined);
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
  });

export type NeutralReviewBriefV1 = z.infer<typeof NeutralReviewBriefV1Schema>;

export const NEUTRAL_REVIEW_BRIEF_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:neutral-review-brief:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(NeutralReviewBriefV1Schema, {
    target: "draft-2020-12",
    io: "output",
  }),
};
