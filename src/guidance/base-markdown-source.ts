import { posix } from "node:path";

import remarkParse from "remark-parse";
import { unified } from "unified";

import { sha256BytesDigestV1, type DigestV1, SnapshotPathV1Schema } from "../contracts/index.js";
import { isSecretPathV1, secretContentScanV1 } from "../snapshot/git-capture.js";
import { runGit } from "../snapshot/git-command.js";

export const MAX_GUIDANCE_SOURCE_BYTES_V1 = 64 * 1024;

export type GuidanceCaptureErrorCode =
  | "GUIDANCE_DISCOVERY_LIMIT_EXCEEDED"
  | "GUIDANCE_INVALID_FRONTMATTER"
  | "GUIDANCE_INVALID_PATTERN"
  | "GUIDANCE_INVALID_UTF8"
  | "GUIDANCE_IMPORT_OCCURRENCE_LIMIT"
  | "GUIDANCE_IMPORT_CYCLE"
  | "GUIDANCE_IMPORT_DEPTH_LIMIT"
  | "GUIDANCE_IMPORT_EDGE_LIMIT"
  | "GUIDANCE_IMPORT_EMPTY"
  | "GUIDANCE_IMPORT_UNRESOLVED"
  | "GUIDANCE_IMPORT_UNSUPPORTED"
  | "GUIDANCE_MARKDOWN_PARSE_FAILED"
  | "GUIDANCE_SECRET_CONTENT"
  | "GUIDANCE_SECRET_PATH"
  | "GUIDANCE_SOURCE_SIZE_LIMIT"
  | "GUIDANCE_SYMLINK_LIMIT"
  | "GUIDANCE_SYMLINK_UNSUPPORTED"
  | "GUIDANCE_UNSUPPORTED_KIND";

/** Content-free failure metadata safe for preflight logs and terminal output. */
export class GuidanceCaptureError extends Error {
  readonly code: GuidanceCaptureErrorCode;
  readonly path: string;
  readonly marker?: string;

  constructor(code: GuidanceCaptureErrorCode, path: string, message: string, marker?: string) {
    super(message);
    this.name = "GuidanceCaptureError";
    this.code = code;
    this.path = path;
    if (marker !== undefined) this.marker = marker;
  }
}

export interface BaseGuidanceBlobMetadataV1 {
  objectId: string;
  mode: string;
  kind: string;
}

export interface BaseMarkdownGuidanceSourceV1 {
  bytes: Uint8Array;
  content: string;
  contentDigest: DigestV1;
}

export interface ResolvedBaseGuidanceBlobV1 {
  resolvedPath: string;
  metadata: BaseGuidanceBlobMetadataV1;
}

const MAX_GUIDANCE_SYMLINKS_V1 = 16;

function parseBaseBlobMetadataRecordV1(record: string): {
  path: string;
  metadata: BaseGuidanceBlobMetadataV1;
} {
  const match = /^(\d{6}) (\w+) ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(record);
  const mode = match?.[1];
  const kind = match?.[2];
  const objectId = match?.[3];
  const path = match?.[4];
  if (mode === undefined || kind === undefined || objectId === undefined || path === undefined) {
    throw new GuidanceCaptureError(
      "GUIDANCE_UNSUPPORTED_KIND",
      "AGENTS.md",
      "Guidance source has invalid BASE object metadata.",
    );
  }
  return { path, metadata: { objectId, mode, kind } };
}

/** Resolves one exact BASE path without reading its content. */
export async function baseGuidanceBlobMetadataV1(
  repositoryPath: string,
  baseCommit: string,
  path: string,
): Promise<BaseGuidanceBlobMetadataV1 | undefined> {
  const listing = await runGit(repositoryPath, ["ls-tree", "-z", baseCommit, "--", path], [0]);
  if (listing.stdout.length === 0) return undefined;
  const record = listing.stdout.toString("utf8").replace(/\0$/, "");
  const parsed = parseBaseBlobMetadataRecordV1(record);
  if (parsed.path !== path) {
    throw new GuidanceCaptureError(
      "GUIDANCE_UNSUPPORTED_KIND",
      path,
      `${path} has invalid BASE object metadata.`,
    );
  }
  return parsed.metadata;
}

/** Resolves one repository-internal symlink chain using frozen BASE objects only. */
export async function resolveBaseGuidanceBlobV1(
  repositoryPath: string,
  baseCommit: string,
  path: string,
): Promise<ResolvedBaseGuidanceBlobV1 | undefined> {
  let currentPath = SnapshotPathV1Schema.parse(path);
  const visited = new Set<string>();
  let followed = 0;
  while (true) {
    if (visited.has(currentPath))
      throw new GuidanceCaptureError(
        "GUIDANCE_SYMLINK_UNSUPPORTED",
        path,
        `${path} has a cyclic BASE symlink chain.`,
      );
    visited.add(currentPath);
    if (isSecretPathV1(currentPath))
      throw new GuidanceCaptureError(
        "GUIDANCE_SECRET_PATH",
        currentPath,
        `${currentPath} is rejected by the snapshot secret-path policy.`,
      );
    const metadata = await baseGuidanceBlobMetadataV1(repositoryPath, baseCommit, currentPath);
    if (!metadata) {
      if (followed === 0) return undefined;
      throw new GuidanceCaptureError(
        "GUIDANCE_SYMLINK_UNSUPPORTED",
        path,
        `${path} has an unresolved BASE symlink target.`,
      );
    }
    if (metadata.mode !== "120000") return { resolvedPath: currentPath, metadata };
    if (metadata.kind !== "blob")
      throw new GuidanceCaptureError(
        "GUIDANCE_SYMLINK_UNSUPPORTED",
        path,
        `${path} has an unsupported BASE symlink object.`,
      );
    followed += 1;
    if (followed > MAX_GUIDANCE_SYMLINKS_V1)
      throw new GuidanceCaptureError(
        "GUIDANCE_SYMLINK_LIMIT",
        path,
        `${path} exceeds the ${MAX_GUIDANCE_SYMLINKS_V1}-link guidance symlink limit.`,
      );
    const sizeResult = await runGit(repositoryPath, ["cat-file", "-s", metadata.objectId]);
    const targetByteLength = Number(sizeResult.stdout.toString("ascii").trim());
    if (!Number.isSafeInteger(targetByteLength) || targetByteLength < 1 || targetByteLength > 4_096)
      throw new GuidanceCaptureError(
        "GUIDANCE_SYMLINK_UNSUPPORTED",
        path,
        `${path} has an invalid or over-limit BASE symlink target.`,
      );
    const targetBytes = (await runGit(repositoryPath, ["cat-file", "blob", metadata.objectId]))
      .stdout;
    if (targetBytes.length !== targetByteLength)
      throw new GuidanceCaptureError(
        "GUIDANCE_SYMLINK_UNSUPPORTED",
        path,
        `${path} changed while reading its frozen BASE symlink object.`,
      );
    let target: string;
    try {
      target = new TextDecoder("utf-8", { fatal: true }).decode(targetBytes);
    } catch {
      throw new GuidanceCaptureError(
        "GUIDANCE_SYMLINK_UNSUPPORTED",
        path,
        `${path} has a non-UTF-8 BASE symlink target.`,
      );
    }
    if (
      target.length === 0 ||
      target.length > 4_096 ||
      posix.isAbsolute(target) ||
      /[\r\n\0]/u.test(target)
    )
      throw new GuidanceCaptureError(
        "GUIDANCE_SYMLINK_UNSUPPORTED",
        path,
        `${path} has an unsupported BASE symlink target.`,
      );
    const resolved = posix.normalize(posix.join(posix.dirname(currentPath), target));
    if (resolved === ".." || resolved.startsWith("../"))
      throw new GuidanceCaptureError(
        "GUIDANCE_SYMLINK_UNSUPPORTED",
        path,
        `${path} has a BASE symlink target outside the repository.`,
      );
    try {
      currentPath = SnapshotPathV1Schema.parse(resolved);
    } catch {
      throw new GuidanceCaptureError(
        "GUIDANCE_SYMLINK_UNSUPPORTED",
        path,
        `${path} has an invalid BASE symlink target.`,
      );
    }
  }
}

/** Lists frozen BASE entries under one literal repository path without reading content. */
export async function listBaseGuidanceBlobMetadataV1(
  repositoryPath: string,
  baseCommit: string,
  path: string,
): Promise<ReadonlyMap<string, BaseGuidanceBlobMetadataV1>> {
  const listing = await runGit(
    repositoryPath,
    ["ls-tree", "-r", "-z", baseCommit, "--", path],
    [0],
  );
  const metadata = new Map<string, BaseGuidanceBlobMetadataV1>();
  for (const record of listing.stdout.toString("utf8").split("\0")) {
    if (record.length === 0) continue;
    const parsed = parseBaseBlobMetadataRecordV1(record);
    metadata.set(parsed.path, parsed.metadata);
  }
  return metadata;
}

/** Reads, secret-checks, and parses one already-selected frozen BASE Markdown source. */
export async function readBaseMarkdownGuidanceSourceV1(
  repositoryPath: string,
  path: string,
  metadata: BaseGuidanceBlobMetadataV1,
): Promise<BaseMarkdownGuidanceSourceV1> {
  if (isSecretPathV1(path)) {
    throw new GuidanceCaptureError(
      "GUIDANCE_SECRET_PATH",
      path,
      `${path} is rejected by the snapshot secret-path policy.`,
    );
  }
  if (metadata.kind !== "blob" || (metadata.mode !== "100644" && metadata.mode !== "100755")) {
    throw new GuidanceCaptureError(
      "GUIDANCE_UNSUPPORTED_KIND",
      path,
      `${path} is not a supported BASE regular file.`,
    );
  }
  const sizeResult = await runGit(repositoryPath, ["cat-file", "-s", metadata.objectId]);
  const byteLength = Number(sizeResult.stdout.toString("ascii").trim());
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new GuidanceCaptureError(
      "GUIDANCE_UNSUPPORTED_KIND",
      path,
      `${path} has invalid BASE object size.`,
    );
  }
  if (byteLength > MAX_GUIDANCE_SOURCE_BYTES_V1) {
    throw new GuidanceCaptureError(
      "GUIDANCE_SOURCE_SIZE_LIMIT",
      path,
      `${path} exceeds the ${MAX_GUIDANCE_SOURCE_BYTES_V1}-byte guidance source limit.`,
    );
  }
  const bytes = (await runGit(repositoryPath, ["cat-file", "blob", metadata.objectId])).stdout;
  if (bytes.length !== byteLength) {
    throw new GuidanceCaptureError(
      "GUIDANCE_UNSUPPORTED_KIND",
      path,
      `${path} changed while reading its frozen BASE object.`,
    );
  }
  const scan = secretContentScanV1(bytes);
  if (scan.status === "MARKER") {
    throw new GuidanceCaptureError(
      "GUIDANCE_SECRET_CONTENT",
      path,
      `${path} is rejected by the snapshot secret-content policy (${scan.label}).`,
      scan.label,
    );
  }
  if (scan.status === "NOT_SCANNED")
    throw new GuidanceCaptureError(
      "GUIDANCE_INVALID_UTF8",
      path,
      `${path} decodes in no supported text encoding, so it cannot be scanned for credentials.`,
    );
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new GuidanceCaptureError("GUIDANCE_INVALID_UTF8", path, `${path} is not valid UTF-8.`);
  }
  try {
    const root = unified().use(remarkParse).parse(content);
    if (
      root.position?.start.offset !== 0 ||
      root.position.end.offset !== content.length ||
      root.position.start.line !== 1 ||
      root.position.start.column !== 1
    ) {
      throw new Error("Markdown root does not cover complete source");
    }
  } catch {
    throw new GuidanceCaptureError(
      "GUIDANCE_MARKDOWN_PARSE_FAILED",
      path,
      `${path} could not be parsed as complete CommonMark.`,
    );
  }
  return { bytes, content, contentDigest: sha256BytesDigestV1(bytes) };
}
