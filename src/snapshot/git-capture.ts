import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";

import {
  computeCanonicalInputDigestV1,
  digestCanonicalJson,
  finalizeSnapshotManifestV1,
  ReviewRequestV1Schema,
  SnapshotPathV1Schema,
  type DigestV1,
  type ReviewRequestV1,
  type SnapshotContentV1,
  type SnapshotManifestIdentityInputV1,
  type SnapshotManifestV1,
} from "../contracts/index.js";
import { decodeGitText, decodeNulFields, runGit } from "./git-command.js";

export type SnapshotCaptureErrorCode =
  | "AMBIGUOUS_BASE"
  | "CAPTURE_RACE"
  | "INVALID_GIT_SCOPE"
  | "NOT_GIT_REPOSITORY";

export class SnapshotCaptureError extends Error {
  readonly code: SnapshotCaptureErrorCode;

  constructor(code: SnapshotCaptureErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SnapshotCaptureError";
    this.code = code;
  }
}

export interface CaptureGitSnapshotOptionsV1 {
  base?: string;
  excludedFileSystemPaths?: string[];
  maxAttempts?: number;
  maxFileBytes?: number;
}

export interface CapturedGitSnapshotV1 {
  manifest: SnapshotManifestV1;
  blobs: ReadonlyMap<string, Uint8Array>;
}

interface ChangeSpec {
  changeType:
    | "ADDED"
    | "COPIED"
    | "DELETED"
    | "MODIFIED"
    | "RENAMED"
    | "TYPE_CHANGED"
    | "UNTRACKED";
  path: string;
  previousPath?: string;
}

interface CapturedSide {
  content: SnapshotContentV1;
  bytes: Uint8Array;
}

interface CollectedState {
  branch: string | null;
  headCommit: string;
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  includedUntrackedPaths: string[];
  paths: SnapshotManifestIdentityInputV1["paths"];
  exclusions: SnapshotManifestIdentityInputV1["exclusions"];
  omissions: SnapshotManifestIdentityInputV1["omissions"];
  blobs: Map<string, Uint8Array>;
  stateDigest: DigestV1;
}

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_ATTEMPTS = 2;

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Bytes(bytes: Uint8Array): DigestV1 {
  return {
    algorithm: "SHA256",
    value: createHash("sha256").update(bytes).digest("hex"),
  };
}

function isSecretPath(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (
    name === ".env" || name.startsWith(".env.") || name.endsWith(".pem") || name.endsWith(".key")
  );
}

function contentKind(bytes: Uint8Array): "BINARY" | "TEXT" {
  if (bytes.includes(0)) {
    return "BINARY";
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "TEXT";
  } catch {
    return "BINARY";
  }
}

function validateSnapshotPath(path: string): string {
  const parsed = SnapshotPathV1Schema.safeParse(path);
  if (!parsed.success) {
    throw new SnapshotCaptureError(
      "INVALID_GIT_SCOPE",
      `Git returned an unsupported path: ${path}`,
    );
  }
  return parsed.data;
}

async function gitText(repositoryPath: string, args: readonly string[]): Promise<string> {
  return decodeGitText((await runGit(repositoryPath, args)).stdout);
}

/**
 * Reads the mode from a single `ls-tree`/`ls-files` record. Git is invoked with
 * `--literal-pathspecs`, so one path can only match one entry; more than one record means the
 * assumption broke and the mode would be attributed to the wrong file.
 */
function singleRecordMode(records: string[], path: string): string | undefined {
  if (records.length === 0) {
    return undefined;
  }
  if (records.length > 1) {
    throw new SnapshotCaptureError(
      "INVALID_GIT_SCOPE",
      `Git returned ${records.length} entries for a single path: ${path}`,
    );
  }
  const record = records[0] as string;
  const separator = record.indexOf(" ");
  if (separator <= 0) {
    throw new SnapshotCaptureError(
      "INVALID_GIT_SCOPE",
      `Git returned an unparsable entry for path: ${path}`,
    );
  }
  return record.slice(0, separator);
}

async function gitModeAt(
  repositoryPath: string,
  revision: string,
  path: string,
): Promise<string | undefined> {
  const records = decodeNulFields(
    (await runGit(repositoryPath, ["ls-tree", "-z", revision, "--", path])).stdout,
  );
  return singleRecordMode(records, path);
}

async function indexModeAt(repositoryPath: string, path: string): Promise<string | undefined> {
  const records = decodeNulFields(
    (await runGit(repositoryPath, ["ls-files", "-s", "-z", "--", path])).stdout,
  );
  return singleRecordMode(records, path);
}

async function captureTreeSide(
  repositoryPath: string,
  revision: string,
  path: string,
  maxFileBytes: number,
): Promise<CapturedSide | "SIZE_LIMIT" | "UNSUPPORTED_KIND"> {
  const gitMode = await gitModeAt(repositoryPath, revision, path);
  if (gitMode === undefined || gitMode === "160000") {
    return "UNSUPPORTED_KIND";
  }
  if (gitMode !== "100644" && gitMode !== "100755" && gitMode !== "120000") {
    return "UNSUPPORTED_KIND";
  }
  const bytes = (await runGit(repositoryPath, ["cat-file", "blob", `${revision}:${path}`])).stdout;
  if (bytes.length > maxFileBytes) {
    return "SIZE_LIMIT";
  }
  const digest = sha256Bytes(bytes);
  const content =
    gitMode === "120000"
      ? ({
          kind: "SYMLINK",
          digest,
          byteLength: bytes.length,
          gitMode,
          isGenerated: false,
        } as const)
      : ({
          kind: contentKind(bytes),
          digest,
          byteLength: bytes.length,
          gitMode,
          isGenerated: false,
        } as const);
  return { content, bytes };
}

async function captureWorkingSide(
  repositoryPath: string,
  path: string,
  maxFileBytes: number,
): Promise<CapturedSide | "SIZE_LIMIT" | "UNSUPPORTED_KIND"> {
  const absolutePath = join(repositoryPath, path);
  const indexMode = await indexModeAt(repositoryPath, path);
  if (indexMode === "160000") {
    return "UNSUPPORTED_KIND";
  }
  const stats = await lstat(absolutePath);
  let gitMode: "100644" | "100755" | "120000";
  let bytes: Uint8Array;
  if (stats.isSymbolicLink()) {
    gitMode = "120000";
    bytes = await readlink(absolutePath, { encoding: "buffer" });
  } else if (stats.isFile()) {
    gitMode = stats.mode & 0o111 ? "100755" : "100644";
    bytes = await readFile(absolutePath);
  } else {
    return "UNSUPPORTED_KIND";
  }
  if (bytes.length > maxFileBytes) {
    return "SIZE_LIMIT";
  }
  const digest = sha256Bytes(bytes);
  const content =
    gitMode === "120000"
      ? ({
          kind: "SYMLINK",
          digest,
          byteLength: bytes.length,
          gitMode,
          isGenerated: false,
        } as const)
      : ({
          kind: contentKind(bytes),
          digest,
          byteLength: bytes.length,
          gitMode,
          isGenerated: false,
        } as const);
  return { content, bytes };
}

function parseTrackedChanges(fields: string[]): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!status) {
      throw new SnapshotCaptureError("INVALID_GIT_SCOPE", "Git returned an empty change status");
    }
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (!previousPath || !path) {
        throw new SnapshotCaptureError(
          "INVALID_GIT_SCOPE",
          "Git returned an incomplete relocation",
        );
      }
      changes.push({
        changeType: kind === "R" ? "RENAMED" : "COPIED",
        path: validateSnapshotPath(path),
        previousPath: validateSnapshotPath(previousPath),
      });
      continue;
    }
    const path = fields[index++];
    if (!path || !["A", "D", "M", "T"].includes(kind ?? "")) {
      throw new SnapshotCaptureError(
        "INVALID_GIT_SCOPE",
        `Git returned an unsupported change status: ${status}`,
      );
    }
    const changeType =
      kind === "A"
        ? "ADDED"
        : kind === "D"
          ? "DELETED"
          : kind === "T"
            ? "TYPE_CHANGED"
            : "MODIFIED";
    changes.push({ changeType, path: validateSnapshotPath(path) });
  }
  return changes;
}

async function collectChangeSpecs(
  repositoryPath: string,
  baseCommit: string,
  headCommit: string,
  captureWorkingTree: boolean,
  includeUntracked: boolean,
): Promise<ChangeSpec[]> {
  const targetArgs = captureWorkingTree ? [baseCommit] : [baseCommit, headCommit];
  const tracked = decodeNulFields(
    (
      await runGit(repositoryPath, [
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        "--find-copies-harder",
        ...targetArgs,
        "--",
      ])
    ).stdout,
  );
  const changes = parseTrackedChanges(tracked);
  if (captureWorkingTree && includeUntracked) {
    const untracked = decodeNulFields(
      (await runGit(repositoryPath, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout,
    );
    changes.push(
      ...untracked.map((path) => ({
        changeType: "UNTRACKED" as const,
        path: validateSnapshotPath(path),
      })),
    );
  }
  return changes.sort((left, right) => compareUtf16(left.path, right.path));
}

async function collectState(
  repositoryPath: string,
  baseCommit: string,
  headCommit: string,
  captureWorkingTree: boolean,
  includeUntracked: boolean,
  maxFileBytes: number,
  excludedPaths: ReadonlySet<string>,
): Promise<CollectedState> {
  const observedHeadCommit = captureWorkingTree
    ? await gitText(repositoryPath, ["rev-parse", "--verify", "HEAD^{commit}"])
    : headCommit;
  const branchResult = await runGit(
    repositoryPath,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    [0, 1],
  );
  const branch = branchResult.exitCode === 0 ? decodeGitText(branchResult.stdout) : null;
  const stagedResult = captureWorkingTree
    ? await runGit(repositoryPath, ["diff", "--cached", "--quiet", "--exit-code", "--"], [0, 1])
    : { exitCode: 0 };
  const unstagedResult = captureWorkingTree
    ? await runGit(repositoryPath, ["diff", "--quiet", "--exit-code", "--"], [0, 1])
    : { exitCode: 0 };
  const specs = await collectChangeSpecs(
    repositoryPath,
    baseCommit,
    headCommit,
    captureWorkingTree,
    includeUntracked,
  );
  const paths: SnapshotManifestIdentityInputV1["paths"] = [];
  const exclusions: SnapshotManifestIdentityInputV1["exclusions"] = [];
  const omissions: SnapshotManifestIdentityInputV1["omissions"] = [];
  const blobs = new Map<string, Uint8Array>();
  const includedUntrackedPaths: string[] = [];

  for (const spec of specs) {
    const relevantPaths = spec.previousPath ? [spec.previousPath, spec.path] : [spec.path];
    const callerExcludedPath = relevantPaths.find((path) => excludedPaths.has(path));
    if (callerExcludedPath) {
      exclusions.push({
        path: callerExcludedPath,
        reason: "RUNNER_CONTROL",
        detail: "Excluded by the caller control-file policy.",
      });
      continue;
    }
    const secretPath = relevantPaths.find(isSecretPath);
    if (secretPath) {
      exclusions.push({
        path: secretPath,
        reason: "SECRET_POLICY",
        detail: "Excluded by capture-v1 secret filename policy.",
      });
      continue;
    }
    try {
      const before =
        spec.changeType === "ADDED" || spec.changeType === "UNTRACKED"
          ? null
          : await captureTreeSide(
              repositoryPath,
              baseCommit,
              spec.previousPath ?? spec.path,
              maxFileBytes,
            );
      const after =
        spec.changeType === "DELETED"
          ? null
          : captureWorkingTree
            ? await captureWorkingSide(repositoryPath, spec.path, maxFileBytes)
            : await captureTreeSide(repositoryPath, headCommit, spec.path, maxFileBytes);
      const unavailable =
        before === "SIZE_LIMIT" || after === "SIZE_LIMIT"
          ? "SIZE_LIMIT"
          : before === "UNSUPPORTED_KIND" || after === "UNSUPPORTED_KIND"
            ? "UNSUPPORTED_KIND"
            : undefined;
      if (unavailable) {
        exclusions.push({
          path: spec.path,
          reason: unavailable,
          detail:
            unavailable === "SIZE_LIMIT"
              ? `Content exceeds the ${maxFileBytes}-byte capture limit.`
              : "Git entry kind is not supported by capture-v1.",
        });
        continue;
      }
      if (typeof before === "string" || typeof after === "string") {
        throw new Error("captured content has an unresolved availability state");
      }
      if (before) {
        const digest = before.content.digest;
        if (!digest) {
          throw new Error("captured before state has no digest");
        }
        blobs.set(digest.value, before.bytes);
      }
      if (after) {
        const digest = after.content.digest;
        if (!digest) {
          throw new Error("captured after state has no digest");
        }
        blobs.set(digest.value, after.bytes);
      }
      if (spec.changeType === "ADDED" || spec.changeType === "UNTRACKED") {
        if (!after) {
          throw new Error("added path has no captured after state");
        }
        paths.push({
          path: spec.path,
          changeType: spec.changeType,
          before: null,
          after: after.content,
        });
        if (spec.changeType === "UNTRACKED") {
          includedUntrackedPaths.push(spec.path);
        }
      } else if (spec.changeType === "DELETED") {
        if (!before) {
          throw new Error("deleted path has no captured before state");
        }
        paths.push({ path: spec.path, changeType: "DELETED", before: before.content, after: null });
      } else if (spec.changeType === "RENAMED" || spec.changeType === "COPIED") {
        if (!before || !after || !spec.previousPath) {
          throw new Error("relocated path has incomplete captured states");
        }
        paths.push({
          path: spec.path,
          previousPath: spec.previousPath,
          changeType: spec.changeType,
          before: before.content,
          after: after.content,
        });
      } else {
        if (!before || !after) {
          throw new Error("modified path has incomplete captured states");
        }
        paths.push({
          path: spec.path,
          changeType: spec.changeType,
          before: before.content,
          after: after.content,
        });
      }
    } catch {
      omissions.push({
        scope: spec.path,
        reason: "UNREADABLE",
        detail: "Unable to read captured content during snapshot capture.",
      });
    }
  }

  const stableState = {
    branch,
    headCommit: observedHeadCommit,
    hasStagedChanges: stagedResult.exitCode === 1,
    hasUnstagedChanges: unstagedResult.exitCode === 1,
    includedUntrackedPaths,
    paths,
    exclusions,
    omissions,
  };
  return {
    ...stableState,
    blobs,
    stateDigest: digestCanonicalJson(stableState),
  };
}

async function resolveBaseCommit(
  repositoryPath: string,
  requestedBase: string | undefined,
  headCommit: string,
): Promise<string> {
  let baseRef = requestedBase;
  if (!baseRef) {
    const upstream = await runGit(
      repositoryPath,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      [0, 128],
    );
    if (upstream.exitCode === 0) {
      const candidate = decodeGitText(upstream.stdout);
      const branch = decodeGitText(
        (await runGit(repositoryPath, ["branch", "--show-current"])).stdout,
      );
      if (!candidate.endsWith(`/${branch}`)) {
        baseRef = candidate;
      }
    }
  }
  if (!baseRef) {
    const remotes = decodeGitText((await runGit(repositoryPath, ["remote"])).stdout)
      .split("\n")
      .filter(Boolean);
    const defaults: string[] = [];
    for (const remote of remotes) {
      const result = await runGit(
        repositoryPath,
        ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`],
        [0, 1],
      );
      if (result.exitCode === 0) {
        defaults.push(decodeGitText(result.stdout));
      }
    }
    if (new Set(defaults).size === 1) {
      baseRef = defaults[0];
    }
  }
  if (!baseRef) {
    throw new SnapshotCaptureError(
      "AMBIGUOUS_BASE",
      "Unable to resolve a base; pass an explicit base ref.",
    );
  }
  try {
    const baseCommit = await gitText(repositoryPath, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${baseRef}^{commit}`,
    ]);
    return await gitText(repositoryPath, ["merge-base", baseCommit, headCommit]);
  } catch (error) {
    throw new SnapshotCaptureError("INVALID_GIT_SCOPE", `Unable to resolve base ref ${baseRef}.`, {
      cause: error,
    });
  }
}

/** Freezes a committed or cumulative working-tree Git target into manifest-indexed blobs. */
export async function captureGitSnapshotV1(
  value: unknown,
  options: CaptureGitSnapshotOptionsV1 = {},
): Promise<CapturedGitSnapshotV1> {
  const request = ReviewRequestV1Schema.parse(value) as ReviewRequestV1;
  let repositoryPath: string;
  try {
    repositoryPath = decodeGitText(
      (await runGit(request.repository.path, ["rev-parse", "--show-toplevel"])).stdout,
    );
    repositoryPath = await realpath(repositoryPath);
  } catch (error) {
    throw new SnapshotCaptureError("NOT_GIT_REPOSITORY", "Repository path is not a Git worktree.", {
      cause: error,
    });
  }
  const captureWorkingTree = request.repository.head === undefined;
  const headCommit = await gitText(repositoryPath, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${request.repository.head ?? "HEAD"}^{commit}`,
  ]);
  const baseCommit = await resolveBaseCommit(
    repositoryPath,
    options.base ?? request.repository.base,
    headCommit,
  );
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new RangeError("maxAttempts must be an integer from 1 to 3");
  }
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new RangeError("maxFileBytes must be a positive integer");
  }
  const excludedPaths = new Set(
    (
      await Promise.all(
        (options.excludedFileSystemPaths ?? []).map(async (absolutePath) => {
          if (!isAbsolute(absolutePath)) {
            throw new TypeError("excludedFileSystemPaths entries must be absolute paths");
          }
          try {
            return await realpath(absolutePath);
          } catch {
            return absolutePath;
          }
        }),
      )
    ).flatMap((absolutePath) => {
      const repositoryRelativePath = relative(repositoryPath, absolutePath);
      if (
        repositoryRelativePath === "" ||
        repositoryRelativePath === ".." ||
        repositoryRelativePath.startsWith("../") ||
        repositoryRelativePath.startsWith("..\\") ||
        isAbsolute(repositoryRelativePath)
      ) {
        return [];
      }
      return [validateSnapshotPath(repositoryRelativePath)];
    }),
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const first = await collectState(
      repositoryPath,
      baseCommit,
      headCommit,
      captureWorkingTree,
      request.repository.workingTree.includeUntracked,
      maxFileBytes,
      excludedPaths,
    );
    const second = await collectState(
      repositoryPath,
      baseCommit,
      headCommit,
      captureWorkingTree,
      request.repository.workingTree.includeUntracked,
      maxFileBytes,
      excludedPaths,
    );
    if (first.stateDigest.value !== second.stateDigest.value) {
      continue;
    }
    const remoteResult = await runGit(
      repositoryPath,
      ["config", "--get", "remote.origin.url"],
      [0, 1],
    );
    const repositoryIdentitySource =
      remoteResult.exitCode === 0
        ? decodeGitText(remoteResult.stdout)
        : decodeGitText((await runGit(repositoryPath, ["rev-parse", "--absolute-git-dir"])).stdout);
    const repositoryId = `repo_${sha256Bytes(Buffer.from(repositoryIdentitySource)).value.slice(0, 24)}`;
    const canonicalInputs = [
      ...request.canonicalInputs.requirements,
      request.canonicalInputs.implementationPlan,
      ...request.canonicalInputs.projectGuidance,
    ].map((input) => ({
      id: input.id,
      kind: input.kind,
      digest: computeCanonicalInputDigestV1(input),
      provenance: input.provenance,
    }));
    const manifest = finalizeSnapshotManifestV1({
      schemaVersion: 1,
      snapshotId: `snapshot_${randomUUID().replaceAll("-", "")}`,
      flowId: request.flowId,
      reviewInstance: request.reviewInstance,
      source: {
        repositoryId,
        baseCommit,
        headCommit: first.headCommit,
        branch: captureWorkingTree ? first.branch : null,
      },
      workingTree: {
        hasStagedChanges: first.hasStagedChanges,
        hasUnstagedChanges: first.hasUnstagedChanges,
        includedUntrackedPaths: first.includedUntrackedPaths,
      },
      paths: first.paths,
      exclusions: first.exclusions,
      omissions: first.omissions,
      canonicalInputs,
      policies: { capture: "capture-v1", transmission: "transmission-v1" },
      raceCheck: {
        attempts: attempt,
        status: "STABLE",
        beforeStateDigest: first.stateDigest,
        afterStateDigest: second.stateDigest,
      },
    });
    return { manifest, blobs: first.blobs };
  }
  throw new SnapshotCaptureError(
    "CAPTURE_RACE",
    `Git state changed during ${maxAttempts} capture attempt${maxAttempts === 1 ? "" : "s"}.`,
  );
}
