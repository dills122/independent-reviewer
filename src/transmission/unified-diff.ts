import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import parseDiff from "parse-diff";

import { logicalLineCountV1 } from "../contracts/index.js";
import { runGit } from "../snapshot/git-command.js";

export type DiffEvidenceForm = "UNIFIED_HUNKS" | "WHOLE_FILE";

export type RenderedUnifiedDiff = {
  readonly form: DiffEvidenceForm;
  readonly content: string;
};

const CONTEXT_LINES = 3;
const WHOLE_FILE_MAX_LINES = 40;
const WHOLE_FILE_MIN_CHANGE_FRACTION = 0.6;

type ParsedDiff = {
  readonly additions: number;
  readonly deletions: number;
  readonly chunks: parseDiff.Chunk[];
};

async function nativeDiff(beforeSource: string, afterSource: string, contextLines: number) {
  const directory = await mkdtemp(join(tmpdir(), "independent-reviewer-diff-"));
  try {
    await Promise.all([
      writeFile(join(directory, "before"), beforeSource),
      writeFile(join(directory, "after"), afterSource),
    ]);
    const result = await runGit(
      directory,
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.safecrlf=false",
        "-c",
        "core.attributesFile=",
        "diff",
        "--no-index",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-indent-heuristic",
        "--diff-algorithm=histogram",
        "--inter-hunk-context=0",
        `--unified=${contextLines}`,
        "--",
        "before",
        "after",
      ],
      [0, 1],
    );
    return result.stdout.toString("utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseSingleFileDiff(content: string): ParsedDiff {
  if (content.length === 0) {
    return { additions: 0, deletions: 0, chunks: [] };
  }
  const files = parseDiff(content);
  const file = files[0];
  if (files.length !== 1 || file === undefined) {
    throw new Error(`Native diff produced ${files.length} file records; expected exactly one.`);
  }
  return {
    additions: file.additions,
    deletions: file.deletions,
    chunks: file.chunks,
  };
}

function renderParsedDiff(
  parsed: ParsedDiff,
  form: DiffEvidenceForm,
  beforePath: string,
  afterPath: string,
): RenderedUnifiedDiff {
  const rendered = [`Evidence form: ${form}`, `--- BASE/${beforePath}`, `+++ HEAD/${afterPath}`];
  for (const chunk of parsed.chunks) {
    rendered.push(
      `@@ -${chunk.oldStart},${chunk.oldLines} +${chunk.newStart},${chunk.newLines} @@`,
      ...chunk.changes.map((change) => change.content),
    );
  }
  return { form, content: rendered.join("\n") };
}

/** Renders frozen source bytes through native Git, then validates and structures its hunks. */
export async function renderUnifiedDiff(
  beforeSource: string,
  afterSource: string,
  beforePath: string,
  afterPath: string,
): Promise<RenderedUnifiedDiff> {
  const beforeLines = logicalLineCountV1(beforeSource);
  const afterLines = logicalLineCountV1(afterSource);
  const boundedContent = await nativeDiff(beforeSource, afterSource, CONTEXT_LINES);
  let parsed = parseSingleFileDiff(boundedContent);
  const changedLines = parsed.additions + parsed.deletions;
  const totalLines = beforeLines + afterLines;
  const wholeFile =
    Math.max(beforeLines, afterLines) <= WHOLE_FILE_MAX_LINES ||
    (totalLines > 0 && changedLines / totalLines >= WHOLE_FILE_MIN_CHANGE_FRACTION);
  if (!wholeFile) {
    return renderParsedDiff(parsed, "UNIFIED_HUNKS", beforePath, afterPath);
  }

  if (parsed.chunks.length > 0) {
    parsed = parseSingleFileDiff(
      await nativeDiff(beforeSource, afterSource, Math.max(beforeLines, afterLines)),
    );
  }
  return renderParsedDiff(parsed, "WHOLE_FILE", beforePath, afterPath);
}
