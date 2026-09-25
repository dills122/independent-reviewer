import * as z from "zod";

/**
 * Identifier and text primitives shared by every contract module.
 *
 * These are the validation rules for digest-bound, tamper-evident artifacts, so they exist once:
 * a copy that drifts leaves one path accepting artifacts the others reject, and the mismatch
 * surfaces as an opaque parse failure inside a review run rather than at the boundary.
 */
export type IdentifierPrefixV1 =
  | "adjudication"
  | "attempt"
  | "brief"
  | "case"
  | "comparison"
  | "check"
  | "claim"
  | "config"
  | "context"
  | "evidence"
  | "experiment"
  | "family"
  | "finding"
  | "flow"
  | "guidance"
  | "guidance_diagnostic"
  | "guidance_edge"
  | "guidance_occurrence"
  | "guidance_source"
  | "guidance_target"
  | "hunk"
  | "input"
  | "obligation"
  | "pair"
  | "plan"
  | "producer"
  | "reference"
  | "region"
  | "relation"
  | "root"
  | "rule"
  | "score"
  | "repo"
  | "snapshot"
  | "uncertainty"
  | "unit"
  | "variant";

export function prefixedIdentifier(prefix: IdentifierPrefixV1): z.ZodString {
  return z
    .string()
    .min(prefix.length + 2)
    .max(128)
    .regex(
      new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]*$`),
      `must use the ${prefix}_ identifier prefix`,
    );
}

export const NonEmptyTextSchema = z.string().min(1);

/** Canonical provider prose for content-bound claims; never truncate or normalize identity input. */
export function boundedClaimTextV1(maxScalars: number, maxBytes: number) {
  return NonEmptyTextSchema.superRefine((value, context) => {
    if (
      value !== value.trim() ||
      /[\r\n\u0085\u2028\u2029]/u.test(value) ||
      !value.isWellFormed() ||
      [...value].length > maxScalars ||
      Buffer.byteLength(value, "utf8") > maxBytes
    ) {
      context.addIssue({ code: "custom", message: "must be canonical bounded single-line text" });
    }
  });
}

export const ClaimLabelV1Schema = boundedClaimTextV1(160, 640);
export const ClaimTextV1Schema = boundedClaimTextV1(600, 2400);
export const ClaimRationaleV1Schema = boundedClaimTextV1(400, 1600);

export const CanonicalInputIdSchema = prefixedIdentifier("input");

/** Orders strings by UTF-16 code unit, the ordering the canonical JSON form depends on. */
export function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
