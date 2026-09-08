import { createHash } from "node:crypto";
import { types } from "node:util";

import type { DigestV1 } from "./snapshot-manifest.js";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!Number.isInteger(nextCodeUnit) || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        throw new TypeError("canonical JSON strings must not contain a lone surrogate");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("canonical JSON strings must not contain a lone surrogate");
    }
  }
}

function serializeString(value: string): string {
  assertValidUnicode(value);
  return JSON.stringify(value);
}

function serializeArray(value: readonly unknown[], ancestors: Set<object>): string {
  const ownKeys = Reflect.ownKeys(value);
  const expectedKeys = new Set(["length"]);
  for (let index = 0; index < value.length; index += 1) {
    expectedKeys.add(String(index));
  }
  if (ownKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key))) {
    throw new TypeError("canonical JSON arrays must not contain extra properties");
  }

  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError("canonical JSON arrays must not be sparse");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("canonical JSON arrays must contain data properties only");
    }
    items.push(serializeValue(descriptor.value, ancestors));
  }
  return `[${items.join(",")}]`;
}

function serializeObject(value: object, ancestors: Set<object>): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("canonical JSON objects must be plain JSON objects");
  }

  const entries = Reflect.ownKeys(value).map((key) => {
    if (typeof key !== "string") {
      throw new TypeError("canonical JSON objects must not contain symbol properties");
    }
    assertValidUnicode(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("canonical JSON objects must contain enumerable data properties only");
    }
    return [key, descriptor.value] as const;
  });
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries
    .map(([key, entryValue]) => `${serializeString(key)}:${serializeValue(entryValue, ancestors)}`)
    .join(",")}}`;
}

function serializeValue(value: unknown, ancestors: Set<object>): string {
  if (types.isProxy(value)) {
    throw new TypeError("canonical JSON cannot represent proxies");
  }
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON numbers must be finite IEEE 754 values");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return serializeString(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`canonical JSON cannot represent values of type ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new TypeError("canonical JSON cannot represent cyclic objects");
  }

  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? serializeArray(value, ancestors)
      : serializeObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function copyWithNullObjectPrototypes(value: CanonicalJsonValue): CanonicalJsonValue {
  if (Array.isArray(value)) {
    const result: CanonicalJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (item === undefined) {
        throw new TypeError("canonical JSON arrays must not be sparse");
      }
      result.push(copyWithNullObjectPrototypes(item));
    }
    return result;
  }
  if (value !== null && typeof value === "object") {
    const result = Object.create(null) as Record<string, CanonicalJsonValue>;
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError("parsed canonical JSON must contain data properties only");
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: copyWithNullObjectPrototypes(descriptor.value),
        writable: true,
      });
    }
    return result;
  }
  return value;
}

/**
 * Serializes I-JSON-compatible data according to RFC 8785 JCS.
 *
 * @throws {TypeError} If the value cannot be represented without changing it.
 * @see https://www.rfc-editor.org/rfc/rfc8785.html
 */
export function canonicalizeJson(value: unknown): string {
  return serializeValue(value, new Set());
}

/**
 * Copies accepted JSON data into fresh arrays and null-prototype objects.
 *
 * The copy prevents schema readers from resolving missing fields through a
 * polluted prototype after canonical validation has inspected only own data.
 */
export function cloneCanonicalJson(value: unknown): CanonicalJsonValue {
  const parsed = JSON.parse(canonicalizeJson(value)) as CanonicalJsonValue;
  return copyWithNullObjectPrototypes(parsed);
}

/**
 * Produces a lowercase SHA-256 digest over the UTF-8 encoding of a string.
 *
 * @see https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptocreatehashalgorithm-options
 */
export function sha256Utf8(value: string): DigestV1 {
  return {
    algorithm: "SHA256",
    value: createHash("sha256").update(value, "utf8").digest("hex"),
  };
}

/** Canonicalizes JSON-compatible data before hashing it as UTF-8. */
export function digestCanonicalJson(value: unknown): DigestV1 {
  return sha256Utf8(canonicalizeJson(value));
}
