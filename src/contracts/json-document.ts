import { createHash } from "node:crypto";

import type { DigestV1 } from "./snapshot-manifest.js";

/** Serializes a persisted artifact: pretty-printed JSON with a trailing newline. */
export function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** SHA-256 of exact bytes, as the lowercase hex the manifest and packet both store. */
export function sha256BytesHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** SHA-256 of exact bytes as a contract digest value. */
export function sha256BytesDigestV1(bytes: Uint8Array): DigestV1 {
  return { algorithm: "SHA256", value: sha256BytesHex(bytes) };
}
