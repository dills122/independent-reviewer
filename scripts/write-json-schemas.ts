import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { REVIEW_REQUEST_V1_JSON_SCHEMA } from "../src/contracts/review-request.js";

const schemaDirectory = resolve("schemas");
await mkdir(schemaDirectory, { recursive: true });
await writeFile(
  resolve(schemaDirectory, "review-request-v1.schema.json"),
  `${JSON.stringify(REVIEW_REQUEST_V1_JSON_SCHEMA, null, 2)}\n`,
  "utf8",
);
