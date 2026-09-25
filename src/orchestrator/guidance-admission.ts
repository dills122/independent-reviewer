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

export interface GuidanceAdmissionInputV2
  extends Omit<GuidanceAdmissionInputV1, "wireBytesByStage"> {
  wireBytesByStage: GuidanceWireBytesByStageV1 & { finalClaimVerification: number };
}
export function evaluateGuidanceAdmissionV2(input: GuidanceAdmissionInputV2) {
  const result = evaluateGuidanceAdmissionV1(input);
  const bytes = input.wireBytesByStage.finalClaimVerification;
  assertSafeNonnegativeInteger(bytes, "finalClaimVerification wire bytes");
  if (10 * bytes >= input.capacityBytes)
    result.warningReasons.push("FINAL_CLAIM_VERIFICATION_WIRE_RATIO");
  if (5 * bytes >= input.capacityBytes)
    result.stopReasons.push("FINAL_CLAIM_VERIFICATION_WIRE_RATIO");
  return {
    ...result,
    wireBytesByStage: input.wireBytesByStage,
    status:
      result.stopReasons.length > 0
        ? ("STOP" as const)
        : result.warningReasons.length > 0
          ? ("WARNING" as const)
          : ("ACCEPTED" as const),
  };
}
