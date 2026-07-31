import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { DuplicateGroup, FileInfo } from "./types.ts";
import { pool, run } from "./exec.ts";

/**
 * File inventory: enumerate git-tracked files, hash their content, and derive
 * the size and duplicate views every later stage builds on.
 *
 * Everything here works on repo-root-relative posix paths — exactly what
 * `git ls-files` emits — so artifacts stay portable across machines.
 */

/**
 * List every git-tracked file in `cwd`, sorted, posix separators.
 *
 * `-z` output is NUL-separated and unquoted, so unusual filenames (spaces,
 * unicode) survive round-tripping. Only the index (`--cached`) is consulted —
 * untracked and ignored files are invisible to the whole pipeline on purpose.
 */
export async function listTrackedFiles(cwd: string): Promise<string[]> {
  const res = await run("git", ["ls-files", "-z", "--cached"], { cwd, timeoutMs: 120_000 });
  if (res.code !== 0) {
    const detail = res.stderr.trim().split("\n")[0] || `git exited with code ${res.code}`;
    throw new Error(`${cwd} is not a git repository (or git failed): ${detail}`);
  }
  return res.stdout
    .split("\0")
    .filter((p) => p.length > 0)
    .sort();
}

/**
 * Read and sha1-hash tracked files with bounded concurrency.
 *
 * Symlinks are recorded as the LINK itself, never its target: bytes are the
 * link's own size and the hash covers the target path string (what git tracks),
 * so `CLAUDE.md -> AGENTS.md` never reads as byte-identical to `AGENTS.md`.
 * Broken links still resolve this way. Paths that cannot be stat'ed or read
 * (deleted locally but still in the index, submodule gitlinks…) are silently
 * skipped — the caller detects skips by comparing input and output lengths and
 * surfaces a warning.
 */
export async function collectFileInfo(
  cwd: string,
  paths: string[],
  concurrency = 8,
): Promise<FileInfo[]> {
  const infos = await pool(paths, concurrency, async (relPath): Promise<FileInfo | null> => {
    try {
      const abs = join(cwd, relPath);
      const stats = await lstat(abs);
      if (stats.isSymbolicLink()) {
        const target = await readlink(abs);
        return {
          path: relPath,
          bytes: stats.size,
          hash: createHash("sha1").update(target).digest("hex"),
          ext: extOf(relPath),
          symlink: true,
        };
      }
      const buf = await readFile(abs);
      return {
        path: relPath,
        bytes: buf.byteLength,
        hash: createHash("sha1").update(buf).digest("hex"),
        ext: extOf(relPath),
        symlink: false,
      };
    } catch {
      return null;
    }
  });
  return infos.filter((i): i is FileInfo => i !== null).sort(byPath);
}

/**
 * Group byte-identical files by content hash.
 *
 * Symlinks never participate: a link is a pointer, not a redundant copy, and
 * deleting either side of a link/target pair breaks the repo. Empty files are
 * excluded by default (`minBytes` 1): zero-byte placeholders like `.gitkeep`
 * or `__init__.py` are duplicates only in the most useless sense and would
 * flood the report.
 */
export function findDuplicates(files: FileInfo[], minBytes = 1): DuplicateGroup[] {
  const byHash = new Map<string, FileInfo[]>();
  for (const f of files) {
    if (f.symlink || f.bytes < minBytes) continue;
    const members = byHash.get(f.hash);
    if (members) members.push(f);
    else byHash.set(f.hash, [f]);
  }
  const groups: DuplicateGroup[] = [];
  for (const [hash, members] of byHash) {
    if (members.length < 2) continue;
    const paths = members.map((m) => m.path).sort();
    groups.push({
      hash,
      bytes: members[0].bytes,
      paths,
      wastedBytes: members[0].bytes * (paths.length - 1),
    });
  }
  groups.sort((a, b) => b.wastedBytes - a.wastedBytes || (a.hash < b.hash ? -1 : 1));
  return groups;
}

/** Top-n tracked files by size — report-only context; bytes desc, path asc tiebreak. */
export function largestFiles(files: FileInfo[], n: number): FileInfo[] {
  return [...files].sort((a, b) => b.bytes - a.bytes || byPath(a, b)).slice(0, Math.max(0, n));
}

function byPath(a: FileInfo, b: FileInfo): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Lowercase extension without the dot; "" for extensionless files and dotfiles like `.env`. */
function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}
