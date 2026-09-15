import { spawn } from "node:child_process";
import { devNull } from "node:os";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_SAFE_DIRECTORY_CONFIG_BYTES = 1024 * 1024;
const MAX_SAFE_DIRECTORY_ENTRIES = 256;

/**
 * Process-wide configuration discovery has its own fixed ceiling instead of borrowing a caller's
 * command timeout. Concurrent callers share this one lookup, so using whichever command arrived
 * first would make forwarding depend on call order. One second permits a slow local protected-
 * scope read while bounding startup. Timeout, overflow, or failure kills the producer, discards
 * all output, and resolves the best-effort lookup empty; the command watchdog starts afterward.
 */
const SAFE_DIRECTORY_DISCOVERY_TIMEOUT_MS = 1_000;

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
    const start = () =>
      spawn("git", ["config", "--get-all", "safe.directory"], {
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        env: ambientGitEnvironment(),
      });
    let child: ReturnType<typeof start>;
    try {
      child = start();
    } catch {
      resolve([]);
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    let watchdog: NodeJS.Timeout | undefined;

    const settle = (safeDirectoryEntries: readonly string[], signal?: NodeJS.Signals): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      child.stdout.destroy();
      if (signal !== undefined) child.kill(signal);
      resolve(safeDirectoryEntries);
    };

    const fail = (): void => settle([], "SIGKILL");

    watchdog = setTimeout(fail, SAFE_DIRECTORY_DISCOVERY_TIMEOUT_MS);
    watchdog.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      length += chunk.length;
      // A pathological config must not become a pathological argument list.
      if (length > MAX_SAFE_DIRECTORY_CONFIG_BYTES) {
        fail();
        return;
      }
      chunks.push(chunk);
    });
    // Exit status 1 simply means the key is unset, and any other failure means capture proceeds
    // without forwarding rather than refusing to run at all.
    child.stdout.on("error", fail);
    child.on("error", fail);
    child.on("close", (exitCode) => {
      if (settled) return;
      if (exitCode !== 0) {
        settle([]);
        return;
      }
      try {
        const entries = new TextDecoder("utf-8", { fatal: true })
          .decode(Buffer.concat(chunks, length))
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        if (
          entries.length > MAX_SAFE_DIRECTORY_ENTRIES ||
          entries.some((entry) => entry.includes("\0"))
        ) {
          settle([]);
          return;
        }
        settle(entries);
      } catch {
        settle([]);
      }
    });
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

/** Streams bounded NUL-delimited Git output without retaining the complete stdout payload. */
export async function runGitNulRecords(
  repositoryPath: string,
  args: readonly string[],
  onRecord: (record: Buffer) => void,
  timeoutMs: number = DEFAULT_GIT_COMMAND_TIMEOUT_MS,
): Promise<void> {
  const environment = gitEnvironment(await safeDirectories());
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repositoryPath, "--literal-pathspecs", ...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    });
    const stderrChunks: Buffer[] = [];
    let pending = Buffer.alloc(0);
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
      if (settled) return;
      stdoutLength += chunk.length;
      if (stdoutLength > MAX_GIT_OUTPUT_BYTES) {
        fail(new Error("Git output exceeded the capture limit"));
        return;
      }
      const available = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let recordStart = 0;
      while (!settled) {
        const recordEnd = available.indexOf(0, recordStart);
        if (recordEnd === -1) break;
        try {
          onRecord(available.subarray(recordStart, recordEnd));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        recordStart = recordEnd + 1;
      }
      if (!settled) pending = Buffer.from(available.subarray(recordStart));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderrLength += chunk.length;
      if (stderrLength > MAX_GIT_OUTPUT_BYTES) {
        fail(new Error("Git diagnostic output exceeded the capture limit"));
        return;
      }
      stderrChunks.push(chunk);
    });
    child.on("error", (error: Error) => fail(error));
    child.on("close", (exitCode) => {
      if (settled) return;
      if (exitCode !== 0) {
        const diagnostic = Buffer.concat(stderrChunks).toString("utf8").trim();
        fail(new Error(diagnostic || `Git exited with status ${exitCode ?? -1}`));
        return;
      }
      if (pending.length !== 0) {
        fail(new Error("Git output ended without a NUL record delimiter"));
        return;
      }
      settled = true;
      clearTimeout(watchdog);
      resolve();
    });
  });
}

/** Runs Git and returns exactly a bounded stdout prefix, stopping the producer once filled. */
export async function runGitStdoutPrefix(
  repositoryPath: string,
  args: readonly string[],
  byteCount: number,
  timeoutMs: number = DEFAULT_GIT_COMMAND_TIMEOUT_MS,
): Promise<Buffer> {
  if (!Number.isSafeInteger(byteCount) || byteCount < 0 || byteCount > MAX_GIT_OUTPUT_BYTES) {
    throw new Error("Git stdout prefix byte count is invalid");
  }
  if (byteCount === 0) return Buffer.alloc(0);
  const environment = gitEnvironment(await safeDirectories());
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repositoryPath, "--literal-pathspecs", ...args], {
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
    const complete = (): void => {
      if (!settled) {
        settled = true;
        clearTimeout(watchdog);
        child.kill("SIGTERM");
        resolve(Buffer.concat(stdoutChunks, byteCount));
      }
    };

    watchdog = setTimeout(() => {
      fail(new Error(`Git command timed out after ${timeoutMs} ms`), "SIGKILL");
    }, timeoutMs);
    watchdog.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = byteCount - stdoutLength;
      if (remaining <= 0) return;
      const admitted = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      stdoutChunks.push(admitted);
      stdoutLength += admitted.length;
      if (stdoutLength === byteCount) complete();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrLength += chunk.length;
      if (stderrLength > MAX_GIT_OUTPUT_BYTES) {
        fail(new Error("Git diagnostic output exceeded the capture limit"));
        return;
      }
      stderrChunks.push(chunk);
    });
    child.on("error", (error: Error) => fail(error));
    child.on("close", (exitCode) => {
      if (settled) return;
      if (exitCode !== 0) {
        const diagnostic = Buffer.concat(stderrChunks).toString("utf8").trim();
        fail(new Error(diagnostic || `Git exited with status ${exitCode ?? -1}`));
        return;
      }
      if (stdoutLength !== byteCount) {
        fail(new Error(`Git produced ${stdoutLength} bytes; expected ${byteCount}`));
        return;
      }
      complete();
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
