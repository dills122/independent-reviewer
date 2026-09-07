import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { NEUTRAL_REVIEW_BRIEF_V1_JSON_SCHEMA } from "../src/contracts/neutral-review-brief.js";
import { REVIEW_REQUEST_V1_JSON_SCHEMA } from "../src/contracts/review-request.js";
import { SNAPSHOT_MANIFEST_V1_JSON_SCHEMA } from "../src/contracts/snapshot-manifest.js";

const schemaDirectory = resolve("schemas");
await mkdir(schemaDirectory, { recursive: true });

const schemaArtifacts = [
  ["neutral-review-brief-v1.schema.json", NEUTRAL_REVIEW_BRIEF_V1_JSON_SCHEMA],
  ["review-request-v1.schema.json", REVIEW_REQUEST_V1_JSON_SCHEMA],
  ["snapshot-manifest-v1.schema.json", SNAPSHOT_MANIFEST_V1_JSON_SCHEMA],
] as const;

await Promise.all(
  schemaArtifacts.map(([fileName, schema]) =>
    writeFile(resolve(schemaDirectory, fileName), `${JSON.stringify(schema, null, 2)}\n`, "utf8"),
  ),
);
