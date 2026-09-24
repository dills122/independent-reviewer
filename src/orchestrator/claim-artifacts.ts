import { open } from "node:fs/promises";

/** Artifact contents reach durable storage before a checkpoint grants them authority. */
export async function writeClaimArtifactV1(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Local projection recovery may reuse identical artifacts, but never overwrite different bytes. */
export async function ensureClaimArtifactV1(path: string, content: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return writeClaimArtifactV1(path, content);
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size !== Buffer.byteLength(content, "utf8") ||
      (await handle.readFile("utf8")) !== content
    )
      throw new Error("Existing claim artifact differs from the resumed projection");
  } finally {
    await handle.close();
  }
}
