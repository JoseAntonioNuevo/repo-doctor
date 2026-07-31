import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUTPUT_CAP = 64 * 1024;

export interface ExecResult {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  wallMs: number;
}

function appendTail(current: Buffer, chunk: Buffer): { value: Buffer; truncated: boolean } {
  const joined = Buffer.concat([current, chunk]);
  if (joined.byteLength <= OUTPUT_CAP) return { value: joined, truncated: false };
  return { value: joined.subarray(joined.byteLength - OUTPUT_CAP), truncated: true };
}

function minimalEnvironment(passEnv: string[], inherited: boolean, extra: Record<string, string>): { env: NodeJS.ProcessEnv; home: string | null } {
  if (inherited) return { env: { ...process.env, CI: "true", ...extra }, home: null };
  const home = mkdtempSync(join(tmpdir(), "repo-doctor-home-"));
  const names = process.platform === "win32"
    ? ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"]
    : ["PATH", "LANG", "LC_ALL", "TMPDIR"];
  const env: NodeJS.ProcessEnv = { CI: "true", HOME: home, USERPROFILE: home };
  for (const name of [...names, ...passEnv]) if (process.env[name] !== undefined) env[name] = process.env[name];
  Object.assign(env, extra);
  return { env, home };
}

/** Run without a shell, capture bounded tails, and kill the complete process tree on timeout. */
export function run(
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    env?: Record<string, string>;
    environment?: "inherit" | "minimal";
    passEnv?: string[];
    inheritEnv?: boolean;
  },
): Promise<ExecResult> {
  if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs <= 0) {
    return Promise.reject(new Error("timeoutMs must be a positive safe integer"));
  }
  const bin = process.platform === "win32" && ["npx", "npm", "pnpm", "yarn", "bun"].includes(cmd) ? `${cmd}.cmd` : cmd;
  const environment = opts.environment === "minimal"
    ? minimalEnvironment(opts.passEnv ?? [], opts.inheritEnv ?? false, opts.env ?? {})
    : { env: { ...process.env, CI: "true", ...opts.env }, home: null };
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: environment.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let escalation: NodeJS.Timeout | null = null;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      if (environment.home) rmSync(environment.home, { recursive: true, force: true });
      resolve({
        code,
        timedOut,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        stdoutTruncated,
        stderrTruncated,
        wallMs: Date.now() - started,
      });
    };
    child.stdout?.on("data", (data: Buffer) => {
      const next = appendTail(stdout, Buffer.from(data));
      stdout = next.value;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr?.on("data", (data: Buffer) => {
      const next = appendTail(stderr, Buffer.from(data));
      stderr = next.value;
      stderrTruncated ||= next.truncated;
    });
    const killTree = (force: boolean): void => {
      if (child.pid === undefined) return;
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore", windowsHide: true });
      } else {
        try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch { /* already exited */ }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(false);
      escalation = setTimeout(() => killTree(true), 5000);
      escalation.unref();
    }, opts.timeoutMs);
    child.once("error", (error) => {
      const next = appendTail(stderr, Buffer.from(`\n${error.message}`));
      stderr = next.value;
      stderrTruncated ||= next.truncated;
      finish(null);
    });
    child.once("close", finish);
  });
}

export async function pool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}
