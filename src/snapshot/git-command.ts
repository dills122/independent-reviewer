import { spawn } from "node:child_process";
import { devNull } from "node:os";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Default ceiling for a single Git invocation; a wedged Git must not hang the review. */
export const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 60_000;

/**
 * Variables copied from the ambient environment. Everything else is dropped so that
 * `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_*`, `GIT_EXTERNAL_DIFF` and friends
 * cannot redirect capture at a repository the caller never named.
 *
 * Dropping `GIT_CONFIG_*` from the environment never stopped Git reading the configuration files
 * themselves, and `HOME` is inherited; `gitEnvironment` below pins those files away instead.
 */
const INHERITED_ENVIRONMENT_NAMES = ["PATH", "HOME", "SystemRoot", "PATHEXT", "TMP", "TEMP"];

/**
 * Reads the `safe.directory` entries the user configured, before capture isolates their config.
 *
 * Resolved once per process against the real global and system configuration, with no repository
 * argument so only those two scopes are consulted -- `safe.directory` is ignored in repository
 * config by design, which is exactly what makes it worth forwarding rather than re-deriving.
 */
let configuredSafeDirectories: Promise<readonly string[]> | undefined;

function ambientGitEnvironment(): NodeJS.ProcessEnv {
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

async function readConfiguredSafeDirectories(): Promise<readonly string[]> {
  return new Promise((resolve) => {
    const child = spawn("git", ["config", "--get-all", "safe.directory"], {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      env: ambientGitEnvironment(),
    });
    const chunks: Buffer[] = [];
    let length = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      // A pathological config must not become a pathological argument list.
      if (length <= 1024 * 1024) chunks.push(chunk);
    });
    // Exit status 1 simply means the key is unset, and any other failure means capture proceeds
    // without forwarding rather than refusing to run at all.
    const settle = (): void => {
      resolve(
        Buffer.concat(chunks)
          .toString("utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .slice(0, 256),
      );
    };
    child.on("error", () => resolve([]));
    child.on("close", settle);
  });
}

function safeDirectories(): Promise<readonly string[]> {
  configuredSafeDirectories ??= readConfiguredSafeDirectories();
  return configuredSafeDirectories;
}

/** Resets the cached lookup. Tests only; a process otherwise resolves it once. */
export function resetGitConfigIsolationCacheV1(): void {
  configuredSafeDirectories = undefined;
}

/**
 * The environment every capture command runs in.
 *
 * Global and system configuration are pinned to the null device, so nothing outside the
 * repository can decide what capture sees. That is not tidiness: `core.excludesFile` changes
 * which untracked files are captured at all, and `core.attributesFile` changes whether a file is
 * reviewed as SOURCE or excluded as generated. Both live in the developer's home directory, and
 * neither is recorded in the snapshot, so the same commit produced different snapshots on
 * different machines (#129).
 *
 * `safe.directory` is forwarded back in, because it governs whether Git will operate at all
 * rather than what it reports. Isolation would otherwise break capture wherever the checkout is
 * owned by another user, which is ordinary in containers and shared mounts. Only the entries the
 * user already configured are forwarded, so this re-admits their existing trust decisions and
 * invents none. This is the one place `GIT_CONFIG_*` is set deliberately, with values the runner
 * constructs rather than inherits.
 */
function gitEnvironment(forwardedSafeDirectories: readonly string[]): NodeJS.ProcessEnv {
  const environment = ambientGitEnvironment();
  environment.GIT_CONFIG_GLOBAL = devNull;
  environment.GIT_CONFIG_SYSTEM = devNull;
  forwardedSafeDirectories.forEach((directory, index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = "safe.directory";
    environment[`GIT_CONFIG_VALUE_${index}`] = directory;
  });
  environment.GIT_CONFIG_COUNT = String(forwardedSafeDirectories.length);
  return environment;
}

export interface GitResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

/**
 * Runs Git without a shell so repository paths, refs, and pathspecs remain data.
 *
 * `literalPathspecs` defaults to true and should stay that way for anything that takes a pathspec.
 * A few plumbing commands (`check-ignore`) reject the flag outright, so they opt out.
 */
export async function runGit(
  repositoryPath: string,
  args: readonly string[],
  allowedExitCodes: readonly number[] = [0],
  timeoutMs: number = DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  literalPathspecs = true,
): Promise<GitResult> {
  const environment = gitEnvironment(await safeDirectories());
  return new Promise((resolve, reject) => {
    // `--literal-pathspecs` keeps paths as data: no wildcard globbing, no `:(magic)` prefixes.
    const globalArgs = literalPathspecs ? ["--literal-pathspecs"] : [];
    const child = spawn("git", ["-C", repositoryPath, ...globalArgs, ...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
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
