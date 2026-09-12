import remarkParse from "remark-parse";
import { unified } from "unified";

import {
  buildReviewerRulesGuidanceGraphV1,
  createGuidanceDiagnosticV1,
  type GuidanceGraphV1,
  type SnapshotManifestV1,
  sha256BytesDigestV1,
} from "../contracts/index.js";
import { isSecretPathV1, secretContentScanV1 } from "../snapshot/git-capture.js";
import { runGit } from "../snapshot/git-command.js";

export const REVIEWER_RULES_PATH_V1 = ".independent-reviewer/rules.md";
export const MAX_GUIDANCE_SOURCE_BYTES_V1 = 64 * 1024;

export type GuidanceCaptureErrorCode =
  | "GUIDANCE_INVALID_UTF8"
  | "GUIDANCE_MARKDOWN_PARSE_FAILED"
  | "GUIDANCE_SECRET_CONTENT"
  | "GUIDANCE_SECRET_PATH"
  | "GUIDANCE_SOURCE_SIZE_LIMIT"
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

export interface CapturedReviewerRulesGuidanceV1 {
  graph: GuidanceGraphV1;
  blobs: ReadonlyMap<string, Uint8Array>;
}

interface BaseBlobV1 {
  bytes: Uint8Array;
  mode: string;
}

async function readBaseBlob(
  repositoryPath: string,
  baseCommit: string,
): Promise<BaseBlobV1 | undefined> {
  const listing = await runGit(
    repositoryPath,
    ["ls-tree", "-z", baseCommit, "--", REVIEWER_RULES_PATH_V1],
    [0],
  );
  if (listing.stdout.length === 0) return undefined;
  const record = listing.stdout.toString("utf8").replace(/\0$/, "");
  const match = /^(\d{6}) (\w+) ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(record);
  if (match?.[2] !== "blob" || match[4] !== REVIEWER_RULES_PATH_V1) {
    throw new GuidanceCaptureError(
      "GUIDANCE_UNSUPPORTED_KIND",
      REVIEWER_RULES_PATH_V1,
      `${REVIEWER_RULES_PATH_V1} is not a supported BASE regular file.`,
    );
  }
  const [, mode, , objectId] = match;
  if ((mode !== "100644" && mode !== "100755") || objectId === undefined) {
    throw new GuidanceCaptureError(
      "GUIDANCE_UNSUPPORTED_KIND",
      REVIEWER_RULES_PATH_V1,
      `${REVIEWER_RULES_PATH_V1} is not a supported BASE regular file.`,
    );
  }
  const sizeResult = await runGit(repositoryPath, ["cat-file", "-s", objectId]);
  const byteLength = Number(sizeResult.stdout.toString("ascii").trim());
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new GuidanceCaptureError(
      "GUIDANCE_UNSUPPORTED_KIND",
      REVIEWER_RULES_PATH_V1,
      `${REVIEWER_RULES_PATH_V1} has invalid BASE object metadata.`,
    );
  }
  if (byteLength > MAX_GUIDANCE_SOURCE_BYTES_V1) {
    throw new GuidanceCaptureError(
      "GUIDANCE_SOURCE_SIZE_LIMIT",
      REVIEWER_RULES_PATH_V1,
      `${REVIEWER_RULES_PATH_V1} exceeds the ${MAX_GUIDANCE_SOURCE_BYTES_V1}-byte guidance source limit.`,
    );
  }
  const bytes = (await runGit(repositoryPath, ["cat-file", "blob", objectId])).stdout;
  if (bytes.length !== byteLength) {
    throw new GuidanceCaptureError(
      "GUIDANCE_UNSUPPORTED_KIND",
      REVIEWER_RULES_PATH_V1,
      `${REVIEWER_RULES_PATH_V1} changed while reading its frozen BASE object.`,
    );
  }
  return { bytes, mode };
}

function parseWholeMarkdown(bytes: Uint8Array): string {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new GuidanceCaptureError(
      "GUIDANCE_INVALID_UTF8",
      REVIEWER_RULES_PATH_V1,
      `${REVIEWER_RULES_PATH_V1} is not valid UTF-8.`,
    );
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
      REVIEWER_RULES_PATH_V1,
      `${REVIEWER_RULES_PATH_V1} could not be parsed as complete CommonMark.`,
    );
  }
  return content;
}

/** Captures only explicit reviewer rules from frozen BASE; no harness discovery occurs here. */
export async function captureReviewerRulesGuidanceV1(
  repositoryPath: string,
  manifest: SnapshotManifestV1,
): Promise<CapturedReviewerRulesGuidanceV1> {
  if (isSecretPathV1(REVIEWER_RULES_PATH_V1)) {
    throw new GuidanceCaptureError(
      "GUIDANCE_SECRET_PATH",
      REVIEWER_RULES_PATH_V1,
      `${REVIEWER_RULES_PATH_V1} is rejected by the snapshot secret-path policy.`,
    );
  }
  const source = await readBaseBlob(repositoryPath, manifest.source.baseCommit);
  if (!source) {
    return { graph: buildReviewerRulesGuidanceGraphV1(manifest), blobs: new Map() };
  }
  // Guidance fails closed on anything the content policy could not clear: an unscannable source is
  // rejected rather than admitted, since this text goes into the prompt as instructions.
  const scan = secretContentScanV1(source.bytes);
  if (scan.status === "MARKER") {
    throw new GuidanceCaptureError(
      "GUIDANCE_SECRET_CONTENT",
      REVIEWER_RULES_PATH_V1,
      `${REVIEWER_RULES_PATH_V1} is rejected by the snapshot secret-content policy (${scan.label}).`,
      scan.label,
    );
  }
  if (scan.status === "NOT_SCANNED") {
    throw new GuidanceCaptureError(
      "GUIDANCE_INVALID_UTF8",
      REVIEWER_RULES_PATH_V1,
      `${REVIEWER_RULES_PATH_V1} decodes in no supported text encoding, so it cannot be scanned for credentials.`,
    );
  }
  const content = parseWholeMarkdown(source.bytes);
  if (content.trim().length === 0) {
    const diagnostic = createGuidanceDiagnosticV1({
      code: "EMPTY_SOURCE",
      severity: "WARNING",
      path: REVIEWER_RULES_PATH_V1,
      startUtf16: 0,
      omittedCount: null,
    });
    return {
      graph: buildReviewerRulesGuidanceGraphV1(manifest, undefined, [diagnostic]),
      blobs: new Map(),
    };
  }
  const contentDigest = sha256BytesDigestV1(source.bytes);
  return {
    graph: buildReviewerRulesGuidanceGraphV1(manifest, contentDigest),
    blobs: new Map([[contentDigest.value, Uint8Array.from(source.bytes)]]),
  };
}
