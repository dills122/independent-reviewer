import { constants as bufferConstants } from "node:buffer";
import { open } from "node:fs/promises";

import { visit } from "jsonc-parser";

export type StrictJsonErrorCode = "JSON_TOO_LARGE" | "JSON_SYNTAX" | "JSON_DUPLICATE_PROPERTY";

export interface StrictJsonParseOptionsV1 {
  readonly maxBytes: number;
  readonly source: string;
}

export interface StrictJsonLinesFileOptionsV1 {
  readonly maxTotalBytes: number;
  readonly maxLineBytes: number;
  readonly source: string;
}

interface StrictJsonErrorInputV1 {
  readonly code: StrictJsonErrorCode;
  readonly source: string;
  readonly line: number;
  readonly column: number;
  readonly physicalLine?: number;
  readonly cause?: Error;
}

export class StrictJsonErrorV1 extends Error {
  readonly code: StrictJsonErrorCode;
  readonly source: string;
  readonly line: number;
  readonly column: number;
  readonly physicalLine: number | undefined;

  constructor(input: StrictJsonErrorInputV1) {
    const physicalLineContext =
      input.physicalLine === undefined ? "" : `, physical line ${input.physicalLine}`;
    super(
      `${input.code} in ${input.source} at line ${input.line}, column ${input.column}${physicalLineContext}`,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "StrictJsonErrorV1";
    this.code = input.code;
    this.source = input.source;
    this.line = input.line;
    this.column = input.column;
    this.physicalLine = input.physicalLine;
  }
}

interface JsonProblemV1 {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

const sourceLabelPattern = /^[A-Za-z0-9][A-Za-z0-9 ./_():-]{0,127}$/u;

function assertSafeSourceLabel(source: string): void {
  if (!sourceLabelPattern.test(source)) {
    throw new TypeError(
      "Strict JSON source must be a safe non-empty label of at most 128 characters",
    );
  }
}

function assertByteCap(maxBytes: number, name: string): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes >= bufferConstants.MAX_LENGTH) {
    throw new RangeError(`${name} must be a positive safe integer below Buffer.MAX_LENGTH`);
  }
}

function strictJsonError(
  code: StrictJsonErrorCode,
  source: string,
  problem: Pick<JsonProblemV1, "line" | "column"> = { line: 1, column: 1 },
  physicalLine?: number,
  cause?: Error,
): StrictJsonErrorV1 {
  return new StrictJsonErrorV1({
    code,
    source,
    line: problem.line,
    column: problem.column,
    ...(physicalLine === undefined ? {} : { physicalLine }),
    ...(cause === undefined ? {} : { cause }),
  });
}

export function parseStrictJsonV1(text: string, options: StrictJsonParseOptionsV1): unknown {
  assertSafeSourceLabel(options.source);
  assertByteCap(options.maxBytes, "maxBytes");

  if (Buffer.byteLength(text, "utf8") > options.maxBytes) {
    throw strictJsonError("JSON_TOO_LARGE", options.source);
  }

  let syntaxProblem: JsonProblemV1 | undefined;
  let duplicateProblem: JsonProblemV1 | undefined;
  const objectProperties: Set<string>[] = [];

  try {
    visit(
      text,
      {
        onObjectBegin: () => {
          objectProperties.push(new Set());
        },
        onObjectProperty: (property, offset, _length, startLine, startCharacter) => {
          const properties = objectProperties.at(-1);
          if (properties?.has(property) && duplicateProblem === undefined) {
            duplicateProblem = {
              offset,
              line: startLine + 1,
              column: startCharacter + 1,
            };
          }
          properties?.add(property);
        },
        onObjectEnd: () => {
          objectProperties.pop();
        },
        onError: (_error, offset, _length, startLine, startCharacter) => {
          if (syntaxProblem === undefined || offset < syntaxProblem.offset) {
            syntaxProblem = {
              offset,
              line: startLine + 1,
              column: startCharacter + 1,
            };
          }
        },
      },
      {
        allowEmptyContent: false,
        allowTrailingComma: false,
        disallowComments: true,
      },
    );
  } catch {
    throw strictJsonError("JSON_SYNTAX", options.source);
  }

  if (syntaxProblem !== undefined) {
    throw strictJsonError("JSON_SYNTAX", options.source, syntaxProblem);
  }
  if (duplicateProblem !== undefined) {
    throw strictJsonError("JSON_DUPLICATE_PROPERTY", options.source, duplicateProblem);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw strictJsonError(
      "JSON_SYNTAX",
      options.source,
      { line: 1, column: 1 },
      undefined,
      new Error("Native JSON parser rejected visitor-approved input"),
    );
  }
}

async function readBoundedUtf8FileV1(
  path: string,
  maxBytes: number,
  source: string,
): Promise<string> {
  assertSafeSourceLabel(source);
  assertByteCap(maxBytes, "maxBytes");

  const handle = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    const readLimit = maxBytes + 1;
    while (bytesRead < readLimit) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, readLimit - bytesRead));
      const result = await handle.read(chunk, 0, chunk.length, bytesRead);
      if (result.bytesRead === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, result.bytesRead));
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maxBytes) {
      throw strictJsonError("JSON_TOO_LARGE", source);
    }

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytesRead));
    } catch {
      throw strictJsonError("JSON_SYNTAX", source);
    }
  } finally {
    await handle.close();
  }
}

export async function readStrictJsonFileV1(
  path: string,
  options: StrictJsonParseOptionsV1,
): Promise<unknown> {
  const text = await readBoundedUtf8FileV1(path, options.maxBytes, options.source);
  return parseStrictJsonV1(text, options);
}

export async function readStrictJsonLinesFileV1(
  path: string,
  options: StrictJsonLinesFileOptionsV1,
): Promise<readonly unknown[]> {
  assertByteCap(options.maxLineBytes, "maxLineBytes");
  const text = await readBoundedUtf8FileV1(path, options.maxTotalBytes, options.source);
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines.map((lineWithPossibleCarriageReturn, index) => {
    const physicalLine = index + 1;
    const line = lineWithPossibleCarriageReturn.endsWith("\r")
      ? lineWithPossibleCarriageReturn.slice(0, -1)
      : lineWithPossibleCarriageReturn;
    if (Buffer.byteLength(line, "utf8") > options.maxLineBytes) {
      throw strictJsonError("JSON_TOO_LARGE", options.source, { line: 1, column: 1 }, physicalLine);
    }

    try {
      return parseStrictJsonV1(line, {
        maxBytes: options.maxLineBytes,
        source: options.source,
      });
    } catch (error) {
      if (!(error instanceof StrictJsonErrorV1)) {
        throw error;
      }
      throw strictJsonError(
        error.code,
        options.source,
        { line: error.line, column: error.column },
        physicalLine,
        error.cause instanceof Error ? error.cause : undefined,
      );
    }
  });
}
