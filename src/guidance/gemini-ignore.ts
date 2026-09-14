import { posix } from "node:path";

import createIgnore from "ignore";

export interface GeminiIgnoreDocumentV1 {
  path: string;
  content: string;
}

interface CompiledIgnoreDocumentV1 {
  directory: string;
  matcher: ReturnType<typeof createIgnore>;
}

function directoryDepth(path: string): number {
  return path.length === 0 ? 0 : path.split("/").length;
}

function basenameRank(path: string): number {
  return posix.basename(path) === ".gitignore" ? 0 : 1;
}

/** Builds case-sensitive Gitignore-compatible matching in deterministic file order. */
export function buildGeminiIgnoreMatcherV1(
  documents: readonly GeminiIgnoreDocumentV1[],
): (path: string) => boolean {
  const compiledByDirectory = new Map<string, CompiledIgnoreDocumentV1>();
  for (const { path, content } of [...documents].sort((left, right) => {
    const leftDirectory = posix.dirname(left.path) === "." ? "" : posix.dirname(left.path);
    const rightDirectory = posix.dirname(right.path) === "." ? "" : posix.dirname(right.path);
    return (
      directoryDepth(leftDirectory) - directoryDepth(rightDirectory) ||
      (leftDirectory < rightDirectory ? -1 : leftDirectory > rightDirectory ? 1 : 0) ||
      basenameRank(left.path) - basenameRank(right.path) ||
      (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    );
  })) {
    const directory = posix.dirname(path) === "." ? "" : posix.dirname(path);
    const compiled = compiledByDirectory.get(directory) ?? {
      directory,
      matcher: createIgnore({ ignorecase: false }),
    };
    compiled.matcher.add(content);
    compiledByDirectory.set(directory, compiled);
  }
  const compiled = [...compiledByDirectory.values()];

  return (path: string) => {
    const segments = path.split("/");
    const ancestorDirectories = segments
      .slice(0, -1)
      .map((_, index) => segments.slice(0, index + 1).join("/"));
    const ignoredDirectories = new Set<string>();
    let fileIgnored = false;
    for (const { directory, matcher } of compiled) {
      if (directory.length > 0 && path !== directory && !path.startsWith(`${directory}/`)) continue;
      if (directory.length > 0 && ignoredDirectories.has(directory)) continue;

      for (const ancestor of ancestorDirectories) {
        if (directory.length > 0 && ancestor !== directory && !ancestor.startsWith(`${directory}/`))
          continue;
        const relativeAncestor =
          directory.length === 0 ? ancestor : posix.relative(directory, ancestor);
        if (relativeAncestor.length === 0) continue;
        const result = matcher.test(`${relativeAncestor}/`);
        if (result.ignored) ignoredDirectories.add(ancestor);
        if (result.unignored) {
          const parent = posix.dirname(ancestor);
          if (parent === "." || !ignoredDirectories.has(parent))
            ignoredDirectories.delete(ancestor);
        }
      }

      const relative = directory.length === 0 ? path : posix.relative(directory, path);
      const result = matcher.test(relative);
      if (result.ignored) fileIgnored = true;
      if (result.unignored && !ancestorDirectories.some((value) => ignoredDirectories.has(value))) {
        fileIgnored = false;
      }
    }
    return fileIgnored || ancestorDirectories.some((value) => ignoredDirectories.has(value));
  };
}
