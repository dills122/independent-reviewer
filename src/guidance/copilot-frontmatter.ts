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

export interface ParsedCopilotFrontmatterV1 {
  applyTo: string[];
  excludesCodeReview: boolean;
}

function invalidFrontmatter(path: string): never {
  throw new GuidanceCaptureError(
    "GUIDANCE_INVALID_FRONTMATTER",
    path,
    `${path} has invalid or over-limit YAML frontmatter.`,
  );
}

function parseLeadingYaml(path: string, content: string): Record<string, unknown> {
  let root: Root;
  try {
    root = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).parse(content);
  } catch {
    invalidFrontmatter(path);
  }
  const first = root.children[0];
  if (first?.type !== "yaml" || first.position?.start.offset !== 0) invalidFrontmatter(path);
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
  return value as Record<string, unknown>;
}

/** Parses Copilot modular-instruction metadata without assigning semantic policy. */
export function parseCopilotFrontmatterV1(
  path: string,
  content: string,
): ParsedCopilotFrontmatterV1 {
  const value = parseLeadingYaml(path, content);
  if (typeof value.applyTo !== "string") invalidFrontmatter(path);
  const applyTo = value.applyTo.split(",").map((pattern) => pattern.trim());
  if (
    applyTo.length === 0 ||
    applyTo.length > MAX_PATTERNS_PER_SOURCE_V1 ||
    applyTo.some(
      (pattern) => pattern.length === 0 || Buffer.byteLength(pattern) > MAX_PATTERN_BYTES_V1,
    )
  ) {
    invalidFrontmatter(path);
  }
  const excludeAgent = value.excludeAgent;
  if (
    excludeAgent !== undefined &&
    typeof excludeAgent !== "string" &&
    (!Array.isArray(excludeAgent) || excludeAgent.some((item) => typeof item !== "string"))
  ) {
    invalidFrontmatter(path);
  }
  const excluded = typeof excludeAgent === "string" ? [excludeAgent] : (excludeAgent ?? []);
  return {
    applyTo,
    excludesCodeReview: excluded.some((agent) => agent.trim() === "code-review"),
  };
}
