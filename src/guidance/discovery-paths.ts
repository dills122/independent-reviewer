import { posix } from "node:path";

/** Returns repository root through exact target parent using POSIX repository paths. */
export function guidanceAncestorDirectoriesV1(path: string): string[] {
  const parent = posix.dirname(path);
  if (parent === ".") return [""];
  const segments = parent.split("/");
  return ["", ...segments.map((_, index) => segments.slice(0, index + 1).join("/"))];
}

export function guidancePathInDirectoryV1(directory: string, filename: string): string {
  return directory.length === 0 ? filename : posix.join(directory, filename);
}
