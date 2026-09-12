import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CanonicalGuidancePresentationV1Schema } from "../../src/index.js";

describe("CanonicalGuidancePresentationV1Schema", () => {
  it("rejects duplicate properties before canonical presentation validation", () => {
    const precedence =
      "Repository-peer sources have equal semantic priority. Reviewer-specific sources take precedence when guidance conflicts.";
    const presentation =
      `{"precedence":${JSON.stringify(precedence)},` +
      `"schemaVersion":1,"schemaVersion":1,"sources":[],` +
      '"trustBoundary":"UNTRUSTED_REPOSITORY_GUIDANCE"}';

    const result = CanonicalGuidancePresentationV1Schema.safeParse(presentation);

    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error.issues[0]?.message ?? "", /JSON_DUPLICATE_PROPERTY/);
    }
  });
});
