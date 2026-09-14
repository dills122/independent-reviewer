import { type Node as JsonNode, type ParseError, parseTree } from "jsonc-parser";

import { GuidanceCaptureError } from "./base-markdown-source.js";

const MAX_SETTINGS_BYTES_V1 = 64 * 1024;
const MAX_SETTINGS_DEPTH_V1 = 16;
const MAX_SETTINGS_NODES_V1 = 256;
const MAX_CONTEXT_FILE_NAMES_V1 = 8;
const MAX_CONTEXT_FILE_NAME_BYTES_V1 = 128;

export interface ParsedGeminiSettingsV1 {
  contextFileNames: string[];
  respectGitIgnore: boolean;
  respectGeminiIgnore: boolean;
  unknownSettingOffsets: number[];
}

function invalidSettings(path: string): never {
  throw new GuidanceCaptureError(
    "GUIDANCE_UNSUPPORTED_KIND",
    path,
    `${path} has invalid or over-limit Gemini settings.`,
  );
}

function properties(path: string, node: JsonNode | undefined): Map<string, JsonNode> {
  if (node?.type !== "object") invalidSettings(path);
  const result = new Map<string, JsonNode>();
  for (const property of node.children ?? []) {
    const keyNode = property.children?.[0];
    const valueNode = property.children?.[1];
    if (property.type !== "property" || keyNode?.type !== "string" || !valueNode)
      invalidSettings(path);
    const key = keyNode.value;
    if (typeof key !== "string" || result.has(key)) invalidSettings(path);
    result.set(key, valueNode);
  }
  return result;
}

function assertTreeLimits(path: string, root: JsonNode): void {
  let count = 0;
  const walk = (node: JsonNode, depth: number) => {
    count += 1;
    if (count > MAX_SETTINGS_NODES_V1 || depth > MAX_SETTINGS_DEPTH_V1) invalidSettings(path);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(root, 1);
}

function parseContextFileNames(path: string, node: JsonNode | undefined): string[] {
  if (!node) return ["GEMINI.md"];
  const names =
    node.type === "string"
      ? [node.value]
      : node.type === "array"
        ? (node.children ?? []).map((child) => (child.type === "string" ? child.value : undefined))
        : [];
  if (
    names.length === 0 ||
    names.length > MAX_CONTEXT_FILE_NAMES_V1 ||
    names.some(
      (name) =>
        typeof name !== "string" ||
        name.length === 0 ||
        name === "." ||
        name === ".." ||
        name.includes("/") ||
        name.includes("\\") ||
        /[\r\n\0]/u.test(name) ||
        Buffer.byteLength(name) > MAX_CONTEXT_FILE_NAME_BYTES_V1,
    )
  ) {
    invalidSettings(path);
  }
  return [...new Set(names as string[])];
}

function booleanSetting(path: string, node: JsonNode | undefined, fallback: boolean): boolean {
  if (!node) return fallback;
  if (node.type !== "boolean" || typeof node.value !== "boolean") invalidSettings(path);
  return node.value;
}

/** Parses the bounded deterministic subset of frozen Gemini settings. */
export function parseGeminiSettingsV1(path: string, content: string): ParsedGeminiSettingsV1 {
  if (Buffer.byteLength(content) > MAX_SETTINGS_BYTES_V1) invalidSettings(path);
  const errors: ParseError[] = [];
  const root = parseTree(content, errors, {
    allowEmptyContent: false,
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (!root || errors.length > 0) invalidSettings(path);
  assertTreeLimits(path, root);

  const unknownSettingOffsets: number[] = [];
  const rootProperties = properties(path, root);
  for (const [key] of rootProperties) {
    if (key !== "context") {
      const property = root.children?.find((candidate) => candidate.children?.[0]?.value === key);
      if (property) unknownSettingOffsets.push(property.offset);
    }
  }

  const contextNode = rootProperties.get("context");
  const contextProperties = contextNode
    ? properties(path, contextNode)
    : new Map<string, JsonNode>();
  for (const [key] of contextProperties) {
    if (key !== "fileName" && key !== "fileFiltering") {
      const property = contextNode?.children?.find(
        (candidate) => candidate.children?.[0]?.value === key,
      );
      if (property) unknownSettingOffsets.push(property.offset);
    }
  }

  const filteringNode = contextProperties.get("fileFiltering");
  const filteringProperties = filteringNode
    ? properties(path, filteringNode)
    : new Map<string, JsonNode>();
  for (const [key] of filteringProperties) {
    if (key !== "respectGitIgnore" && key !== "respectGeminiIgnore") {
      const property = filteringNode?.children?.find(
        (candidate) => candidate.children?.[0]?.value === key,
      );
      if (property) unknownSettingOffsets.push(property.offset);
    }
  }

  return {
    contextFileNames: parseContextFileNames(path, contextProperties.get("fileName")),
    respectGitIgnore: booleanSetting(path, filteringProperties.get("respectGitIgnore"), true),
    respectGeminiIgnore: booleanSetting(path, filteringProperties.get("respectGeminiIgnore"), true),
    unknownSettingOffsets: unknownSettingOffsets.sort((left, right) => left - right),
  };
}
