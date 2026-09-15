import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as z from "zod";
import { jsonDocument } from "../contracts/json-document.js";
import { NonEmptyTextSchema } from "../contracts/primitives.js";
import { FlowIdSchema } from "../contracts/review-request.js";
import { ReviewRunConfigV3Schema } from "../contracts/review-run-config.js";
import {
  declinedAuthorContextV1,
  MAX_EXTERNAL_JSON_BYTES_V1,
  providedAuthorContextV1,
  ReviewAuthorSchema,
  StandardsProfileSchema,
  StandardsReviewRequestV3Schema,
} from "../contracts/standards-review.js";
import { readStrictJsonFileV1 } from "../contracts/strict-json.js";
import { resolveRepositoryRootV1 } from "../snapshot/git-capture.js";
import { runGit } from "../snapshot/git-command.js";

export interface StandardsCliOptionsV1 {
  repo?: string;
  config?: string;
  standards?: string;
  author?: string;
  noAuthor?: boolean;
  requireAuthorExplanation?: boolean;
  newFlow?: boolean;
  base?: string;
}

export const MAX_LOCAL_JSON_BYTES_V1 = 1024 * 1024;
export const LocalReviewSettingsV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  config: NonEmptyTextSchema,
  standards: NonEmptyTextSchema,
  author: NonEmptyTextSchema,
});
const FlowStateSchema = z.strictObject({ schemaVersion: z.literal(1), flowId: FlowIdSchema });
export async function localReviewDirectory(repo: string): Promise<string> {
  const result = await runGit(repo, ["rev-parse", "--git-path", "independent-reviewer"]);
  return resolve(repo, result.stdout.toString("utf8").trim());
}
export async function loadLocalSettings(
  options: StandardsCliOptionsV1,
): Promise<StandardsCliOptionsV1> {
  const repo = await resolveRepositoryRootV1(options.repo ?? process.cwd());
  const directory = await localReviewDirectory(repo);
  try {
    const settings = LocalReviewSettingsV1Schema.parse(
      await readStrictJsonFileV1(join(directory, "settings.json"), {
        maxBytes: MAX_LOCAL_JSON_BYTES_V1,
        source: "local review settings",
      }),
    );
    return {
      ...options,
      config: options.config ?? settings.config,
      standards: options.standards ?? settings.standards,
      author: options.author ?? settings.author,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return options;
  }
}
export async function saveLocalSettings(options: StandardsCliOptionsV1): Promise<string> {
  const repo = await resolveRepositoryRootV1(options.repo ?? process.cwd());
  const paths = Object.fromEntries(
    ["config", "standards", "author"].map((name) => {
      const path = options[name as "config" | "standards" | "author"];
      if (!path) throw new Error(`Provide --${name} when initializing review settings.`);
      return [name, resolve(path)];
    }),
  );
  const settings = LocalReviewSettingsV1Schema.parse({ schemaVersion: 1, ...paths });
  ReviewRunConfigV3Schema.parse(
    await readStrictJsonFileV1(settings.config, {
      maxBytes: MAX_LOCAL_JSON_BYTES_V1,
      source: "review configuration",
    }),
  );
  StandardsProfileSchema.parse(
    await readStrictJsonFileV1(settings.standards, {
      maxBytes: MAX_EXTERNAL_JSON_BYTES_V1,
      source: "standards profile",
    }),
  );
  await readAuthor(settings.author);
  const directory = await localReviewDirectory(repo);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "settings.json");
  try {
    await writeFile(path, jsonDocument(settings), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `Settings already exist at ${path}; edit them explicitly or override with flags.`,
      );
    throw error;
  }
  return path;
}
async function readAuthor(path: string) {
  if (path.endsWith(".json"))
    return ReviewAuthorSchema.parse(
      await readStrictJsonFileV1(path, {
        maxBytes: MAX_EXTERNAL_JSON_BYTES_V1,
        source: "author packet",
      }),
    );
  const text = await readFile(path, "utf8");
  if (!text.trim()) throw new Error("Author overview must not be empty.");
  return ReviewAuthorSchema.parse({ schemaVersion: 2, overview: text, claimedVerification: [] });
}
/** No state is written until capture and admission succeed. Exclusive instance claims arbitrate concurrent starts. */
export async function assembleStandardsRequest(
  options: StandardsCliOptionsV1,
  suppliedConfig?: z.infer<typeof ReviewRunConfigV3Schema>,
) {
  const repo = await resolveRepositoryRootV1(options.repo ?? process.cwd());
  const standardPath = options.standards;
  const authorPath = options.author;
  const configPath = options.config;
  if (!standardPath || (!configPath && !suppliedConfig))
    throw new Error("Provide --standards and either --config or simple model/cost settings.");
  if (options.noAuthor && authorPath)
    throw new Error("Use either --author or --no-author, not both.");
  if (!authorPath && !options.noAuthor && options.requireAuthorExplanation !== false)
    throw new Error(
      "Author explanation is required; provide --author or explicitly use --no-author.",
    );
  const profile = StandardsProfileSchema.parse(
    await readStrictJsonFileV1(resolve(standardPath), {
      maxBytes: MAX_EXTERNAL_JSON_BYTES_V1,
      source: "standards profile",
    }),
  );
  const author = authorPath ? await readAuthor(resolve(authorPath)) : undefined;
  const config =
    suppliedConfig ??
    ReviewRunConfigV3Schema.parse(
      await readStrictJsonFileV1(resolve(configPath as string), {
        maxBytes: MAX_LOCAL_JSON_BYTES_V1,
        source: "review configuration",
      }),
    );
  const directory = await localReviewDirectory(repo);
  const pointer = join(directory, "flow.json");
  let flowId = `flow_${randomUUID()}`;
  let existing = false;
  if (!options.newFlow)
    try {
      flowId = FlowStateSchema.parse(
        await readStrictJsonFileV1(pointer, {
          maxBytes: MAX_LOCAL_JSON_BYTES_V1,
          source: "local review flow state",
        }),
      ).flowId;
      existing = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  let number = 1;
  for (; number <= 3; number++) {
    try {
      await readFile(join(directory, `${flowId}-${number}.claim`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  if (number > 3)
    throw new Error(
      "This review flow has used all three instances. Start a distinct review with --new-flow.",
    );
  const request = StandardsReviewRequestV3Schema.parse({
    schemaVersion: 3,
    mode: "STANDARDS",
    flowId,
    reviewInstance: { number, maximum: 3 },
    repository: {
      path: repo,
      ...(options.base ? { base: options.base } : {}),
    },
    canonicalInputs: {
      standards: [
        {
          id: "input_standards",
          title: profile.name,
          kind: "PROJECT_GUIDANCE",
          content: jsonDocument(profile),
          provenance: { type: "REPOSITORY_FILE", path: resolve(standardPath) },
        },
      ],
    },
    authorContext: author ? providedAuthorContextV1(author) : declinedAuthorContextV1(),
    ...(author ? { authorPacket: author } : {}),
    reviewConfigRef: config.configId,
  });
  return {
    request,
    excludedPaths: [
      resolve(standardPath),
      ...(authorPath ? [resolve(authorPath)] : []),
      ...(configPath ? [resolve(configPath)] : []),
    ],
    async claim() {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!existing) {
        const contents = jsonDocument({ schemaVersion: 1, flowId });
        if (options.newFlow) {
          const temporary = join(directory, `flow-${randomUUID()}.tmp`);
          await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
          await rename(temporary, pointer);
        } else await writeFile(pointer, contents, { flag: "wx", mode: 0o600 });
      } else {
        const current = FlowStateSchema.parse(
          await readStrictJsonFileV1(pointer, {
            maxBytes: MAX_LOCAL_JSON_BYTES_V1,
            source: "local review flow state",
          }),
        );
        if (current.flowId !== flowId)
          throw new Error("Review flow changed during preparation; rerun against current state.");
      }
      await writeFile(
        join(directory, `${flowId}-${number}.claim`),
        jsonDocument({ flowId, number }),
        { flag: "wx", mode: 0o600 },
      );
    },
  };
}
