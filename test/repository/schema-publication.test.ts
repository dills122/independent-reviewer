import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("published contract schemas", () => {
  it("exports every committed schema artifact and no missing artifact", async () => {
    const packageDocument = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      exports: Record<string, string | Record<string, string>>;
    };
    const committedSchemas = (await readdir(resolve("schemas")))
      .filter((name) => name.endsWith(".schema.json"))
      .map((name) => `./schemas/${name}`)
      .sort();
    const exportedSchemas = Object.entries(packageDocument.exports)
      .filter(([name, target]) => name.startsWith("./schemas/") && typeof target === "string")
      .map(([, target]) => target as string)
      .sort();

    assert.deepEqual(exportedSchemas, committedSchemas);
  });
});
