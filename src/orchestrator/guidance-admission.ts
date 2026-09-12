export const GUIDANCE_CONTENT_WARNING_BYTES_V1 = 32 * 1024;
export const GUIDANCE_CONTENT_STOP_BYTES_V1 = 64 * 1024;

export interface GuidanceWireBytesByStageV1 {
  preliminary: number;
  findingVerification: number;
  final: number;
}

export interface GuidanceAdmissionInputV1 {
  contentBytes: number;
  wireBytesByStage: GuidanceWireBytesByStageV1;
  capacityBytes: number;
}

export interface GuidanceAdmissionResultV1 extends GuidanceAdmissionInputV1 {
  status: "ACCEPTED" | "WARNING" | "STOP";
  warningReasons: string[];
  stopReasons: string[];
}

const STAGES = [
  ["preliminary", "PRELIMINARY"],
  ["findingVerification", "FINDING_VERIFICATION"],
  ["final", "FINAL"],
] as const;

function assertSafeNonnegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${label} must be a safe nonnegative integer.`);
}

/** Applies ADR-014 integer thresholds; stop always outranks warning. */
export function evaluateGuidanceAdmissionV1(
  input: GuidanceAdmissionInputV1,
): GuidanceAdmissionResultV1 {
  assertSafeNonnegativeInteger(input.contentBytes, "contentBytes");
  if (!Number.isSafeInteger(input.capacityBytes) || input.capacityBytes < 1)
    throw new TypeError("capacityBytes must be a positive safe integer.");
  for (const [stage] of STAGES)
    assertSafeNonnegativeInteger(input.wireBytesByStage[stage], `${stage} wire bytes`);

  const warningReasons =
    input.contentBytes >= GUIDANCE_CONTENT_WARNING_BYTES_V1 ? ["CONTENT_BYTES"] : [];
  const stopReasons = input.contentBytes >= GUIDANCE_CONTENT_STOP_BYTES_V1 ? ["CONTENT_BYTES"] : [];
  for (const [stage, label] of STAGES) {
    const wireBytes = input.wireBytesByStage[stage];
    if (10 * wireBytes >= input.capacityBytes) warningReasons.push(`${label}_WIRE_RATIO`);
    if (5 * wireBytes >= input.capacityBytes) stopReasons.push(`${label}_WIRE_RATIO`);
  }

  return {
    ...input,
    status: stopReasons.length > 0 ? "STOP" : warningReasons.length > 0 ? "WARNING" : "ACCEPTED",
    warningReasons,
    stopReasons,
  };
}
