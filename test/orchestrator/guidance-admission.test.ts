import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateGuidanceAdmissionV1 } from "../../src/orchestrator/guidance-admission.js";

test("guidance admission applies exact content-byte boundaries with stop winning", () => {
  const belowWarning = evaluateGuidanceAdmissionV1({
    contentBytes: 32 * 1024 - 1,
    wireBytesByStage: { preliminary: 1, findingVerification: 1, final: 1 },
    capacityBytes: 1_000_000,
  });
  const atWarning = evaluateGuidanceAdmissionV1({
    contentBytes: 32 * 1024,
    wireBytesByStage: { preliminary: 1, findingVerification: 1, final: 1 },
    capacityBytes: 1_000_000,
  });
  const belowStop = evaluateGuidanceAdmissionV1({
    contentBytes: 64 * 1024 - 1,
    wireBytesByStage: { preliminary: 1, findingVerification: 1, final: 1 },
    capacityBytes: 1_000_000,
  });
  const atStop = evaluateGuidanceAdmissionV1({
    contentBytes: 64 * 1024,
    wireBytesByStage: { preliminary: 1, findingVerification: 1, final: 1 },
    capacityBytes: 1_000_000,
  });

  assert.equal(belowWarning.status, "ACCEPTED");
  assert.equal(atWarning.status, "WARNING");
  assert.equal(belowStop.status, "WARNING");
  assert.equal(atStop.status, "STOP");
});

test("guidance admission applies exact integer wire-ratio boundaries per stage", () => {
  assert.equal(
    evaluateGuidanceAdmissionV1({
      contentBytes: 1,
      wireBytesByStage: { preliminary: 9_999, findingVerification: 1, final: 1 },
      capacityBytes: 100_000,
    }).status,
    "ACCEPTED",
  );
  assert.equal(
    evaluateGuidanceAdmissionV1({
      contentBytes: 1,
      wireBytesByStage: { preliminary: 10_000, findingVerification: 1, final: 1 },
      capacityBytes: 100_000,
    }).status,
    "WARNING",
  );
  assert.equal(
    evaluateGuidanceAdmissionV1({
      contentBytes: 1,
      wireBytesByStage: { preliminary: 19_999, findingVerification: 1, final: 1 },
      capacityBytes: 100_000,
    }).status,
    "WARNING",
  );
  const stopped = evaluateGuidanceAdmissionV1({
    contentBytes: 32 * 1024,
    wireBytesByStage: { preliminary: 1, findingVerification: 20_000, final: 1 },
    capacityBytes: 100_000,
  });
  assert.equal(stopped.status, "STOP");
  assert.deepEqual(stopped.stopReasons, ["FINDING_VERIFICATION_WIRE_RATIO"]);
});

test("guidance admission rejects unsafe integer inputs", () => {
  assert.throws(
    () =>
      evaluateGuidanceAdmissionV1({
        contentBytes: -1,
        wireBytesByStage: { preliminary: 1, findingVerification: 1, final: 1 },
        capacityBytes: 100,
      }),
    /safe nonnegative integer/i,
  );
});
