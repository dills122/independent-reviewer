import { matchesGlob } from "node:path";
import * as z from "zod";
import { computeCanonicalInputDigestV1 } from "./canonical-input-identity.js";
import { sha256Utf8 } from "./canonical-json.js";
import {
  CanonicalGuidancePresentationV1Schema,
  GuidanceGraphBindingV1Schema,
} from "./guidance-presentation.js";
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
  selectedReferences,
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
  /**
   * Read-only source of unchanged files the changed code imports, so a call can be checked against
   * the contract it targets. These are not review targets: they need no coverage and a finding may
   * not cite them, because the defect lives at the call site, not in the file being called.
   */
  referencedSources: z.array(
    z.strictObject({
      path: SnapshotPathV1Schema,
      importedBy: z.array(SnapshotPathV1Schema),
      standardReferenceIds: z.array(prefixedIdentifier("reference")).optional(),
      content: NonEmptyTextSchema,
    }),
  ),
  coverageConstraints: z.array(
    z.strictObject({
      type: z.enum([
        "EXCLUDED_PATH",
        "OMITTED_CONTENT",
        "UNSUPPORTED_CONTENT",
        "EVIDENCE_BUDGET",
        "OUT_OF_SCOPE",
      ]),
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
  const referencedPaths = brief.referencedSources.map((source) => source.path);
  if (new Set(referencedPaths).size !== referencedPaths.length) {
    context.addIssue({
      code: "custom",
      message: "referenced sources must be distinct",
      path: ["referencedSources"],
    });
  }
  brief.referencedSources.forEach((source, index) => {
    if (!brief.snapshotManifest.referencedSources.some((entry) => entry.path === source.path)) {
      context.addIssue({
        code: "custom",
        message: "referenced source must be captured in the snapshot manifest",
        path: ["referencedSources", index, "path"],
      });
    }
    if (manifestPaths.has(source.path)) {
      context.addIssue({
        code: "custom",
        message: "a changed path cannot also be transmitted as referenced context",
        path: ["referencedSources", index, "path"],
      });
    }
  });

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
export const ReferenceEvidenceV2Schema = z.strictObject({
  referenceId: prefixedIdentifier("reference"),
  path: SnapshotPathV1Schema,
  roles: z.array(z.enum(["REVIEW_TARGET", "SUPPORTING_REFERENCE"])).min(1),
  captureStatus: z.enum(["CAPTURED", "OUT_OF_SCOPE", "UNAVAILABLE", "OMITTED"]),
  authoritySide: z.literal("BASE"),
  required: z.boolean(),
  boundRuleIds: z.array(prefixedIdentifier("rule")).min(1),
});
export const StandardsReviewBriefV2Schema = z
  .strictObject({
    ...NeutralReviewBriefBaseV1Schema.shape,
    schemaVersion: z.literal(2),
    mode: z.literal("STANDARDS"),
    canonicalInputs: StandardsCanonicalInputsV2Schema,
    referenceEvidence: z.array(ReferenceEvidenceV2Schema),
  })
  .superRefine((brief, context) => {
    validateBrief(brief, context);
    const declaredReferences = new Map(
      selectedReferences(brief.canonicalInputs).map((reference) => [reference.id, reference]),
    );
    const observedIds = brief.referenceEvidence.map(({ referenceId }) => referenceId);
    if (
      new Set(observedIds).size !== observedIds.length ||
      observedIds.length !== declaredReferences.size ||
      observedIds.some((id) => !declaredReferences.has(id))
    )
      context.addIssue({
        code: "custom",
        path: ["referenceEvidence"],
        message: "Reference evidence must account for every declared reference exactly once.",
      });
    brief.referenceEvidence.forEach((entry, index) => {
      const reference = declaredReferences.get(entry.referenceId);
      if (reference?.path !== entry.path)
        context.addIssue({
          code: "custom",
          path: ["referenceEvidence", index, "path"],
          message: "Reference evidence path must match its declaration.",
        });
      if (!reference) return;
      const target = brief.snapshotManifest.paths.some(({ path }) => path === entry.path);
      const applicableBindings = reference.bindings.filter((binding) =>
        brief.snapshotManifest.paths.some((path) =>
          binding.paths.some((pattern) => matchesGlob(path.path, pattern)),
        ),
      );
      const capturedAsContext = brief.snapshotManifest.referencedSources.some(
        ({ path }) => path === entry.path,
      );
      const capturedAtBase = target
        ? resolveSnapshotSourceContentV1(brief.snapshotManifest.paths, entry.path, "BASE") !==
          undefined
        : capturedAsContext;
      const omitted = brief.snapshotManifest.omissions.some(({ scope }) => scope === entry.path);
      const expectedStatus =
        target || applicableBindings.length > 0
          ? capturedAtBase
            ? "CAPTURED"
            : omitted
              ? "OMITTED"
              : "UNAVAILABLE"
          : "OUT_OF_SCOPE";
      const expectedRoles = target
        ? ["REVIEW_TARGET", "SUPPORTING_REFERENCE"]
        : ["SUPPORTING_REFERENCE"];
      if (
        entry.roles.length !== expectedRoles.length ||
        expectedRoles.some((role) => !entry.roles.includes(role as (typeof entry.roles)[number]))
      )
        context.addIssue({
          code: "custom",
          path: ["referenceEvidence", index, "roles"],
          message: "Reference roles must match frozen target participation.",
        });
      if (entry.captureStatus !== expectedStatus)
        context.addIssue({
          code: "custom",
          path: ["referenceEvidence", index, "captureStatus"],
          message: "Reference capture status must match frozen evidence availability.",
        });
      if (entry.required !== applicableBindings.some(({ required }) => required))
        context.addIssue({
          code: "custom",
          path: ["referenceEvidence", index, "required"],
          message: "Reference requirement must match applicable rule bindings.",
        });
      const expectedRuleIds = reference.bindings.map(({ ruleId }) => ruleId);
      if (
        entry.boundRuleIds.length !== expectedRuleIds.length ||
        expectedRuleIds.some((ruleId) => !entry.boundRuleIds.includes(ruleId))
      )
        context.addIssue({
          code: "custom",
          path: ["referenceEvidence", index, "boundRuleIds"],
          message: "Reference rule bindings must match the selected standards profile.",
        });
    });
  });

export const StandardsReviewBriefV3Schema = z
  .strictObject({
    ...NeutralReviewBriefBaseV1Schema.shape,
    schemaVersion: z.literal(3),
    mode: z.literal("STANDARDS"),
    canonicalInputs: StandardsCanonicalInputsV2Schema,
    referenceEvidence: z.array(ReferenceEvidenceV2Schema),
    guidanceGraph: GuidanceGraphBindingV1Schema,
    guidancePresentation: CanonicalGuidancePresentationV1Schema,
  })
  .superRefine((brief, context) => {
    const { guidanceGraph: _binding, guidancePresentation: _presentation, ...common } = brief;
    const legacy = StandardsReviewBriefV2Schema.safeParse({ ...common, schemaVersion: 2 });
    if (!legacy.success) {
      for (const issue of legacy.error.issues)
        context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  });
export const ReviewBriefSchema = z.union([
  NeutralReviewBriefV1Schema,
  StandardsReviewBriefV2Schema,
  StandardsReviewBriefV3Schema,
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
