import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  wallMs: number;
}

/**
 * Run a command without a shell, capture output, and hard-kill on timeout.
 * CI=true is forced so tools never enter watch mode or interactive prompts.
 */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<ExecResult> {
  const bin =
    process.platform === "win32" && ["npx", "npm", "pnpm", "yarn"].includes(cmd) ? `${cmd}.cmd` : cmd;
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, CI: "true", ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, timedOut, stdout, stderr: `${stderr}\n${err.message}`, wallMs: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout, stderr, wallMs: Date.now() - started });
    });
  });
}

/** Simple bounded-concurrency promise pool that preserves input order. */
export async function pool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
  return results;
}
