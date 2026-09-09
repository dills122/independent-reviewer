import * as z from "zod";

import { canonicalizeJson } from "./canonical-json.js";
import {
  CanonicalInputProvenanceV1Schema,
  FlowIdSchema,
  PersistedReviewInstanceV1Schema,
} from "./review-request.js";
import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";

function prefixedIdentifier(prefix: "repo" | "snapshot"): z.ZodString {
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
const GitObjectIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "must be a lowercase Git object ID");
const PersistedBranchNameSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    const components = value.split("/");
    const hasForbiddenCharacter = [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x20 || codePoint === 0x7f || "~^:?*[\\".includes(character);
    });
    return (
      !value.startsWith("-") &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.includes("//") &&
      !value.includes("..") &&
      !value.includes("@{") &&
      value !== "@" &&
      !hasForbiddenCharacter &&
      components.every((component) => !component.startsWith(".") && !component.endsWith(".lock"))
    );
  }, "must be a valid persisted Git branch name");

export const SnapshotPathV1Schema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.includes("\n") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "must be a normalized relative snapshot path",
  );

export const DigestV1Schema = z.strictObject({
  algorithm: z.literal("SHA256"),
  value: z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase SHA-256 digest"),
});

const GitModeSchema = z.string().regex(/^[0-7]{6}$/, "must be a six-digit Git mode");
const RegularFileModeSchema = z.enum(["100644", "100755"]);

const CapturedContentBaseShape = {
  digest: DigestV1Schema,
  byteLength: z.int().nonnegative(),
  isGenerated: z.boolean(),
};

const TextContentV1Schema = z.strictObject({
  kind: z.literal("TEXT"),
  ...CapturedContentBaseShape,
  gitMode: RegularFileModeSchema,
});

const BinaryContentV1Schema = z.strictObject({
  kind: z.literal("BINARY"),
  ...CapturedContentBaseShape,
  gitMode: RegularFileModeSchema,
});

const SymlinkContentV1Schema = z.strictObject({
  kind: z.literal("SYMLINK"),
  ...CapturedContentBaseShape,
  gitMode: z.literal("120000"),
});

const SubmoduleContentV1Schema = z.strictObject({
  kind: z.literal("SUBMODULE"),
  ...CapturedContentBaseShape,
  gitMode: z.literal("160000"),
});

const UnsupportedContentV1Schema = z.strictObject({
  kind: z.literal("UNSUPPORTED"),
  digest: DigestV1Schema.optional(),
  byteLength: z.int().nonnegative().optional(),
  gitMode: GitModeSchema,
  isGenerated: z.boolean(),
  reason: NonEmptyTextSchema,
});

export const SnapshotContentV1Schema = z.discriminatedUnion("kind", [
  TextContentV1Schema,
  BinaryContentV1Schema,
  SymlinkContentV1Schema,
  SubmoduleContentV1Schema,
  UnsupportedContentV1Schema,
]);

export type SnapshotContentV1 = z.infer<typeof SnapshotContentV1Schema>;

function gitEntryCategory(content: SnapshotContentV1): string {
  switch (content.gitMode) {
    case "100644":
    case "100755":
      return "REGULAR";
    case "120000":
      return "SYMLINK";
    case "160000":
      return "SUBMODULE";
    default:
      return `UNSUPPORTED:${content.gitMode}`;
  }
}

const PathIdentityShape = {
  path: SnapshotPathV1Schema,
};

const AddedPathV1Schema = z.strictObject({
  ...PathIdentityShape,
  changeType: z.literal(["ADDED", "UNTRACKED"]),
  before: z.null(),
  after: SnapshotContentV1Schema,
});

const DeletedPathV1Schema = z.strictObject({
  ...PathIdentityShape,
  changeType: z.literal("DELETED"),
  before: SnapshotContentV1Schema,
  after: z.null(),
});

const ModifiedPathV1Schema = z.strictObject({
  ...PathIdentityShape,
  changeType: z.literal(["MODIFIED", "TYPE_CHANGED"]),
  before: SnapshotContentV1Schema,
  after: SnapshotContentV1Schema,
});

const RelocatedPathV1Schema = z.strictObject({
  ...PathIdentityShape,
  changeType: z.literal(["RENAMED", "COPIED"]),
  previousPath: SnapshotPathV1Schema,
  before: SnapshotContentV1Schema,
  after: SnapshotContentV1Schema,
});

export const SnapshotPathEntryV1Schema = z.discriminatedUnion("changeType", [
  AddedPathV1Schema,
  DeletedPathV1Schema,
  ModifiedPathV1Schema,
  RelocatedPathV1Schema,
]);

const CaptureRaceCheckV1Schema = z
  .strictObject({
    attempts: z.int().min(1),
    status: z.literal("STABLE"),
    beforeStateDigest: DigestV1Schema,
    afterStateDigest: DigestV1Schema,
  })
  .superRefine((raceCheck, context) => {
    if (raceCheck.beforeStateDigest.value !== raceCheck.afterStateDigest.value) {
      context.addIssue({
        code: "custom",
        message: "must equal the before-state digest for a stable snapshot",
        path: ["afterStateDigest", "value"],
      });
    }
  });

export const SnapshotManifestV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    snapshotId: prefixedIdentifier("snapshot"),
    flowId: FlowIdSchema,
    reviewInstance: PersistedReviewInstanceV1Schema,
    source: z.strictObject({
      repositoryId: prefixedIdentifier("repo"),
      baseCommit: GitObjectIdSchema,
      headCommit: GitObjectIdSchema,
      branch: PersistedBranchNameSchema.nullable(),
    }),
    workingTree: z.strictObject({
      hasStagedChanges: z.boolean(),
      hasUnstagedChanges: z.boolean(),
      includedUntrackedPaths: z.array(SnapshotPathV1Schema),
    }),
    snapshotDigest: DigestV1Schema,
    paths: z.array(SnapshotPathEntryV1Schema),
    exclusions: z.array(
      z.strictObject({
        path: SnapshotPathV1Schema,
        reason: z.enum([
          "SECRET_POLICY",
          "SECRET_CONTENT",
          "PATH_POLICY",
          "SIZE_LIMIT",
          "GENERATED_POLICY",
          "RUNNER_CONTROL",
          "USER_EXCLUDED",
          "UNSUPPORTED_KIND",
        ]),
        detail: NonEmptyTextSchema,
      }),
    ),
    omissions: z.array(
      z.strictObject({
        scope: NonEmptyTextSchema,
        reason: z.enum([
          "UNREADABLE",
          "CAPTURE_FAILED",
          "SUBMODULE_UNAVAILABLE",
          "RACE_DETECTED",
          "OTHER",
        ]),
        detail: NonEmptyTextSchema,
      }),
    ),
    canonicalInputs: z.array(
      z.strictObject({
        id: z
          .string()
          .min(7)
          .max(128)
          .regex(/^input_[A-Za-z0-9][A-Za-z0-9_-]*$/, "must use the input_ identifier prefix"),
        kind: z.enum(["REQUIREMENTS", "IMPLEMENTATION_PLAN", "PROJECT_GUIDANCE"]),
        digest: DigestV1Schema,
        provenance: CanonicalInputProvenanceV1Schema,
      }),
    ),
    policies: z.strictObject({
      capture: NonEmptyTextSchema,
      transmission: NonEmptyTextSchema,
    }),
    raceCheck: CaptureRaceCheckV1Schema,
  })
  .superRefine((manifest, context) => {
    if (manifest.source.baseCommit.length !== manifest.source.headCommit.length) {
      context.addIssue({
        code: "custom",
        message: "base and head commits must use the same Git object format",
        path: ["source", "headCommit"],
      });
    }

    const manifestPaths = manifest.paths.map((path) => path.path);
    if (new Set(manifestPaths).size !== manifestPaths.length) {
      context.addIssue({
        code: "custom",
        message: "change-manifest paths must be unique",
        path: ["paths"],
      });
    }

    manifest.paths.forEach((path, index) => {
      if ("previousPath" in path && path.previousPath === path.path) {
        context.addIssue({
          code: "custom",
          message: "previous path must differ from the relocated path",
          path: ["paths", index, "previousPath"],
        });
      }
      if (path.changeType === "MODIFIED" || path.changeType === "TYPE_CHANGED") {
        const beforeCategory = gitEntryCategory(path.before);
        const afterCategory = gitEntryCategory(path.after);
        const categoriesChanged = beforeCategory !== afterCategory;
        if (path.changeType === "TYPE_CHANGED" && !categoriesChanged) {
          context.addIssue({
            code: "custom",
            message: "TYPE_CHANGED must change the Git entry category",
            path: ["paths", index, "changeType"],
          });
        }
        if (path.changeType === "MODIFIED" && categoriesChanged) {
          context.addIssue({
            code: "custom",
            message: "MODIFIED must preserve the Git entry category",
            path: ["paths", index, "changeType"],
          });
        }
        if (
          path.changeType === "MODIFIED" &&
          canonicalizeJson(path.before) === canonicalizeJson(path.after)
        ) {
          context.addIssue({
            code: "custom",
            message: "MODIFIED must change at least one persisted content property",
            path: ["paths", index, "changeType"],
          });
        }
      }
    });

    const canonicalInputIds = manifest.canonicalInputs.map((input) => input.id);
    if (new Set(canonicalInputIds).size !== canonicalInputIds.length) {
      context.addIssue({
        code: "custom",
        message: "canonical input identifiers must be unique",
        path: ["canonicalInputs"],
      });
    }

    const declared = manifest.workingTree.includedUntrackedPaths;
    const captured = manifest.paths
      .filter((path) => path.changeType === "UNTRACKED")
      .map((path) => path.path);
    const declaredPaths = [...declared].sort();
    const capturedPaths = [...captured].sort();
    const samePaths =
      declaredPaths.length === capturedPaths.length &&
      declaredPaths.every((path, index) => path === capturedPaths[index]);

    if (!samePaths) {
      context.addIssue({
        code: "custom",
        message: "must exactly match paths classified as UNTRACKED",
        path: ["workingTree", "includedUntrackedPaths"],
      });
    }
  });

export type SnapshotManifestV1 = z.infer<typeof SnapshotManifestV1Schema>;
export type DigestV1 = z.infer<typeof DigestV1Schema>;
export type SnapshotPathEntryV1 = z.infer<typeof SnapshotPathEntryV1Schema>;

/**
 * Resolves the captured content a `(path, side)` citation refers to, or `undefined` when the
 * snapshot holds no content for that pair.
 *
 * A snapshot records two states per entry: `before` is the BASE content at `previousPath`
 * (RENAMED, COPIED) or at `path`, and `after` is the HEAD content at `path`.
 *
 * A RENAMED entry's `previousPath` resolves on BASE only — the path no longer exists on HEAD. A
 * COPIED entry's `previousPath` resolves on both sides: the source is retained by the copy and its
 * captured `before` bytes are its HEAD bytes too. If that source was itself modified, the manifest
 * carries a separate entry owning the path, which `resolveSnapshotSourceContentV1` prefers.
 */
export function snapshotSourceContentAtV1(
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

/**
 * Resolves a `(path, side)` citation against a whole manifest. Entries that own the path directly
 * are consulted before relocation sources, so a path that is both a copy source and separately
 * changed resolves to the entry that actually captured it rather than to manifest order.
 */
export function resolveSnapshotSourceContentV1(
  paths: readonly SnapshotPathEntryV1[],
  path: string,
  side: "BASE" | "HEAD",
): SnapshotContentV1 | undefined {
  const owned = paths.filter((entry) => entry.path === path);
  const relocationSources = paths.filter((entry) => entry.path !== path);
  for (const entry of [...owned, ...relocationSources]) {
    const content = snapshotSourceContentAtV1(entry, path, side);
    if (content !== undefined) {
      return content;
    }
  }
  return undefined;
}

/**
 * Counts the lines a `LINE_RANGE` citation can address. Empty content has no addressable line, so
 * any range over it is out of bounds.
 */
export function logicalLineCountV1(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const lineSeparators = content.match(/\r\n|[\r\n]/g)?.length ?? 0;
  const endsWithLineSeparator = /(?:\r\n|[\r\n])$/.test(content);
  return lineSeparators + (endsWithLineSeparator ? 0 : 1);
}

export const SNAPSHOT_MANIFEST_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:snapshot-manifest:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(SnapshotManifestV1Schema, {
    target: "draft-2020-12",
    io: "output",
  }),
};
