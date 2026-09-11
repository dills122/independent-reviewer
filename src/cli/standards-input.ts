import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as z from "zod";
import { jsonDocument } from "../contracts/json-document.js";
import { NonEmptyTextSchema } from "../contracts/primitives.js";
import { FlowIdSchema } from "../contracts/review-request.js";
import { ReviewRunConfigV3Schema } from "../contracts/review-run-config.js";
import {
  ReviewAuthorSchema,
  StandardsProfileSchema,
  StandardsReviewRequestV2Schema,
} from "../contracts/standards-review.js";
import { resolveRepositoryRootV1 } from "../snapshot/git-capture.js";
import { runGit } from "../snapshot/git-command.js";

type Options = Map<string, string | true>;
export const LocalReviewSettingsV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  config: NonEmptyTextSchema,
  standards: NonEmptyTextSchema,
  author: NonEmptyTextSchema,
});
const FlowStateSchema = z.strictObject({ schemaVersion: z.literal(1), flowId: FlowIdSchema });
function option(options: Options, name: string): string | undefined {
  const value = options.get(name);
  return typeof value === "string" ? value : undefined;
}
export async function localReviewDirectory(repo: string): Promise<string> {
  const result = await runGit(repo, ["rev-parse", "--git-path", "independent-reviewer"]);
  return resolve(repo, result.stdout.toString("utf8").trim());
}
export async function loadLocalSettings(options: Options): Promise<void> {
  const repo = await resolveRepositoryRootV1(option(options, "--repo") ?? process.cwd());
  const directory = await localReviewDirectory(repo);
  try {
    const settings = LocalReviewSettingsV1Schema.parse(
      JSON.parse(await readFile(join(directory, "settings.json"), "utf8")),
    );
    for (const name of ["config", "standards", "author"] as const)
      if (!options.has(`--${name}`)) options.set(`--${name}`, settings[name]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
export async function saveLocalSettings(options: Options): Promise<string> {
  const repo = await resolveRepositoryRootV1(option(options, "--repo") ?? process.cwd());
  const paths = Object.fromEntries(
    ["config", "standards", "author"].map((name) => {
      const path = option(options, `--${name}`);
      if (!path) throw new Error(`Provide --${name} when initializing review settings.`);
      return [name, resolve(path)];
    }),
  );
  const settings = LocalReviewSettingsV1Schema.parse({ schemaVersion: 1, ...paths });
  ReviewRunConfigV3Schema.parse(JSON.parse(await readFile(settings.config, "utf8")));
  StandardsProfileSchema.parse(JSON.parse(await readFile(settings.standards, "utf8")));
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
  const text = await readFile(path, "utf8");
  if (path.endsWith(".json")) return ReviewAuthorSchema.parse(JSON.parse(text));
  if (!text.trim()) throw new Error("Author overview must not be empty.");
  return ReviewAuthorSchema.parse({ schemaVersion: 2, overview: text, claimedVerification: [] });
}
/** No state is written until capture and admission succeed. Exclusive instance claims arbitrate concurrent starts. */
export async function assembleStandardsRequest(options: Options) {
  const repo = await resolveRepositoryRootV1(option(options, "--repo") ?? process.cwd());
  const standardPath = option(options, "--standards");
  const authorPath = option(options, "--author");
  const configPath = option(options, "--config");
  if (!standardPath || !authorPath || !configPath)
    throw new Error("Provide --standards, --author and --config, or save them with init.");
  const profile = StandardsProfileSchema.parse(
    JSON.parse(await readFile(resolve(standardPath), "utf8")),
  );
  const author = await readAuthor(resolve(authorPath));
  const config = ReviewRunConfigV3Schema.parse(
    JSON.parse(await readFile(resolve(configPath), "utf8")),
  );
  const directory = await localReviewDirectory(repo);
  const pointer = join(directory, "flow.json");
  let flowId = `flow_${randomUUID()}`;
  let existing = false;
  if (!options.has("--new-flow"))
    try {
      flowId = FlowStateSchema.parse(JSON.parse(await readFile(pointer, "utf8"))).flowId;
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
  const request = StandardsReviewRequestV2Schema.parse({
    schemaVersion: 2,
    mode: "STANDARDS",
    flowId,
    reviewInstance: { number, maximum: 3 },
    repository: {
      path: repo,
      ...(option(options, "--base") ? { base: option(options, "--base") } : {}),
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
    authorPacket: author,
    reviewConfigRef: config.configId,
  });
  return {
    request,
    excludedPaths: [resolve(standardPath), resolve(authorPath), resolve(configPath)],
    async claim() {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!existing) {
        const contents = jsonDocument({ schemaVersion: 1, flowId });
        if (options.has("--new-flow")) {
          const temporary = join(directory, `flow-${randomUUID()}.tmp`);
          await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
          await rename(temporary, pointer);
        } else await writeFile(pointer, contents, { flag: "wx", mode: 0o600 });
      } else {
        const current = FlowStateSchema.parse(JSON.parse(await readFile(pointer, "utf8")));
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
