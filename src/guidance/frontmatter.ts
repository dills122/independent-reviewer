import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkParse from "remark-parse";
import { isAlias, isPair, isScalar, parseDocument, visit } from "yaml";
import { unified } from "unified";

import { GuidanceCaptureError } from "./base-markdown-source.js";

const MAX_FRONTMATTER_BYTES_V1 = 16 * 1024;
const MAX_FRONTMATTER_DEPTH_V1 = 16;
const MAX_FRONTMATTER_NODES_V1 = 256;
const MAX_PATTERNS_PER_SOURCE_V1 = 64;
const MAX_PATTERN_BYTES_V1 = 512;

export interface ParsedGuidanceFrontmatterV1 {
  paths?: string[];
}

function invalidFrontmatter(path: string): never {
  throw new GuidanceCaptureError(
    "GUIDANCE_INVALID_FRONTMATTER",
    path,
    `${path} has invalid or over-limit YAML frontmatter.`,
  );
}

/** Parses one leading YAML frontmatter block without widening family policy. */
export function parseGuidanceFrontmatterV1(
  path: string,
  content: string,
): ParsedGuidanceFrontmatterV1 {
  let root: Root;
  try {
    root = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).parse(content);
  } catch {
    invalidFrontmatter(path);
  }
  const first = root.children[0];
  if (first?.type !== "yaml") {
    if (/^---(?:\r?\n|$)/.test(content)) invalidFrontmatter(path);
    return {};
  }
  const start = first.position?.start.offset;
  const end = first.position?.end.offset;
  if (
    start !== 0 ||
    end === undefined ||
    Buffer.byteLength(content.slice(start, end)) > MAX_FRONTMATTER_BYTES_V1
  )
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
      (isPair(node) && isScalar(node.key) && node.key.value === "<<") ||
      (typeof node === "object" &&
        node !== null &&
        "tag" in node &&
        typeof node.tag === "string" &&
        !node.tag.startsWith("tag:yaml.org,2002:"))
    ) {
      invalidStructure = true;
    }
  });
  if (invalidStructure) invalidFrontmatter(path);

  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidFrontmatter(path);
  const paths = (value as Record<string, unknown>).paths;
  if (paths === undefined) return {};
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.length > MAX_PATTERNS_PER_SOURCE_V1 ||
    paths.some(
      (pattern) =>
        typeof pattern !== "string" ||
        pattern.length === 0 ||
        Buffer.byteLength(pattern) > MAX_PATTERN_BYTES_V1,
    )
  ) {
    invalidFrontmatter(path);
  }
  return { paths: [...paths] as string[] };
}
