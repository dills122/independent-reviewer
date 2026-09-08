import { spawn } from "node:child_process";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface GitResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

/** Runs Git without a shell so repository paths, refs, and pathspecs remain data. */
export async function runGit(
  repositoryPath: string,
  args: readonly string[],
  allowedExitCodes: readonly number[] = [0],
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repositoryPath, ...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(error);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutLength += chunk.length;
      if (stdoutLength > MAX_GIT_OUTPUT_BYTES) {
        fail(new Error("Git output exceeded the capture limit"));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrLength += chunk.length;
      if (stderrLength > MAX_GIT_OUTPUT_BYTES) {
        fail(new Error("Git diagnostic output exceeded the capture limit"));
        return;
      }
      stderrChunks.push(chunk);
    });
    child.on("error", fail);
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      const result = {
        exitCode: exitCode ?? -1,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      };
      if (!allowedExitCodes.includes(result.exitCode)) {
        const diagnostic = result.stderr.toString("utf8").trim();
        reject(new Error(diagnostic || `Git exited with status ${result.exitCode}`));
        return;
      }
      resolve(result);
    });
  });
}

export function decodeGitText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
}

export function decodeNulFields(bytes: Uint8Array): string[] {
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const fields = decoded.split("\0");
  if (fields.at(-1) === "") {
    fields.pop();
  }
  return fields;
}
