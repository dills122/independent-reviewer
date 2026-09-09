import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";

import {
  compareUtf16,
  computeCanonicalInputDigestV1,
  sha256BytesDigestV1,
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
import { mapWithConcurrencyV1 } from "./concurrency.js";
import {
  decodeGitText,
  decodeNulFields,
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  runGit,
} from "./git-command.js";

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
  /** Caller-supplied glob patterns, matched against repository-relative paths. */
  excludedPathPatterns?: string[];
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

/** Whole basenames that carry credentials by convention. */
const SECRET_FILENAMES_V1 = new Set([
  ".env",
  ".netrc",
  "_netrc",
  ".npmrc",
  ".pypirc",
  ".dockercfg",
  ".git-credentials",
  ".htpasswd",
  ".pgpass",
  "credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "terraform.tfvars",
]);

/** Extensions whose contents are key material or credential stores. */
const SECRET_EXTENSIONS_V1 = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".ppk",
  ".kdbx",
  ".tfstate",
];

/** Directory components whose contents are credentials regardless of file name. */
const SECRET_DIRECTORIES_V1 = new Set([".ssh", ".aws", ".gnupg", ".docker"]);

/**
 * High-confidence credential markers, used to catch the common case the filename policy cannot:
 * a key pasted into ordinary source, configuration, or a test fixture.
 */
const SECRET_CONTENT_MARKERS_V1: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "PEM private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "PGP private key block", pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----/ },
  { label: "AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/ },
  { label: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
];

/** Bytes scanned for content markers; a credential sits near the top of a file in practice. */
const SECRET_SCAN_BYTES_V1 = 256 * 1024;

function isSecretPath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  if (segments.slice(0, -1).some((segment) => SECRET_DIRECTORIES_V1.has(segment))) {
    return true;
  }
  const name = basename(path).toLowerCase();
  return (
    SECRET_FILENAMES_V1.has(name) ||
    name.startsWith(".env.") ||
    name.startsWith("service-account") ||
    /^secrets?\.ya?ml$/.test(name) ||
    SECRET_EXTENSIONS_V1.some((extension) => name.endsWith(extension))
  );
}

/** Names the first credential marker found in captured content, if any. */
function secretContentMarker(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) {
    return undefined;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(
      bytes.subarray(0, SECRET_SCAN_BYTES_V1),
    );
  } catch {
    return undefined;
  }
  return SECRET_CONTENT_MARKERS_V1.find(({ pattern }) => pattern.test(text))?.label;
}

/**
 * Compiles caller-supplied exclusion patterns. `*` matches within a path segment, `**` across
 * segments; matching is case-insensitive and anchored to the whole repository-relative path.
 */
function compileExclusionPatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((pattern) => {
    const source = pattern
      .split(/(\*\*\/|\*\*|\*|\?)/)
      .map((part) => {
        switch (part) {
          case "**/":
            return "(?:[^/]*/)*";
          case "**":
            return ".*";
          case "*":
            return "[^/]*";
          case "?":
            return "[^/]";
          default:
            return part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        }
      })
      .join("");
    return new RegExp(`^${source}$`, "i");
  });
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

/**
 * Builds the captured side shared by the tree and working-tree readers, which differ only in how
 * `gitMode` and `bytes` were obtained.
 *
 * `isGenerated` is always `false`: capture-v2 has no generated-file detection, so the
 * `GENERATED_POLICY` exclusion reason is never produced. The field and the enum member stay in the
 * v1 contract; populating them is deferred rather than dropped.
 */
function capturedSideFromBytes(
  gitMode: "100644" | "100755" | "120000",
  bytes: Uint8Array,
  maxFileBytes: number,
): CapturedSide | "SIZE_LIMIT" {
  if (bytes.length > maxFileBytes) {
    return "SIZE_LIMIT";
  }
  const digest = sha256BytesDigestV1(bytes);
  const byteLength = bytes.length;
  // The content union pairs `kind` with `gitMode`, so the symlink case stays a separate literal.
  const content =
    gitMode === "120000"
      ? ({ kind: "SYMLINK", digest, byteLength, gitMode, isGenerated: false } as const)
      : ({ kind: contentKind(bytes), digest, byteLength, gitMode, isGenerated: false } as const);
  return { content, bytes };
}

/** Signals a broken internal assumption of the capture engine, never a filesystem or Git failure. */
class CaptureInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureInvariantError";
  }
}

/** Describes a read failure without echoing Git or filesystem message text into the manifest. */
function readFailureDetail(error: unknown): string {
  const code =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  return code
    ? `Unable to read captured content during snapshot capture (${code}).`
    : "Unable to read captured content during snapshot capture.";
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
  return capturedSideFromBytes(gitMode, bytes, maxFileBytes);
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
  return capturedSideFromBytes(gitMode, bytes, maxFileBytes);
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

/**
 * Caller exclusions name files or directories. A directory must cover everything beneath it: the
 * CLI excludes packet directories this way, and a prior run's blobs and author packet sit inside
 * one.
 */
function isUnderExcludedPath(path: string, excludedPaths: ReadonlySet<string>): boolean {
  if (excludedPaths.has(path)) {
    return true;
  }
  for (const excluded of excludedPaths) {
    if (path.startsWith(`${excluded}/`)) {
      return true;
    }
  }
  return false;
}

async function collectState(
  repositoryPath: string,
  baseCommit: string,
  headCommit: string,
  captureWorkingTree: boolean,
  includeUntracked: boolean,
  maxFileBytes: number,
  excludedPaths: ReadonlySet<string>,
  excludedPatterns: readonly RegExp[],
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
    const callerExcludedPath = relevantPaths.find((path) =>
      isUnderExcludedPath(path, excludedPaths),
    );
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
        detail: "Excluded by capture-v2 secret filename policy.",
      });
      continue;
    }
    const patternPath = relevantPaths.find((path) =>
      excludedPatterns.some((pattern) => pattern.test(path)),
    );
    if (patternPath) {
      exclusions.push({
        path: patternPath,
        reason: "USER_EXCLUDED",
        detail: "Excluded by a caller-supplied path pattern.",
      });
      continue;
    }
    // Only the reads are guarded: a failure here is a genuine Git or filesystem error and becomes an
    // UNREADABLE omission. Everything after this block is bookkeeping, whose failures are capture
    // bugs and must surface instead of degrading into a silently smaller snapshot.
    let before: CapturedSide | "SIZE_LIMIT" | "UNSUPPORTED_KIND" | null;
    let after: CapturedSide | "SIZE_LIMIT" | "UNSUPPORTED_KIND" | null;
    try {
      before =
        spec.changeType === "ADDED" || spec.changeType === "UNTRACKED"
          ? null
          : await captureTreeSide(
              repositoryPath,
              baseCommit,
              spec.previousPath ?? spec.path,
              maxFileBytes,
            );
      after =
        spec.changeType === "DELETED"
          ? null
          : captureWorkingTree
            ? await captureWorkingSide(repositoryPath, spec.path, maxFileBytes)
            : await captureTreeSide(repositoryPath, headCommit, spec.path, maxFileBytes);
    } catch (error) {
      if (error instanceof CaptureInvariantError) {
        throw error;
      }
      omissions.push({
        scope: spec.path,
        reason: "UNREADABLE",
        detail: readFailureDetail(error),
      });
      continue;
    }
    // Content scanning happens after the read and before anything is admitted to the manifest, so
    // a credential pasted into ordinary source never reaches a blob the packet would transmit.
    const secretMarker = [before, after]
      .filter((side): side is CapturedSide => typeof side === "object" && side !== null)
      .map((side) => secretContentMarker(side.bytes))
      .find((marker) => marker !== undefined);
    if (secretMarker) {
      exclusions.push({
        path: spec.path,
        reason: "SECRET_CONTENT",
        detail: `Excluded by capture-v2 content policy: ${secretMarker} detected.`,
      });
      continue;
    }
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
            : "Git entry kind is not supported by capture-v2.",
      });
      continue;
    }
    if (typeof before === "string" || typeof after === "string") {
      throw new CaptureInvariantError("captured content has an unresolved availability state");
    }
    if (before) {
      const digest = before.content.digest;
      if (!digest) {
        throw new CaptureInvariantError("captured before state has no digest");
      }
      blobs.set(digest.value, before.bytes);
    }
    if (after) {
      const digest = after.content.digest;
      if (!digest) {
        throw new CaptureInvariantError("captured after state has no digest");
      }
      blobs.set(digest.value, after.bytes);
    }
    if (spec.changeType === "ADDED" || spec.changeType === "UNTRACKED") {
      if (!after) {
        throw new CaptureInvariantError("added path has no captured after state");
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
        throw new CaptureInvariantError("deleted path has no captured before state");
      }
      paths.push({ path: spec.path, changeType: "DELETED", before: before.content, after: null });
    } else if (spec.changeType === "RENAMED" || spec.changeType === "COPIED") {
      if (!before || !after || !spec.previousPath) {
        throw new CaptureInvariantError("relocated path has incomplete captured states");
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
        throw new CaptureInvariantError("modified path has incomplete captured states");
      }
      paths.push({
        path: spec.path,
        changeType: spec.changeType,
        before: before.content,
        after: after.content,
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
/** Resolves the worktree root of a repository path, as capture itself resolves it. */
export async function resolveRepositoryRootV1(repositoryPath: string): Promise<string> {
  try {
    return await realpath(
      decodeGitText((await runGit(repositoryPath, ["rev-parse", "--show-toplevel"])).stdout),
    );
  } catch (error) {
    throw new SnapshotCaptureError("NOT_GIT_REPOSITORY", "Repository path is not a Git worktree.", {
      cause: error,
    });
  }
}

/** Reports whether Git ignores a path in the given repository. */
export async function isPathIgnoredV1(
  repositoryPath: string,
  absolutePath: string,
): Promise<boolean> {
  // check-ignore rejects --literal-pathspecs, so this call opts out of it.
  const result = await runGit(
    repositoryPath,
    ["check-ignore", "--quiet", "--", absolutePath],
    [0, 1, 128],
    DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    false,
  );
  return result.exitCode === 0;
}

export async function captureGitSnapshotV1(
  value: unknown,
  options: CaptureGitSnapshotOptionsV1 = {},
): Promise<CapturedGitSnapshotV1> {
  const request = ReviewRequestV1Schema.parse(value) as ReviewRequestV1;
  const repositoryPath = await resolveRepositoryRootV1(request.repository.path);
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
      await mapWithConcurrencyV1(options.excludedFileSystemPaths ?? [], async (absolutePath) => {
        if (!isAbsolute(absolutePath)) {
          throw new TypeError("excludedFileSystemPaths entries must be absolute paths");
        }
        try {
          return await realpath(absolutePath);
        } catch {
          return absolutePath;
        }
      })
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

  const excludedPatterns = compileExclusionPatterns(options.excludedPathPatterns ?? []);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const first = await collectState(
      repositoryPath,
      baseCommit,
      headCommit,
      captureWorkingTree,
      request.repository.workingTree.includeUntracked,
      maxFileBytes,
      excludedPaths,
      excludedPatterns,
    );
    const second = await collectState(
      repositoryPath,
      baseCommit,
      headCommit,
      captureWorkingTree,
      request.repository.workingTree.includeUntracked,
      maxFileBytes,
      excludedPaths,
      excludedPatterns,
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
    const repositoryId = `repo_${sha256BytesDigestV1(Buffer.from(repositoryIdentitySource)).value.slice(0, 24)}`;
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
      policies: { capture: "capture-v2", transmission: "transmission-v1" },
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
