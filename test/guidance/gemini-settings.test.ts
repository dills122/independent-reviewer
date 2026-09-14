import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GuidanceCaptureError } from "../../src/guidance/base-markdown-source.js";
import { parseGeminiSettingsV1 } from "../../src/guidance/gemini-settings.js";

describe("Gemini BASE settings", () => {
  it("defaults to GEMINI.md with both ignore grammars enabled", () => {
    assert.deepEqual(parseGeminiSettingsV1(".gemini/settings.json", "{}"), {
      contextFileNames: ["GEMINI.md"],
      respectGitIgnore: true,
      respectGeminiIgnore: true,
      unknownSettingOffsets: [],
    });
  });

  it("accepts bounded basename overrides and recognized ignore flags", () => {
    assert.deepEqual(
      parseGeminiSettingsV1(
        ".gemini/settings.json",
        JSON.stringify({
          context: {
            fileName: ["GEMINI.md", "PROJECT.md"],
            fileFiltering: { respectGitIgnore: false, respectGeminiIgnore: true },
          },
        }),
      ),
      {
        contextFileNames: ["GEMINI.md", "PROJECT.md"],
        respectGitIgnore: false,
        respectGeminiIgnore: true,
        unknownSettingOffsets: [],
      },
    );
  });

  it("reports unknown setting positions without retaining values", () => {
    const content = '{"unknown":"do not persist","context":{"fileName":"PROJECT.md"}}';
    const parsed = parseGeminiSettingsV1(".gemini/settings.json", content);
    assert.deepEqual(parsed.contextFileNames, ["PROJECT.md"]);
    assert.deepEqual(parsed.unknownSettingOffsets, [1]);
    assert.equal(JSON.stringify(parsed).includes("do not persist"), false);
  });

  it("rejects permissive JSON forms, duplicate keys, and unsafe names", () => {
    for (const content of [
      '{/* comment */"context":{}}',
      '{"context":{},}',
      '{"context":{"fileName":"GEMINI.md","fileName":"PROJECT.md"}}',
      '{"context":{"fileName":"../GEMINI.md"}}',
      '{"context":{"fileName":[]}}',
    ]) {
      assert.throws(
        () => parseGeminiSettingsV1(".gemini/settings.json", content),
        (error) => error instanceof GuidanceCaptureError && error.path === ".gemini/settings.json",
      );
    }
  });
});
