import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { FileInfo, RepositoryIdentity, RepositorySnapshot } from "./types.ts";
import { canonicalJson, sha256 } from "./artifacts.ts";

function git(cwd: string, args: string[], allowFailure = false): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowFailure) return "";
    throw new Error(`git ${args.join(" ")} failed: ${(error as Error).message}`);
  }
}

function gitSucceeds(cwd: string, args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function repositoryIdentity(cwd: string): RepositoryIdentity {
  const root = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
  const head = git(root, ["rev-parse", "--verify", "HEAD"], true).trim() || null;
  const rootCommits = head
    ? git(root, ["rev-list", "--max-parents=0", "HEAD"]).trim().split(/\s+/).filter(Boolean).sort()
    : [];
  const kind = head ? "git-history" : "local-unborn";
  const identityMaterial = head ? { kind, rootCommits } : { kind, commonDir: git(root, ["rev-parse", "--git-common-dir"]).trim() };
  return {
    id: sha256(canonicalJson(identityMaterial)),
    kind,
    root,
    head,
    rootCommits,
  };
}

export function indexDigest(cwd: string): string {
  const raw = execFileSync("git", ["ls-files", "-s", "-z", "--cached"], {
    cwd,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

export function inventoryDigest(files: FileInfo[]): string {
  return sha256(
    canonicalJson(
      files.map((file) => ({
        path: file.path,
        bytes: file.bytes,
        hash: file.hash,
        mode: file.mode ?? null,
        objectId: file.objectId ?? null,
        symlink: file.symlink,
      })),
    ),
  );
}

export function trackedWorktreeClean(cwd: string): boolean {
  return git(cwd, ["status", "--porcelain=v1", "--untracked-files=no"]).trim() === "";
}

export function repositorySnapshot(cwd: string, files: FileInfo[]): RepositorySnapshot {
  const status = git(cwd, ["status", "--porcelain=v1"])
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .sort();
  return {
    repository: repositoryIdentity(cwd),
    inventoryDigest: inventoryDigest(files),
    indexDigest: indexDigest(cwd),
    trackedWorktreeClean: trackedWorktreeClean(cwd),
    gitStatus: status,
  };
}

export function assertBaselineHistory(cwd: string, baselineHead: string | null): void {
  if (baselineHead === null) return;
  if (!gitSucceeds(cwd, ["cat-file", "-e", `${baselineHead}^{commit}`])) {
    throw new Error(`baseline commit is not present in this repository: ${baselineHead}`);
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", baselineHead, "HEAD"], { cwd, stdio: "ignore" });
  } catch {
    throw new Error(`baseline commit is not an ancestor of current HEAD: ${baselineHead}`);
  }
}
