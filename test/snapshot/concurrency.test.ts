import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mapWithConcurrencyV1 } from "../../src/snapshot/concurrency.js";

describe("mapWithConcurrencyV1", () => {
  it("preserves input order in the results", async () => {
    const results = await mapWithConcurrencyV1(
      [5, 1, 4, 2, 3],
      async (value) => {
        await new Promise((resolve) => setTimeout(resolve, value));
        return value * 2;
      },
      2,
    );

    assert.deepEqual(results, [10, 2, 8, 4, 6]);
  });

  it("never exceeds the configured limit", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrencyV1(
      Array.from({ length: 50 }, (_, index) => index),
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
      },
      4,
    );

    assert.equal(peak, 4);
  });

  it("rejects an invalid limit and tolerates an empty input", async () => {
    await assert.rejects(() => mapWithConcurrencyV1([1], async (value) => value, 0), TypeError);
    assert.deepEqual(await mapWithConcurrencyV1([], async (value) => value), []);
  });
});
