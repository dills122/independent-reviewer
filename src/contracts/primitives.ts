import * as z from "zod";

/**
 * Identifier and text primitives shared by every contract module.
 *
 * These are the validation rules for digest-bound, tamper-evident artifacts, so they exist once:
 * a copy that drifts leaves one path accepting artifacts the others reject, and the mismatch
 * surfaces as an opaque parse failure inside a review run rather than at the boundary.
 */
export type IdentifierPrefixV1 =
  | "brief"
  | "check"
  | "config"
  | "evidence"
  | "finding"
  | "flow"
  | "hunk"
  | "input"
  | "repo"
  | "snapshot";

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

export const CanonicalInputIdSchema = prefixedIdentifier("input");

/** Orders strings by UTF-16 code unit, the ordering the canonical JSON form depends on. */
export function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
