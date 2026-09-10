import { dirname, join, normalize } from "node:path/posix";

/**
 * Locates the unchanged files a changed file imports, so a review can judge a call against the
 * contract it targets instead of guessing.
 *
 * Only relative specifiers resolve. A bare specifier is a package, whose source is not part of the
 * repository under review, and an absolute specifier is not portable evidence.
 */

/** TypeScript and JavaScript only; other ecosystems need their own resolver before they qualify. */
const RESOLVABLE_EXTENSIONS_V1 = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".d.ts",
] as const;

/** Extensions a specifier may carry that stand in for a TypeScript source under Node16 resolution. */
const COMPILED_EXTENSION_SUBSTITUTIONS_V1: ReadonlyMap<string, readonly string[]> = new Map([
  [".js", [".ts", ".tsx", ".js", ".jsx", ".d.ts"]],
  [".mjs", [".mts", ".mjs", ".d.mts"]],
  [".cjs", [".cts", ".cjs", ".d.cts"]],
  [".jsx", [".tsx", ".jsx"]],
]);

/**
 * Matches the specifier of a static import/export, a dynamic `import()`, and a `require()`.
 *
 * Comments and string literals are not parsed away. A false positive costs one extra captured file
 * that the reviewer may ignore; missing a real import costs a defect, so the trade favours recall.
 */
const SPECIFIER_PATTERN_V1 =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])([^"']+)\1/g;

/** Relative specifiers a source imports, in first-seen order and without duplicates. */
export function relativeImportSpecifiersV1(source: string): string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(SPECIFIER_PATTERN_V1)) {
    const specifier = match[2];
    if (specifier && (specifier.startsWith("./") || specifier.startsWith("../"))) {
      specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

function extensionOf(specifier: string): string {
  if (specifier.endsWith(".d.ts")) return ".d.ts";
  const index = specifier.lastIndexOf(".");
  const slash = specifier.lastIndexOf("/");
  return index > slash ? specifier.slice(index) : "";
}

/** Repository-relative paths a specifier could name, most specific first. */
export function candidateReferencedPathsV1(fromPath: string, specifier: string): string[] {
  const target = normalize(join(dirname(fromPath), specifier));
  if (target.startsWith("..")) {
    // Escapes the repository root, so it is not capturable evidence.
    return [];
  }
  const extension = extensionOf(specifier);
  const candidates: string[] = [];
  const push = (path: string) => {
    if (!candidates.includes(path)) candidates.push(path);
  };
  if (extension === "") {
    for (const suffix of RESOLVABLE_EXTENSIONS_V1) push(`${target}${suffix}`);
    // A directory is only a candidate for a specifier that names no file extension.
    for (const suffix of RESOLVABLE_EXTENSIONS_V1) push(`${target}/index${suffix}`);
    return candidates;
  }
  for (const suffix of COMPILED_EXTENSION_SUBSTITUTIONS_V1.get(extension) ?? []) {
    push(`${target.slice(0, target.length - extension.length)}${suffix}`);
  }
  // A specifier naming a TypeScript source directly, and the literal path as written.
  push(target);
  return candidates;
}

/**
 * Resolves each relative specifier against the paths the snapshot can actually read.
 *
 * `available` reports whether a repository-relative path exists on the reviewed side. The first
 * candidate it accepts wins, matching the resolver order TypeScript and Node apply.
 */
export function resolveReferencedPathsV1(
  fromPath: string,
  source: string,
  available: (path: string) => boolean,
): string[] {
  const resolved: string[] = [];
  for (const specifier of relativeImportSpecifiersV1(source)) {
    const match = candidateReferencedPathsV1(fromPath, specifier).find((candidate) =>
      available(candidate),
    );
    if (match !== undefined && !resolved.includes(match)) {
      resolved.push(match);
    }
  }
  return resolved;
}
