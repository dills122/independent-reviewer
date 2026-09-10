import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  JsonWhitespaceProgressErrorV1,
  JsonWhitespaceProgressGuardV1,
} from "../../src/provider/json-whitespace-progress.js";

describe("JsonWhitespaceProgressGuardV1", () => {
  it("trips exactly at the formatting-whitespace limit across fragments", () => {
    const guard = new JsonWhitespaceProgressGuardV1(4);
    assert.equal(guard.observe('{"value":1}').maximumFormattingWhitespace, 0);
    assert.equal(guard.observe(" \t").consecutiveFormattingWhitespace, 2);
    assert.equal(guard.observe("\r").consecutiveFormattingWhitespace, 3);
    assert.throws(
      () => guard.observe("\n"),
      (error: unknown) =>
        error instanceof JsonWhitespaceProgressErrorV1 &&
        error.limit === 4 &&
        error.progress.consecutiveFormattingWhitespace === 4,
    );
  });

  it("ignores whitespace inside strings and carries escape state across fragments", () => {
    const guard = new JsonWhitespaceProgressGuardV1(3);
    guard.observe('{"text":"   \\');
    guard.observe('"   ","nested":"');
    guard.observe("\n\t\r");
    assert.deepEqual(guard.observe('"}'), {
      consecutiveFormattingWhitespace: 0,
      maximumFormattingWhitespace: 0,
      totalCharacters: 34,
    });
  });

  it("resets the run only on non-whitespace outside a string", () => {
    const guard = new JsonWhitespaceProgressGuardV1(4);
    guard.observe("  ");
    assert.equal(guard.observe(", ").consecutiveFormattingWhitespace, 1);
    assert.equal(guard.observe('"  "  ').maximumFormattingWhitespace, 2);
  });

  it("rejects invalid limits", () => {
    for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => new JsonWhitespaceProgressGuardV1(limit), RangeError);
    }
  });
});
