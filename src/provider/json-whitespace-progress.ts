export const OPENROUTER_MAX_FORMATTING_WHITESPACE_V1 = 512;

export interface JsonWhitespaceProgressV1 {
  readonly consecutiveFormattingWhitespace: number;
  readonly maximumFormattingWhitespace: number;
  readonly totalCharacters: number;
}

/**
 * Tracks JSON formatting whitespace without treating whitespace inside strings as stalled output.
 * This is a progress guard, not a JSON validator; complete output still uses JSON.parse and the
 * versioned response contracts.
 */
export class JsonWhitespaceProgressGuardV1 {
  readonly #limit: number;
  #inString = false;
  #escaped = false;
  #consecutive = 0;
  #maximum = 0;
  #totalCharacters = 0;

  constructor(limit = OPENROUTER_MAX_FORMATTING_WHITESPACE_V1) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError("JSON formatting-whitespace limit must be a positive safe integer.");
    }
    this.#limit = limit;
  }

  observe(fragment: string): JsonWhitespaceProgressV1 {
    for (const character of fragment) {
      this.#totalCharacters += 1;
      if (this.#inString) {
        this.#consecutive = 0;
        if (this.#escaped) {
          this.#escaped = false;
        } else if (character === "\\") {
          this.#escaped = true;
        } else if (character === '"') {
          this.#inString = false;
        }
        continue;
      }
      if (character === '"') {
        this.#inString = true;
        this.#consecutive = 0;
        continue;
      }
      if (character === " " || character === "\t" || character === "\n" || character === "\r") {
        this.#consecutive += 1;
        this.#maximum = Math.max(this.#maximum, this.#consecutive);
        if (this.#consecutive >= this.#limit) {
          throw new JsonWhitespaceProgressErrorV1(this.snapshot(), this.#limit);
        }
      } else {
        this.#consecutive = 0;
      }
    }
    return this.snapshot();
  }

  snapshot(): JsonWhitespaceProgressV1 {
    return {
      consecutiveFormattingWhitespace: this.#consecutive,
      maximumFormattingWhitespace: this.#maximum,
      totalCharacters: this.#totalCharacters,
    };
  }
}

export class JsonWhitespaceProgressErrorV1 extends Error {
  readonly limit: number;
  readonly progress: JsonWhitespaceProgressV1;

  constructor(progress: JsonWhitespaceProgressV1, limit: number) {
    super(`Structured JSON stopped making progress after ${limit} formatting characters.`);
    this.name = "JsonWhitespaceProgressErrorV1";
    this.limit = limit;
    this.progress = progress;
  }
}
