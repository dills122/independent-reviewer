import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { jsonDocument } from "../contracts/json-document.js";
import {
  type SimpleReviewSettingsV2,
  SimpleReviewSettingsV2Schema,
  translateSimpleReviewSettingsV1ToV2,
} from "../contracts/simple-review-settings.js";
import { readStrictJsonFileV1 } from "../contracts/strict-json.js";
import { localReviewDirectory, MAX_LOCAL_JSON_BYTES_V1 } from "./standards-input.js";

const SIMPLE_SETTINGS_FILE_V1 = "simple-settings.json";

export async function readLocalSimpleReviewSettingsV2(
  repositoryPath: string,
): Promise<SimpleReviewSettingsV2 | undefined> {
  const path = join(await localReviewDirectory(repositoryPath), SIMPLE_SETTINGS_FILE_V1);
  try {
    const value = await readStrictJsonFileV1(path, {
      maxBytes: MAX_LOCAL_JSON_BYTES_V1,
      source: "local simple review settings",
    });
    if (typeof value === "object" && value !== null && "schemaVersion" in value) {
      if (value.schemaVersion === 1) return translateSimpleReviewSettingsV1ToV2(value);
      if (value.schemaVersion === 2) return SimpleReviewSettingsV2Schema.parse(value);
    }
    return SimpleReviewSettingsV2Schema.parse(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveLocalSimpleReviewSettingsV2(
  repositoryPath: string,
  value: unknown,
): Promise<string> {
  const settings = SimpleReviewSettingsV2Schema.parse(value);
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
