import { spawn } from "node:child_process";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Default ceiling for a single Git invocation; a wedged Git must not hang the review. */
export const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 60_000;

/**
 * Variables copied from the ambient environment. Everything else is dropped so that
 * `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_*`, `GIT_EXTERNAL_DIFF` and friends
 * cannot redirect capture at a repository the caller never named.
 */
const INHERITED_ENVIRONMENT_NAMES = ["PATH", "HOME", "SystemRoot", "PATHEXT", "TMP", "TEMP"];

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
  for (const name of INHERITED_ENVIRONMENT_NAMES) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

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
  timeoutMs: number = DEFAULT_GIT_COMMAND_TIMEOUT_MS,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    // `--literal-pathspecs` keeps paths as data: no wildcard globbing, no `:(magic)` prefixes.
    const child = spawn("git", ["-C", repositoryPath, "--literal-pathspecs", ...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnvironment(),
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let settled = false;
    let watchdog: NodeJS.Timeout | undefined;

    const fail = (error: Error, signal: NodeJS.Signals = "SIGTERM"): void => {
      if (!settled) {
        settled = true;
        clearTimeout(watchdog);
        child.kill(signal);
        reject(error);
      }
    };

    watchdog = setTimeout(() => {
      fail(new Error(`Git command timed out after ${timeoutMs} ms`), "SIGKILL");
    }, timeoutMs);
    watchdog.unref();

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
    child.on("error", (error: Error) => {
      fail(error);
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(watchdog);
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
