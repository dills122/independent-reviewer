import { cloneCanonicalJson } from "../src/contracts/canonical-json.js";
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

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      output.push(key);
      collectStrings(nested, output);
    }
  }
}

function contains(haystacks: readonly string[], needle: string): boolean {
  return needle.length > 0 && haystacks.some((haystack) => haystack.includes(needle));
}

export function assertNoEvaluationOracleLeakV1(input: EvaluationOracleLeakInputV1): void {
  const artifactContents: string[] = [];
  const artifactIdentifiers: string[] = [];
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
    artifactIdentifiers.push(artifact.reference, declared.value);
    const decoded = Buffer.from(artifact.bytes).toString("utf8");
    if (decoded.length > 0) artifactContents.push(decoded);
    artifactContents.push(Buffer.from(artifact.bytes).toString("base64"));
  }

  for (const message of input.messages) {
    if (!MESSAGE_STAGES.has(message.stage))
      throw new TypeError(`unknown reviewer message stage ${message.stage}`);
    if (message.reference.trim().length === 0)
      throw new TypeError("reviewer message reference is empty");
    const content = cloneCanonicalJson(message.content);
    const strings = [message.reference];
    collectStrings(content, strings);
    if (message.bytes !== undefined) {
      const digest = sha256BytesDigestV1(Buffer.from(message.bytes));
      if (artifactDigests.has(digest.value)) {
        throw new TypeError(
          `oracle artifact entered ${message.stage} message as ${message.reference}`,
        );
      }
    }
    if (artifactContents.some((oracleContent) => contains(strings, oracleContent))) {
      throw new TypeError(`oracle content entered ${message.stage} message`);
    }
    if (artifactIdentifiers.some((identifier) => contains(strings, identifier))) {
      throw new TypeError(`oracle artifact identity entered ${message.stage} message`);
    }
    for (const root of input.oracle.expectedRoots) {
      if (contains(strings, root.rootId) || contains(strings, root.description)) {
        throw new TypeError(`oracle root entered ${message.stage} message`);
      }
    }
    for (const uncertainty of input.oracle.expectedUncertainties) {
      if (
        contains(strings, uncertainty.uncertaintyId) ||
        contains(strings, uncertainty.description)
      ) {
        throw new TypeError(`oracle uncertainty entered ${message.stage} message`);
      }
    }
    for (const label of input.oracle.forbiddenLabels) {
      if (contains(strings, label)) {
        throw new TypeError(`forbidden evaluator label entered ${message.stage} message`);
      }
    }
  }
}
