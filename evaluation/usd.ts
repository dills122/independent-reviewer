import * as z from "zod";

import { compareUtf16 } from "../src/contracts/primitives.js";

export const EVALUATION_USD_DECIMAL_PLACES_V1 = 9;
export const EVALUATION_USD_SCALE_V1 = 10 ** EVALUATION_USD_DECIMAL_PLACES_V1;

function decimalPlaces(value: number): number {
  const [coefficient = "", exponentText] = value.toString().toLowerCase().split("e");
  const fractionLength = coefficient.split(".")[1]?.length ?? 0;
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  return Math.max(0, fractionLength - exponent);
}

export function evaluationUsdToUnitsV1(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError("USD value must be nonnegative and finite");
  }
  if (decimalPlaces(value) > EVALUATION_USD_DECIMAL_PLACES_V1) {
    throw new TypeError(
      `USD value supports at most ${EVALUATION_USD_DECIMAL_PLACES_V1} decimal places`,
    );
  }
  const units = Math.round(value * EVALUATION_USD_SCALE_V1);
  if (!Number.isSafeInteger(units)) {
    throw new TypeError("USD value exceeds fixed-scale safe-integer range");
  }
  return units;
}

export const EvaluationUsdV1Schema = z.number().superRefine((value, context) => {
  try {
    evaluationUsdToUnitsV1(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "invalid USD value",
    });
  }
});

export function sumEvaluationUsdV1(
  contributions: readonly { artifactId: string; value: number }[],
): number {
  let units = 0;
  for (const contribution of [...contributions].sort((left, right) =>
    compareUtf16(left.artifactId, right.artifactId),
  )) {
    units += evaluationUsdToUnitsV1(contribution.value);
    if (!Number.isSafeInteger(units)) {
      throw new TypeError("aggregated USD value exceeds fixed-scale safe-integer range");
    }
  }
  return units / EVALUATION_USD_SCALE_V1;
}
