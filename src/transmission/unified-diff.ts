type DiffLine = {
  readonly value: string;
  readonly terminated: boolean;
};

type DiffOperation = {
  readonly type: "EQUAL" | "DELETE" | "INSERT";
  readonly line: DiffLine;
};

export type DiffEvidenceForm = "UNIFIED_HUNKS" | "WHOLE_FILE";

export type RenderedUnifiedDiff = {
  readonly form: DiffEvidenceForm;
  readonly content: string;
};

const CONTEXT_LINES = 3;
const WHOLE_FILE_MAX_LINES = 40;
const WHOLE_FILE_MIN_CHANGE_FRACTION = 0.6;
/** Prevents the quadratic Myers trace from dominating capture on highly divergent files. */
const MAX_MYERS_EDIT_DISTANCE = 512;

function splitLines(source: string): DiffLine[] {
  if (source.length === 0) {
    return [];
  }
  const values = source.split(/\r\n|[\r\n]/);
  const endsWithNewline = /(?:\r\n|[\r\n])$/.test(source);
  if (endsWithNewline) {
    values.pop();
  }
  return values.map((value, index) => ({
    value,
    terminated: index < values.length - 1 || endsWithNewline,
  }));
}

function linesEqual(left: DiffLine, right: DiffLine): boolean {
  return left.value === right.value && left.terminated === right.terminated;
}

function lineAt(lines: readonly DiffLine[], index: number): DiffLine {
  const line = lines[index];
  if (line === undefined) {
    throw new Error(`Diff line index ${index} is outside captured source.`);
  }
  return line;
}

function frontierValue(frontier: ReadonlyMap<number, number>, diagonal: number): number {
  return frontier.get(diagonal) ?? Number.NEGATIVE_INFINITY;
}

function coarseLineOperations(
  before: readonly DiffLine[],
  after: readonly DiffLine[],
): DiffOperation[] {
  let prefixLength = 0;
  while (
    prefixLength < before.length &&
    prefixLength < after.length &&
    linesEqual(lineAt(before, prefixLength), lineAt(after, prefixLength))
  ) {
    prefixLength += 1;
  }
  let suffixLength = 0;
  while (
    suffixLength < before.length - prefixLength &&
    suffixLength < after.length - prefixLength &&
    linesEqual(
      lineAt(before, before.length - suffixLength - 1),
      lineAt(after, after.length - suffixLength - 1),
    )
  ) {
    suffixLength += 1;
  }
  return [
    ...before.slice(0, prefixLength).map((line) => ({ type: "EQUAL" as const, line })),
    ...before
      .slice(prefixLength, before.length - suffixLength)
      .map((line) => ({ type: "DELETE" as const, line })),
    ...after
      .slice(prefixLength, after.length - suffixLength)
      .map((line) => ({ type: "INSERT" as const, line })),
    ...before.slice(before.length - suffixLength).map((line) => ({
      type: "EQUAL" as const,
      line,
    })),
  ];
}

/** Finds a shortest line edit script using Myers' bounded edit graph. */
function lineOperations(before: readonly DiffLine[], after: readonly DiffLine[]): DiffOperation[] {
  const maximumDistance = before.length + after.length;
  const trace: Array<Map<number, number>> = [];
  const frontier = new Map<number, number>([[1, 0]]);

  for (
    let distance = 0;
    distance <= Math.min(maximumDistance, MAX_MYERS_EDIT_DISTANCE);
    distance += 1
  ) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const moveDown =
        diagonal === -distance ||
        (diagonal !== distance &&
          frontierValue(frontier, diagonal - 1) < frontierValue(frontier, diagonal + 1));
      let beforeIndex = moveDown
        ? frontierValue(frontier, diagonal + 1)
        : frontierValue(frontier, diagonal - 1) + 1;
      let afterIndex = beforeIndex - diagonal;
      while (
        beforeIndex < before.length &&
        afterIndex < after.length &&
        linesEqual(lineAt(before, beforeIndex), lineAt(after, afterIndex))
      ) {
        beforeIndex += 1;
        afterIndex += 1;
      }
      frontier.set(diagonal, beforeIndex);
      if (beforeIndex >= before.length && afterIndex >= after.length) {
        return backtrackOperations(trace, before, after);
      }
    }
  }

  return coarseLineOperations(before, after);
}

function backtrackOperations(
  trace: readonly ReadonlyMap<number, number>[],
  before: readonly DiffLine[],
  after: readonly DiffLine[],
): DiffOperation[] {
  let beforeIndex = before.length;
  let afterIndex = after.length;
  const reversed: DiffOperation[] = [];

  for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
    const frontier = trace[distance];
    if (frontier === undefined) {
      throw new Error(`Diff trace index ${distance} is unavailable.`);
    }
    const diagonal = beforeIndex - afterIndex;
    const previousDiagonal =
      diagonal === -distance ||
      (diagonal !== distance &&
        frontierValue(frontier, diagonal - 1) < frontierValue(frontier, diagonal + 1))
        ? diagonal + 1
        : diagonal - 1;
    const previousBeforeIndex = frontierValue(frontier, previousDiagonal);
    const previousAfterIndex = previousBeforeIndex - previousDiagonal;

    while (beforeIndex > previousBeforeIndex && afterIndex > previousAfterIndex) {
      reversed.push({ type: "EQUAL", line: lineAt(before, beforeIndex - 1) });
      beforeIndex -= 1;
      afterIndex -= 1;
    }
    if (distance === 0) {
      break;
    }
    if (beforeIndex === previousBeforeIndex) {
      reversed.push({ type: "INSERT", line: lineAt(after, afterIndex - 1) });
      afterIndex -= 1;
    } else {
      reversed.push({ type: "DELETE", line: lineAt(before, beforeIndex - 1) });
      beforeIndex -= 1;
    }
  }

  return reversed.reverse();
}

type OperationRange = { start: number; end: number };

function hunkRanges(operations: readonly DiffOperation[], wholeFile: boolean): OperationRange[] {
  if (wholeFile) {
    return operations.length === 0 ? [] : [{ start: 0, end: operations.length }];
  }
  const ranges: OperationRange[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    if (operations[index]?.type === "EQUAL") {
      continue;
    }
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(operations.length, index + CONTEXT_LINES + 1);
    const previous = ranges.at(-1);
    if (previous !== undefined && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

function countBefore(
  operations: readonly DiffOperation[],
  end: number,
  excludedType: DiffOperation["type"],
): number {
  let count = 0;
  for (let index = 0; index < end; index += 1) {
    if (operations[index]?.type !== excludedType) {
      count += 1;
    }
  }
  return count;
}

function rangeCoordinate(precedingLines: number, lineCount: number): string {
  const start = lineCount === 0 ? precedingLines : precedingLines + 1;
  return `${start},${lineCount}`;
}

function renderOperation(operation: DiffOperation): string[] {
  const prefix = operation.type === "EQUAL" ? " " : operation.type === "DELETE" ? "-" : "+";
  const rendered = [`${prefix}${operation.line.value}`];
  if (!operation.line.terminated) {
    rendered.push("\\ No newline at end of file");
  }
  return rendered;
}

/** Renders source bytes as deterministic unified hunks with bounded unchanged context. */
export function renderUnifiedDiff(
  beforeSource: string,
  afterSource: string,
  beforePath: string,
  afterPath: string,
): RenderedUnifiedDiff {
  const before = splitLines(beforeSource);
  const after = splitLines(afterSource);
  const operations = lineOperations(before, after);
  const changedLineCount = operations.filter((operation) => operation.type !== "EQUAL").length;
  const totalLineCount = before.length + after.length;
  const wholeFile =
    Math.max(before.length, after.length) <= WHOLE_FILE_MAX_LINES ||
    (totalLineCount > 0 && changedLineCount / totalLineCount >= WHOLE_FILE_MIN_CHANGE_FRACTION);
  const form: DiffEvidenceForm = wholeFile ? "WHOLE_FILE" : "UNIFIED_HUNKS";
  const rendered = [`Evidence form: ${form}`, `--- BASE/${beforePath}`, `+++ HEAD/${afterPath}`];

  for (const range of hunkRanges(operations, wholeFile)) {
    const rangeOperations = operations.slice(range.start, range.end);
    const precedingBeforeLines = countBefore(operations, range.start, "INSERT");
    const precedingAfterLines = countBefore(operations, range.start, "DELETE");
    const beforeLineCount = countBefore(rangeOperations, rangeOperations.length, "INSERT");
    const afterLineCount = countBefore(rangeOperations, rangeOperations.length, "DELETE");
    rendered.push(
      `@@ -${rangeCoordinate(precedingBeforeLines, beforeLineCount)} +${rangeCoordinate(precedingAfterLines, afterLineCount)} @@`,
    );
    rendered.push(...rangeOperations.flatMap(renderOperation));
  }

  return { form, content: rendered.join("\n") };
}
