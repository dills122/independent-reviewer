import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type SimpleReviewSettingsV1,
  SimpleReviewSettingsV1Schema,
} from "../contracts/simple-review-settings.js";
import { jsonDocument } from "../contracts/json-document.js";
import { readStrictJsonFileV1 } from "../contracts/strict-json.js";
import { localReviewDirectory, MAX_LOCAL_JSON_BYTES_V1 } from "./standards-input.js";

const SIMPLE_SETTINGS_FILE_V1 = "simple-settings.json";

export async function readLocalSimpleReviewSettingsV1(
  repositoryPath: string,
): Promise<SimpleReviewSettingsV1 | undefined> {
  const path = join(await localReviewDirectory(repositoryPath), SIMPLE_SETTINGS_FILE_V1);
  try {
    return SimpleReviewSettingsV1Schema.parse(
      await readStrictJsonFileV1(path, {
        maxBytes: MAX_LOCAL_JSON_BYTES_V1,
        source: "local simple review settings",
      }),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveLocalSimpleReviewSettingsV1(
  repositoryPath: string,
  value: unknown,
): Promise<string> {
  const settings = SimpleReviewSettingsV1Schema.parse(value);
  const directory = await localReviewDirectory(repositoryPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, SIMPLE_SETTINGS_FILE_V1);
  try {
    await writeFile(path, jsonDocument(settings), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Simple settings already exist at ${path}; edit them explicitly or override with flags.`,
      );
    }
    throw error;
  }
  return path;
}
