import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";

import { Language, Parser, Query } from "web-tree-sitter";

import { digestCanonicalJson, sha256Utf8 } from "../contracts/canonical-json.js";
import type { ReviewContextMapV1 } from "../contracts/review-context-map.js";
import type { DigestV1, SnapshotPathEntryV1 } from "../contracts/snapshot-manifest.js";
import { readStrictJsonFileV1 } from "../contracts/strict-json.js";

const require = createRequire(import.meta.url);
const RUNTIME_VERSION = "web-tree-sitter@0.27.0";
const QUERY_VERSION = "declarations-v2";
const POLICY_VERSION = "bounded-v1";
const MAX_SOURCE_BYTE_LENGTH = 512 * 1024;
const MAX_DECLARATION_REGIONS = 512;
const MAX_GRAMMAR_MANIFEST_BYTES = 1024 * 1024;

interface LanguageAdapterV1 {
  languageId: string;
  extensions: readonly string[];
  packageName: string;
  wasmFile: string;
  querySource: string;
}

const LANGUAGE_ADAPTERS: readonly LanguageAdapterV1[] = [
  {
    languageId: "javascript",
    extensions: [".js", ".mjs", ".cjs", ".jsx"],
    packageName: "tree-sitter-javascript",
    wasmFile: "tree-sitter-javascript.wasm",
    querySource: `[
      (function_declaration name: (identifier) @name) @decl
      (generator_function_declaration name: (identifier) @name) @decl
      (class_declaration name: (identifier) @name) @decl
      (method_definition name: (property_identifier) @name) @decl
      (variable_declarator
        name: (identifier) @name
        value: [(arrow_function) (function_expression) (generator_function)]) @decl
    ]`,
  },
  {
    languageId: "typescript",
    extensions: [".ts", ".mts", ".cts"],
    packageName: "tree-sitter-typescript",
    wasmFile: "tree-sitter-typescript.wasm",
    querySource: `[
      (function_declaration name: (identifier) @name) @decl
      (generator_function_declaration name: (identifier) @name) @decl
      (class_declaration name: (type_identifier) @name) @decl
      (abstract_class_declaration name: (type_identifier) @name) @decl
      (interface_declaration name: (type_identifier) @name) @decl
      (type_alias_declaration name: (type_identifier) @name) @decl
      (enum_declaration name: (identifier) @name) @decl
      (method_definition name: (property_identifier) @name) @decl
      (variable_declarator
        name: (identifier) @name
        value: [(arrow_function) (function_expression) (generator_function)]) @decl
    ]`,
  },
  {
    languageId: "tsx",
    extensions: [".tsx"],
    packageName: "tree-sitter-typescript",
    wasmFile: "tree-sitter-tsx.wasm",
    querySource: `[
      (function_declaration name: (identifier) @name) @decl
      (generator_function_declaration name: (identifier) @name) @decl
      (class_declaration name: (type_identifier) @name) @decl
      (abstract_class_declaration name: (type_identifier) @name) @decl
      (interface_declaration name: (type_identifier) @name) @decl
      (type_alias_declaration name: (type_identifier) @name) @decl
      (enum_declaration name: (identifier) @name) @decl
      (method_definition name: (property_identifier) @name) @decl
      (variable_declarator
        name: (identifier) @name
        value: [(arrow_function) (function_expression) (generator_function)]) @decl
    ]`,
  },
  {
    languageId: "python",
    extensions: [".py", ".pyi"],
    packageName: "tree-sitter-python",
    wasmFile: "tree-sitter-python.wasm",
    querySource: `[
      (function_definition name: (identifier) @name) @decl
      (class_definition name: (identifier) @name) @decl
    ]`,
  },
  {
    languageId: "go",
    extensions: [".go"],
    packageName: "tree-sitter-go",
    wasmFile: "tree-sitter-go.wasm",
    querySource: `[
      (function_declaration name: (identifier) @name) @decl
      (method_declaration name: (field_identifier) @name) @decl
      (type_spec name: (type_identifier) @name) @decl
      (type_alias name: (type_identifier) @name) @decl
    ]`,
  },
  {
    languageId: "java",
    extensions: [".java"],
    packageName: "tree-sitter-java",
    wasmFile: "tree-sitter-java.wasm",
    querySource: `[
      (class_declaration name: (identifier) @name) @decl
      (interface_declaration name: (identifier) @name) @decl
      (record_declaration name: (identifier) @name) @decl
      (method_declaration name: (identifier) @name) @decl
    ]`,
  },
];

export interface SourceAnalysisInputV1 {
  path: string;
  source: string;
  fileDigest: DigestV1;
  side: "BASE" | "HEAD";
  origin: "CHANGED_PATH" | "SUPPORTING_CONTEXT";
  role?: SnapshotPathEntryV1["role"];
}

export interface SourceAnalysisResultV1 {
  producer: ReviewContextMapV1["producers"][number];
  regions: ReviewContextMapV1["regions"];
}

interface LoadedAdapterV1 {
  adapter: LanguageAdapterV1;
  language: Language;
  query: Query;
  producerVersion: string;
}

let initialization: Promise<void> | undefined;

function initializeParser(): Promise<void> {
  initialization ??= Parser.init();
  return initialization;
}

function adapterForPath(path: string): LanguageAdapterV1 | undefined {
  const extension = extname(path).toLowerCase();
  return LANGUAGE_ADAPTERS.find((adapter) => adapter.extensions.includes(extension));
}

function producerId(languageId: string): string {
  return `producer_tree_sitter_${languageId}`;
}

function regionId(
  input: SourceAnalysisInputV1,
  languageId: string,
  start: number,
  end: number,
): string {
  return `region_${digestCanonicalJson({
    fileDigest: input.fileDigest,
    languageId,
    origin: input.origin,
    path: input.path,
    side: input.side,
    start,
    end,
    queryVersion: QUERY_VERSION,
    policyVersion: POLICY_VERSION,
  }).value.slice(0, 24)}`;
}

/**
 * Reads a grammar package's own declared version, so provenance cannot disagree with the WASM.
 *
 * Through the strict reader like every other JSON this process admits: native `JSON.parse` is
 * deliberately confined to a reviewed allowlist, asserted by `test/contracts/strict-json.test.ts`.
 */
async function grammarPackageVersion(
  packageJsonPath: string,
  packageName: string,
): Promise<string> {
  const parsed = await readStrictJsonFileV1(packageJsonPath, {
    maxBytes: MAX_GRAMMAR_MANIFEST_BYTES,
    source: `${packageName} package manifest`,
  });
  const version =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { version?: unknown }).version
      : undefined;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`${packageName} does not declare a version at ${packageJsonPath}.`);
  }
  return version;
}

export class TreeSitterContextAnalyzerV1 {
  readonly #loaded = new Map<string, LoadedAdapterV1>();
  #disposed = false;

  private constructor() {}

  static async create(): Promise<TreeSitterContextAnalyzerV1> {
    await initializeParser();
    return new TreeSitterContextAnalyzerV1();
  }

  async #load(adapter: LanguageAdapterV1): Promise<LoadedAdapterV1> {
    const cached = this.#loaded.get(adapter.languageId);
    if (cached) return cached;
    // The version is read from the same package.json the WASM is loaded from, never from a
    // literal beside the adapter. A hand-maintained copy drifts the moment the dependency is
    // bumped, and it had: the JavaScript adapter recorded 0.23.1 (the nested copy under
    // tree-sitter-typescript) while require.resolve loaded 0.25.0 (#137).
    const packageJsonPath = require.resolve(`${adapter.packageName}/package.json`);
    const packageRoot = dirname(packageJsonPath);
    const packageVersion = await grammarPackageVersion(packageJsonPath, adapter.packageName);
    const language = await Language.load(join(packageRoot, adapter.wasmFile));
    const query = new Query(language, adapter.querySource);
    const loaded = {
      adapter,
      language,
      query,
      producerVersion: `${RUNTIME_VERSION};${adapter.packageName}@${packageVersion};abi-${language.abiVersion};${QUERY_VERSION};${POLICY_VERSION}`,
    };
    this.#loaded.set(adapter.languageId, loaded);
    return loaded;
  }

  async analyze(input: SourceAnalysisInputV1): Promise<SourceAnalysisResultV1> {
    if (this.#disposed) throw new Error("Tree-sitter analyzer is disposed");
    if (
      input.fileDigest.algorithm !== "SHA256" ||
      input.fileDigest.value !== sha256Utf8(input.source).value
    ) {
      throw new Error("Tree-sitter source does not match its frozen content digest");
    }
    const adapter = adapterForPath(input.path);
    if (!adapter) {
      return {
        producer: {
          producerId: producerId("unsupported"),
          producerVersion: `${RUNTIME_VERSION};${QUERY_VERSION};${POLICY_VERSION}`,
          status: "UNSUPPORTED",
          diagnostics: [
            `No Tree-sitter language adapter for ${extname(input.path) || "extensionless path"}.`,
          ],
        },
        regions: [],
      };
    }

    const loaded = await this.#load(adapter);
    const sourceByteLength = Buffer.byteLength(input.source, "utf8");
    if (sourceByteLength > MAX_SOURCE_BYTE_LENGTH) {
      return {
        producer: {
          producerId: producerId(adapter.languageId),
          producerVersion: loaded.producerVersion,
          status: "PARTIAL",
          diagnostics: [
            `Tree-sitter skipped declaration parsing for ${input.path}: UTF-8 source is ${sourceByteLength} bytes, exceeding the ${MAX_SOURCE_BYTE_LENGTH}-byte limit. Universal file-level fallback remains available.`,
          ],
        },
        regions: [],
      };
    }
    const parser = new Parser();
    let tree: ReturnType<Parser["parse"]> | undefined;
    try {
      parser.setLanguage(loaded.language);
      tree = parser.parse(input.source);
      if (!tree) throw new Error(`Tree-sitter did not produce a tree for ${input.path}.`);
      const syntaxError = tree.rootNode.hasError;
      let declarationLimitReached = false;
      const seen = new Set<string>();
      const regions: ReviewContextMapV1["regions"] = [];
      for (const match of loaded.query.matches(tree.rootNode)) {
        const declaration = match.captures.find((capture) => capture.name === "decl")?.node;
        const name = match.captures.find((capture) => capture.name === "name")?.node.text;
        if (!declaration || !name) continue;
        const key = `${declaration.startIndex}:${declaration.endIndex}`;
        if (seen.has(key)) continue;
        if (regions.length >= MAX_DECLARATION_REGIONS) {
          declarationLimitReached = true;
          break;
        }
        seen.add(key);
        regions.push({
          regionId: regionId(
            input,
            adapter.languageId,
            declaration.startIndex,
            declaration.endIndex,
          ),
          origin: input.origin,
          path: input.path,
          side: input.side,
          fileDigest: input.fileDigest,
          byteLength: sourceByteLength,
          ...(input.role ? { role: input.role } : {}),
          languageId: adapter.languageId,
          kind: "DECLARATION",
          range: {
            coordinateUnit: "UTF16_CODE_UNIT",
            startOffset: declaration.startIndex,
            endOffsetExclusive: declaration.endIndex,
            contentByteLength: Buffer.byteLength(
              input.source.slice(declaration.startIndex, declaration.endIndex),
              "utf8",
            ),
            startLine: declaration.startPosition.row + 1,
            startColumn: declaration.startPosition.column,
            endLine: declaration.endPosition.row + 1,
            endColumn: declaration.endPosition.column,
          },
          producerId: producerId(adapter.languageId),
          producerKind: "TREE_SITTER_DECLARATION_QUERY",
          displayName: name,
        });
      }
      regions.sort((left, right) => {
        const leftStart = left.range?.startOffset ?? 0;
        const rightStart = right.range?.startOffset ?? 0;
        return leftStart - rightStart || left.regionId.localeCompare(right.regionId);
      });
      const diagnostics: string[] = [];
      if (syntaxError) {
        diagnostics.push(`Tree-sitter reported recoverable syntax errors in ${input.path}.`);
      }
      if (declarationLimitReached) {
        diagnostics.push(
          `Tree-sitter declaration output for ${input.path} was truncated at ${MAX_DECLARATION_REGIONS} regions. Universal file-level fallback remains available.`,
        );
      }
      return {
        producer: {
          producerId: producerId(adapter.languageId),
          producerVersion: loaded.producerVersion,
          status: syntaxError || declarationLimitReached ? "PARTIAL" : "COMPLETE",
          diagnostics,
        },
        regions,
      };
    } finally {
      tree?.delete();
      parser.delete();
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const loaded of this.#loaded.values()) loaded.query.delete();
    this.#loaded.clear();
  }
}

export async function createTreeSitterContextAnalyzerV1(): Promise<TreeSitterContextAnalyzerV1> {
  return TreeSitterContextAnalyzerV1.create();
}
