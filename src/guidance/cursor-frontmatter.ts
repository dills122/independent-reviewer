import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { isAlias, isPair, isScalar, parseDocument, visit } from "yaml";

import { GuidanceCaptureError } from "./base-markdown-source.js";

const MAX_FRONTMATTER_BYTES_V1 = 16 * 1024;
const MAX_FRONTMATTER_DEPTH_V1 = 16;
const MAX_FRONTMATTER_NODES_V1 = 256;
const MAX_PATTERNS_PER_SOURCE_V1 = 64;
const MAX_PATTERN_BYTES_V1 = 512;

export interface ParsedCursorFrontmatterV1 {
  mode: "always" | "autoAttached" | "agentRequested" | "manual";
  alwaysApply: boolean;
  globs: string[];
}

function invalidFrontmatter(path: string): never {
  throw new GuidanceCaptureError(
    "GUIDANCE_INVALID_FRONTMATTER",
    path,
    `${path} has invalid or over-limit YAML frontmatter.`,
  );
}

/** Parses bounded Cursor rule metadata and leaves rule prose opaque. */
export function parseCursorFrontmatterV1(path: string, content: string): ParsedCursorFrontmatterV1 {
  let root: Root;
  try {
    root = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).parse(content);
  } catch {
    invalidFrontmatter(path);
  }
  const first = root.children[0];
  if (first?.type !== "yaml") {
    if (/^---(?:\r?\n|$)/u.test(content)) invalidFrontmatter(path);
    return { mode: "manual", alwaysApply: false, globs: [] };
  }
  if (first.position?.start.offset !== 0) invalidFrontmatter(path);
  const end = first.position.end.offset;
  if (end === undefined || Buffer.byteLength(content.slice(0, end)) > MAX_FRONTMATTER_BYTES_V1)
    invalidFrontmatter(path);
  const document = parseDocument(first.value, {
    customTags: [],
    merge: false,
    schema: "failsafe",
    strict: true,
    uniqueKeys: true,
    version: "1.2",
  });
  if (document.errors.length > 0 || document.warnings.length > 0) invalidFrontmatter(path);
  let nodeCount = 0;
  let invalidStructure = false;
  visit(document, (_key, node, ancestors) => {
    nodeCount += 1;
    if (
      nodeCount > MAX_FRONTMATTER_NODES_V1 ||
      ancestors.length > MAX_FRONTMATTER_DEPTH_V1 ||
      isAlias(node) ||
      (isPair(node) && isScalar(node.key) && node.key.value === "<<")
    ) {
      invalidStructure = true;
    }
  });
  if (invalidStructure) invalidFrontmatter(path);
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidFrontmatter(path);
  const metadata = value as Record<string, unknown>;
  const rawAlwaysApply = metadata.alwaysApply;
  if (
    rawAlwaysApply !== undefined &&
    rawAlwaysApply !== true &&
    rawAlwaysApply !== false &&
    rawAlwaysApply !== "true" &&
    rawAlwaysApply !== "false"
  ) {
    invalidFrontmatter(path);
  }
  const alwaysApply = rawAlwaysApply === true || rawAlwaysApply === "true";
  const rawGlobs = metadata.globs;
  let globs: string[];
  if (rawGlobs === undefined || rawGlobs === "") globs = [];
  else if (typeof rawGlobs === "string") globs = [rawGlobs];
  else if (Array.isArray(rawGlobs) && rawGlobs.every((item) => typeof item === "string"))
    globs = [...rawGlobs] as string[];
  else invalidFrontmatter(path);
  if (
    globs.length > MAX_PATTERNS_PER_SOURCE_V1 ||
    globs.some(
      (pattern) => pattern.length === 0 || Buffer.byteLength(pattern) > MAX_PATTERN_BYTES_V1,
    )
  ) {
    invalidFrontmatter(path);
  }
  const description = metadata.description;
  if (description !== undefined && typeof description !== "string") invalidFrontmatter(path);
  const mode = alwaysApply
    ? "always"
    : globs.length > 0
      ? "autoAttached"
      : typeof description === "string" && description.trim().length > 0
        ? "agentRequested"
        : "manual";
  return { mode, alwaysApply, globs };
}
