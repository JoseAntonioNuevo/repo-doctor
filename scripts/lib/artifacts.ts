import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

export const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

export class ArtifactError extends Error {}

export function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** Stable JSON used for option and inventory digests. */
export function canonicalJson(value: unknown): string {
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(visit);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, visit(child)]),
      );
    }
    return input;
  };
  return JSON.stringify(visit(value));
}

export interface SafePathOptions {
  cwd: string;
  allowOutside?: boolean;
  rejectTracked?: boolean;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function existingAncestor(path: string): string {
  let current = path;
  while (!pathEntryExists(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function rejectSymlinkComponents(root: string, candidate: string, allowOutside: boolean): void {
  const start = !allowOutside && isWithin(root, candidate) ? root : parse(candidate).root;
  const rel = relative(start, candidate);
  let cursor = start;
  if (lstatSync(cursor).isSymbolicLink()) throw new ArtifactError(`artifact path contains a symlink: ${cursor}`);
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    if (!pathEntryExists(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) throw new ArtifactError(`artifact path contains a symlink: ${cursor}`);
  }
}

/** Reject symlinks at every existing component so writes cannot escape by redirection. */
export function resolveSafePath(path: string, options: SafePathOptions): string {
  const root = realpathSync(resolve(options.cwd));
  const candidate = resolve(root, path);
  if (!options.allowOutside && !isWithin(root, candidate)) {
    throw new ArtifactError(`artifact path escapes target repository: ${candidate}`);
  }

  const ancestor = existingAncestor(candidate);
  const ancestorReal = realpathSync(ancestor);
  if (!options.allowOutside && !isWithin(root, ancestorReal)) {
    throw new ArtifactError(`artifact path resolves outside target repository: ${candidate}`);
  }

  rejectSymlinkComponents(root, candidate, options.allowOutside ?? false);

  if (options.rejectTracked && isWithin(root, candidate)) {
    const repoRelative = relative(root, candidate).replace(/\\/g, "/");
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", "--", repoRelative], {
        cwd: root,
        stdio: "ignore",
      });
      throw new ArtifactError(`refusing to overwrite tracked artifact path: ${repoRelative}`);
    } catch (error) {
      if (error instanceof ArtifactError) throw error;
    }
  }
  return candidate;
}

export function readJsonArtifact<T>(
  path: string,
  options: SafePathOptions,
): { value: T; text: string; digest: string; path: string } {
  const safe = resolveSafePath(path, options);
  const stat = lstatSync(safe);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ArtifactError(`artifact input must be a regular non-symlink file: ${safe}`);
  }
  if (stat.size > MAX_ARTIFACT_BYTES) {
    throw new ArtifactError(`artifact exceeds ${MAX_ARTIFACT_BYTES} byte limit: ${safe}`);
  }
  const bytes = readFileSync(safe);
  let value: T;
  try {
    value = JSON.parse(bytes.toString("utf8")) as T;
  } catch (error) {
    throw new ArtifactError(`artifact is not valid JSON: ${safe} — ${(error as Error).message}`);
  }
  return { value, text: bytes.toString("utf8"), digest: sha256(bytes), path: safe };
}

function ensureSafeDirectories(root: string, parent: string, allowOutside: boolean): void {
  if (!allowOutside && !isWithin(root, parent)) {
    throw new ArtifactError(`artifact parent escapes target repository: ${parent}`);
  }
  const missing: string[] = [];
  let cursor = parent;
  while (!existsSync(cursor)) {
    missing.push(cursor);
    cursor = dirname(cursor);
  }
  if (lstatSync(cursor).isSymbolicLink()) throw new ArtifactError(`artifact parent is a symlink: ${cursor}`);
  for (const dir of missing.reverse()) {
    mkdirSync(dir, { mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw new ArtifactError(`artifact parent became a symlink: ${dir}`);
  }
}

export function writeArtifactAtomic(
  path: string,
  content: string,
  options: SafePathOptions,
): string {
  const root = realpathSync(resolve(options.cwd));
  const safe = resolveSafePath(path, { ...options, rejectTracked: options.rejectTracked ?? true });
  const parent = dirname(safe);
  ensureSafeDirectories(root, parent, options.allowOutside ?? false);
  const parentBefore = realpathSync(parent);
  if (existsSync(safe)) {
    const stat = lstatSync(safe);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new ArtifactError(`artifact destination must be a regular non-symlink file: ${safe}`);
    }
  }
  const temp = `${safe}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
  let fd: number | null = null;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (realpathSync(parent) !== parentBefore || lstatSync(parent).isSymbolicLink()) {
      throw new ArtifactError(`artifact parent changed during write: ${parent}`);
    }
    renameSync(temp, safe);
    try {
      const parentFd = openSync(parent, constants.O_RDONLY);
      fsyncSync(parentFd);
      closeSync(parentFd);
    } catch {
      // Directory fsync is not supported on every platform; file fsync still completed.
    }
    return safe;
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function assertDistinctArtifactPaths(paths: string[]): void {
  const normalized = paths.map((path) => resolve(path));
  if (new Set(normalized).size !== normalized.length) {
    throw new ArtifactError("artifact input and output paths must be distinct");
  }
}
