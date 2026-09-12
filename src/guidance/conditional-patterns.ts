import braces from "braces";
import picomatch from "picomatch";

import { SnapshotPathV1Schema } from "../contracts/index.js";
import { GuidanceCaptureError } from "./base-markdown-source.js";

const MAX_PATTERNS_PER_SOURCE_V1 = 64;
const MAX_PATTERN_BYTES_V1 = 512;
const MAX_BRACE_GROUPS_V1 = 8;
const MAX_BRACE_EXPANSION_PRODUCT_V1 = 256;
const MAX_MATCHER_ALTERNATIVES_V1 = 1_024;

interface BraceAstNodeV1 {
  type: string;
  commas?: number;
  invalid?: boolean;
  ranges?: number;
  nodes?: BraceAstNodeV1[];
}

interface BracesApiV1 {
  (pattern: string, options?: braces.Options): string[];
  expand(
    pattern: string | BraceAstNodeV1,
    options?: braces.Options & { noempty?: boolean },
  ): string[];
  parse(pattern: string, options?: braces.Options): BraceAstNodeV1;
}

const bracesApi = braces as BracesApiV1;

function invalidPattern(path: string): never {
  throw new GuidanceCaptureError(
    "GUIDANCE_INVALID_PATTERN",
    path,
    `${path} has invalid or over-limit conditional guidance patterns.`,
  );
}

function braceExpansionProduct(path: string, ast: BraceAstNodeV1): number {
  let groups = 0;
  let product = 1;
  const visit = (node: BraceAstNodeV1) => {
    if (node.invalid) invalidPattern(path);
    if (node.type === "brace") {
      groups += 1;
      if (groups > MAX_BRACE_GROUPS_V1) invalidPattern(path);
      const alternatives =
        (node.ranges ?? 0) > 0
          ? bracesApi.expand(node, {
              maxLength: MAX_PATTERN_BYTES_V1,
              noempty: false,
              nodupes: true,
              rangeLimit: MAX_BRACE_EXPANSION_PRODUCT_V1,
            }).length
          : (node.commas ?? 0) + 1;
      if (
        alternatives > MAX_BRACE_EXPANSION_PRODUCT_V1 ||
        product > Math.floor(MAX_BRACE_EXPANSION_PRODUCT_V1 / alternatives)
      ) {
        invalidPattern(path);
      }
      product *= alternatives;
    }
    for (const child of node.nodes ?? []) visit(child);
  };
  visit(ast);
  return product;
}

/** Compiles bounded family-normalized path patterns into one case-sensitive matcher. */
export function compileGuidancePatternsV1(
  path: string,
  patterns: readonly string[],
): (candidatePath: string) => boolean {
  if (patterns.length === 0 || patterns.length > MAX_PATTERNS_PER_SOURCE_V1) invalidPattern(path);
  const expanded: string[] = [];
  for (const pattern of patterns) {
    if (
      pattern.length === 0 ||
      Buffer.byteLength(pattern) > MAX_PATTERN_BYTES_V1 ||
      pattern.startsWith("/") ||
      pattern.split("/").includes("..") ||
      /[\\\r\n\0]/.test(pattern) ||
      /[?*+@!]\(/.test(pattern)
    ) {
      invalidPattern(path);
    }
    try {
      const ast = bracesApi.parse(pattern, { maxLength: MAX_PATTERN_BYTES_V1 });
      braceExpansionProduct(path, ast);
      expanded.push(
        ...bracesApi.expand(pattern, {
          maxLength: MAX_PATTERN_BYTES_V1,
          noempty: false,
          nodupes: true,
          rangeLimit: MAX_BRACE_EXPANSION_PRODUCT_V1,
        }),
      );
    } catch (error) {
      if (error instanceof GuidanceCaptureError) throw error;
      invalidPattern(path);
    }
    if (expanded.length > MAX_MATCHER_ALTERNATIVES_V1) invalidPattern(path);
  }

  let matcher: ReturnType<typeof picomatch>;
  try {
    matcher = picomatch(expanded, {
      dot: true,
      nocase: false,
      nobrace: true,
      noextglob: true,
      nonegate: true,
      posix: true,
      strictBrackets: true,
      windows: false,
    });
  } catch {
    invalidPattern(path);
  }
  return (candidatePath) => matcher(SnapshotPathV1Schema.parse(candidatePath));
}
