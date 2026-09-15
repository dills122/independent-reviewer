import { canonicalizeJson, cloneCanonicalJson } from "../src/contracts/canonical-json.js";
import { sha256BytesDigestV1 } from "../src/contracts/json-document.js";
import { type DigestV1, DigestV1Schema } from "../src/contracts/snapshot-manifest.js";

type ReviewerMessageStageV1 =
  | "PRELIMINARY"
  | "PRELIMINARY_REPAIR"
  | "FINDING_VERIFICATION"
  | "FINAL"
  | "FINAL_REPAIR"
  | "TOOL_RESULT";

const MESSAGE_STAGES = new Set<ReviewerMessageStageV1>([
  "PRELIMINARY",
  "PRELIMINARY_REPAIR",
  "FINDING_VERIFICATION",
  "FINAL",
  "FINAL_REPAIR",
  "TOOL_RESULT",
]);

interface OracleArtifactV1 {
  reference: string;
  digest: DigestV1;
  bytes: Uint8Array;
}

interface EvaluationOracleLeakInputV1 {
  oracle: {
    expectedRoots: readonly { rootId: string; description: string }[];
    expectedUncertainties: readonly { uncertaintyId: string; description: string }[];
    forbiddenLabels: readonly string[];
    artifacts: readonly OracleArtifactV1[];
  };
  messages: readonly {
    stage: ReviewerMessageStageV1;
    reference: string;
    content: unknown;
    bytes?: Uint8Array;
  }[];
}

function collectStrings(value: unknown, keys: string[], values: string[]): void {
  if (typeof value === "string") {
    values.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, keys, values);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      keys.push(key);
      collectStrings(nested, keys, values);
    }
  }
}

function contains(haystacks: readonly string[], needle: string): boolean {
  return needle.length > 0 && haystacks.some((haystack) => haystack.includes(needle));
}

function encodedForms(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const hex = bytes.toString("hex");
  return [value, bytes.toString("base64"), hex, hex.toUpperCase(), canonicalizeJson(value)];
}

function decodeBase64Fragment(value: string): Buffer | null {
  if (
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null;
  }
  return Buffer.from(value, "base64");
}

function containsSeparatelyEncodedFragments(
  orderedValues: readonly string[],
  target: Uint8Array,
): boolean {
  if (target.byteLength === 0) return false;
  let decodedRun: Buffer[] = [];
  const targetBytes = Buffer.from(target);
  for (const value of orderedValues) {
    const decoded = decodeBase64Fragment(value);
    if (decoded === null) {
      decodedRun = [];
      continue;
    }
    decodedRun.push(decoded);
    if (Buffer.concat(decodedRun).includes(targetBytes)) return true;
  }
  return false;
}

export function assertNoEvaluationOracleLeakV1(input: EvaluationOracleLeakInputV1): void {
  const artifactContents: string[] = [];
  const artifactContentBytes: Buffer[] = [];
  const artifactIdentifiers: string[] = [];
  const artifactIdentifierBytes: Buffer[] = [];
  const artifactDigests = new Set<string>();
  for (const artifact of input.oracle.artifacts) {
    if (artifact.reference.trim().length === 0)
      throw new TypeError("oracle artifact reference is empty");
    const declared = DigestV1Schema.parse(artifact.digest);
    const observed = sha256BytesDigestV1(Buffer.from(artifact.bytes));
    if (declared.value !== observed.value) {
      throw new TypeError(
        `oracle artifact ${artifact.reference} bytes do not match declared digest`,
      );
    }
    artifactDigests.add(declared.value);
    artifactIdentifiers.push(...encodedForms(artifact.reference), ...encodedForms(declared.value));
    artifactIdentifierBytes.push(
      Buffer.from(artifact.reference, "utf8"),
      Buffer.from(declared.value, "utf8"),
    );
    if (artifact.bytes.byteLength > 0) artifactContentBytes.push(Buffer.from(artifact.bytes));
    const decoded = Buffer.from(artifact.bytes).toString("utf8");
    if (decoded.length > 0) artifactContents.push(...encodedForms(decoded));
  }

  for (const message of input.messages) {
    if (!MESSAGE_STAGES.has(message.stage))
      throw new TypeError(`unknown reviewer message stage ${message.stage}`);
    if (message.reference.trim().length === 0)
      throw new TypeError("reviewer message reference is empty");
    const content = cloneCanonicalJson(message.content);
    const keys: string[] = [];
    const values: string[] = [];
    collectStrings(content, keys, values);
    const canonicalMessage = canonicalizeJson({ content, reference: message.reference });
    const strings = [message.reference, canonicalMessage, ...keys, ...values];
    const joinedChannels = [keys.join(""), values.join(""), [...keys, ...values].join("")];
    const scanChannels = [...strings, ...joinedChannels];
    if (message.bytes !== undefined) {
      const messageBytes = Buffer.from(message.bytes);
      scanChannels.push(messageBytes.toString("utf8"));
      const digest = sha256BytesDigestV1(messageBytes);
      if (artifactDigests.has(digest.value)) {
        throw new TypeError(
          `oracle artifact entered ${message.stage} message as ${message.reference}`,
        );
      }
      if (artifactContentBytes.some((oracleBytes) => messageBytes.includes(oracleBytes))) {
        throw new TypeError(
          `oracle artifact entered ${message.stage} message as ${message.reference}`,
        );
      }
    }
    if (
      artifactContents.some((oracleContent) => contains(scanChannels, oracleContent)) ||
      artifactContentBytes.some((oracleBytes) =>
        containsSeparatelyEncodedFragments(values, oracleBytes),
      )
    ) {
      throw new TypeError(`oracle content entered ${message.stage} message`);
    }
    if (
      artifactIdentifiers.some((identifier) => contains(scanChannels, identifier)) ||
      artifactIdentifierBytes.some((identifier) =>
        containsSeparatelyEncodedFragments(values, identifier),
      )
    ) {
      throw new TypeError(`oracle artifact identity entered ${message.stage} message`);
    }
    for (const root of input.oracle.expectedRoots) {
      if (
        encodedForms(root.rootId).some((form) => contains(scanChannels, form)) ||
        encodedForms(root.description).some((form) => contains(scanChannels, form)) ||
        containsSeparatelyEncodedFragments(values, Buffer.from(root.rootId, "utf8")) ||
        containsSeparatelyEncodedFragments(values, Buffer.from(root.description, "utf8"))
      ) {
        throw new TypeError(`oracle root entered ${message.stage} message`);
      }
    }
    for (const uncertainty of input.oracle.expectedUncertainties) {
      if (
        encodedForms(uncertainty.uncertaintyId).some((form) => contains(scanChannels, form)) ||
        encodedForms(uncertainty.description).some((form) => contains(scanChannels, form)) ||
        containsSeparatelyEncodedFragments(
          values,
          Buffer.from(uncertainty.uncertaintyId, "utf8"),
        ) ||
        containsSeparatelyEncodedFragments(values, Buffer.from(uncertainty.description, "utf8"))
      ) {
        throw new TypeError(`oracle uncertainty entered ${message.stage} message`);
      }
    }
    for (const label of input.oracle.forbiddenLabels) {
      if (
        encodedForms(label).some((form) => contains(scanChannels, form)) ||
        containsSeparatelyEncodedFragments(values, Buffer.from(label, "utf8"))
      ) {
        throw new TypeError(`forbidden evaluator label entered ${message.stage} message`);
      }
    }
  }
}
