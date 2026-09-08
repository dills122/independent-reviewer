import * as z from "zod";

import { computeCanonicalInputDigestV1 } from "./canonical-input-identity.js";
import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import { CanonicalInputsV1Schema } from "./review-request.js";
import {
  DigestV1Schema,
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

type SnapshotPathEntryV1 = z.infer<typeof SnapshotManifestV1Schema>["paths"][number];

function sourcePathExists(
  entry: SnapshotPathEntryV1,
  path: string,
  side: "BASE" | "HEAD",
): boolean {
  switch (entry.changeType) {
    case "ADDED":
    case "UNTRACKED":
      return side === "HEAD" && entry.path === path;
    case "DELETED":
      return side === "BASE" && entry.path === path;
    case "MODIFIED":
    case "TYPE_CHANGED":
      return entry.path === path;
    case "RENAMED":
      return side === "BASE" ? entry.previousPath === path : entry.path === path;
    case "COPIED":
      return side === "BASE"
        ? entry.previousPath === path
        : entry.path === path || entry.previousPath === path;
  }
}

export const NeutralReviewBriefV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    briefId: prefixedIdentifier("brief"),
    briefDigest: DigestV1Schema,
    objective: CanonicalStatementV1Schema,
    successCriteria: z.array(CanonicalStatementV1Schema).min(1),
    canonicalInputs: CanonicalInputsV1Schema,
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

    const provenanceIdentity = (
      provenance: (typeof canonicalInputs)[number]["provenance"],
    ): string =>
      provenance.type === "REPOSITORY_FILE"
        ? `${provenance.type}:${provenance.path}:${provenance.revision ?? ""}`
        : `${provenance.type}:${provenance.label}`;
    const expectedIdentities = canonicalInputs
      .map(
        (input) =>
          `${input.kind}:${input.id}:${provenanceIdentity(input.provenance)}:${computeCanonicalInputDigestV1(input).value}`,
      )
      .sort();
    const manifestIdentities = brief.snapshotManifest.canonicalInputs
      .map(
        (input) =>
          `${input.kind}:${input.id}:${provenanceIdentity(input.provenance)}:${input.digest.value}`,
      )
      .sort();
    if (
      expectedIdentities.length !== manifestIdentities.length ||
      !expectedIdentities.every((identity, index) => identity === manifestIdentities[index])
    ) {
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
      if (
        evidence.type === "SOURCE_CONTEXT" &&
        !brief.snapshotManifest.paths.some((entry) =>
          sourcePathExists(entry, evidence.path, evidence.side),
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "must identify a path that exists on the declared source side",
          path: ["initialEvidence", index, "side"],
        });
      }
    });
  });

export type NeutralReviewBriefV1 = z.infer<typeof NeutralReviewBriefV1Schema>;

export const NEUTRAL_REVIEW_BRIEF_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:neutral-review-brief:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(NeutralReviewBriefV1Schema, {
    target: "draft-2020-12",
    io: "input",
  }),
};
