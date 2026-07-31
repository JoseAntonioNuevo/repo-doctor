import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectFileInfo,
  findDuplicates,
  largestFiles,
  listTrackedFiles,
} from "../scripts/lib/walk.ts";
import type { FileInfo } from "../scripts/lib/types.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rd-walk-"));
  dirs.push(dir);
  return dir;
}

/** A scratch git repo with the given files staged (tracked, no commit needed). */
function gitRepo(files: Record<string, string>): string {
  const dir = tempDir();
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

function fi(path: string, bytes: number, hash: string, symlink = false): FileInfo {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return { path, bytes, hash, ext: dot > 0 ? base.slice(dot + 1).toLowerCase() : "", symlink };
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("listTrackedFiles", () => {
  it("returns only tracked files, sorted, with posix separators", async () => {
    const dir = gitRepo({
      "b.txt": "b",
      "a.txt": "a",
      "src/deep/c.ts": "c",
      "with space.txt": "s",
    });
    writeFileSync(join(dir, "untracked.txt"), "never added");
    const files = await listTrackedFiles(dir);
    expect(files).toEqual(["a.txt", "b.txt", "src/deep/c.ts", "with space.txt"]);
  });

  it("throws a clear error when the directory is not a git repository", async () => {
    await expect(listTrackedFiles(tempDir())).rejects.toThrow(/not a git repository/i);
  });
});

describe("collectFileInfo", () => {
  it("hashes file content and records byte size and lowercase extension", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "App.TSX"), "hello");
    const infos = await collectFileInfo(dir, ["App.TSX"]);
    expect(infos).toEqual([
      {
        path: "App.TSX",
        bytes: 5,
        hash: sha1("hello"),
        ext: "tsx",
        symlink: false,
      },
    ]);
  });

  it("reads nested posix-relative paths and returns entries sorted by path", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "b.ts"), "b");
    writeFileSync(join(dir, "a.ts"), "a");
    const infos = await collectFileInfo(dir, ["src/b.ts", "a.ts"]);
    expect(infos.map((i) => i.path)).toEqual(["a.ts", "src/b.ts"]);
  });

  it("gives dotfiles and extensionless files an empty extension", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), "SECRET=1");
    writeFileSync(join(dir, "Makefile"), "all:\n");
    const infos = await collectFileInfo(dir, [".env", "Makefile"]);
    expect(infos.map((i) => i.ext)).toEqual(["", ""]);
  });

  it("silently skips unreadable paths so the caller can count them", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "real.txt"), "x");
    const infos = await collectFileInfo(dir, ["real.txt", "gone.txt"]);
    expect(infos.map((i) => i.path)).toEqual(["real.txt"]);
  });

  it("hashes a symlink's target string with the link's own size, not the followed content", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "AGENTS.md"), "# shared agent instructions\n".repeat(50));
    symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
    const infos = await collectFileInfo(dir, ["AGENTS.md", "CLAUDE.md"]);
    const real = infos.find((i) => i.path === "AGENTS.md");
    const link = infos.find((i) => i.path === "CLAUDE.md");
    expect(real?.symlink).toBe(false);
    expect(link).toEqual({
      path: "CLAUDE.md",
      bytes: "AGENTS.md".length,
      hash: sha1("AGENTS.md"),
      ext: "md",
      symlink: true,
    });
    expect(link?.hash).not.toBe(real?.hash);
  });

  it("records broken symlinks from their target string instead of skipping them", async () => {
    const dir = tempDir();
    symlinkSync("missing.md", join(dir, "dangling.md"));
    const infos = await collectFileInfo(dir, ["dangling.md"]);
    expect(infos).toEqual([
      {
        path: "dangling.md",
        bytes: "missing.md".length,
        hash: sha1("missing.md"),
        ext: "md",
        symlink: true,
      },
    ]);
  });
});

describe("findDuplicates", () => {
  it("groups byte-identical files with sorted paths and wasted bytes", () => {
    const files = [fi("z/copy.ts", 100, "aaa"), fi("a/orig.ts", 100, "aaa"), fi("unique.ts", 100, "bbb")];
    expect(findDuplicates(files)).toEqual([
      { hash: "aaa", bytes: 100, paths: ["a/orig.ts", "z/copy.ts"], wastedBytes: 100 },
    ]);
  });

  it("counts wasted bytes per extra copy, not per group", () => {
    const files = [fi("a.bin", 50, "h"), fi("b.bin", 50, "h"), fi("c.bin", 50, "h")];
    expect(findDuplicates(files)[0].wastedBytes).toBe(100);
  });

  it("ignores empty files by default", () => {
    const files = [fi("a/.gitkeep", 0, "e"), fi("b/.gitkeep", 0, "e")];
    expect(findDuplicates(files)).toEqual([]);
  });

  it("honors a custom minBytes threshold", () => {
    const files = [fi("a.txt", 10, "h"), fi("b.txt", 10, "h")];
    expect(findDuplicates(files, 11)).toEqual([]);
    expect(findDuplicates(files, 10)).toHaveLength(1);
  });

  it("excludes symlinks from duplicate grouping even when hashes collide", () => {
    const files = [
      fi("a/mod.ts", 40, "same"),
      fi("b/mod.ts", 40, "same"),
      fi("link-one.ts", 40, "same", true),
      fi("link-two.ts", 40, "same", true),
    ];
    expect(findDuplicates(files)).toEqual([
      { hash: "same", bytes: 40, paths: ["a/mod.ts", "b/mod.ts"], wastedBytes: 40 },
    ]);
  });

  it("never plans a symlink/target pair as byte-identical duplicates (CLAUDE.md -> AGENTS.md)", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "AGENTS.md"), "x".repeat(1357));
    symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
    const infos = await collectFileInfo(dir, ["AGENTS.md", "CLAUDE.md"]);
    expect(infos).toHaveLength(2);
    expect(findDuplicates(infos)).toEqual([]);
  });

  it("sorts groups by wasted bytes descending, then hash", () => {
    const files = [
      fi("small1.txt", 10, "zzz"),
      fi("small2.txt", 10, "zzz"),
      fi("big1.txt", 500, "mmm"),
      fi("big2.txt", 500, "mmm"),
      fi("tie1.txt", 10, "aaa"),
      fi("tie2.txt", 10, "aaa"),
    ];
    expect(findDuplicates(files).map((g) => g.hash)).toEqual(["mmm", "aaa", "zzz"]);
  });
});

describe("largestFiles", () => {
  it("returns the n largest files by bytes with path as the tiebreak", () => {
    const files = [fi("mid.ts", 50, "1"), fi("z.ts", 100, "2"), fi("a.ts", 100, "3"), fi("tiny.ts", 1, "4")];
    expect(largestFiles(files, 3).map((f) => f.path)).toEqual(["a.ts", "z.ts", "mid.ts"]);
  });

  it("returns every file when n exceeds the list", () => {
    expect(largestFiles([fi("a.ts", 1, "1")], 20)).toHaveLength(1);
  });

  it("does not mutate the input array", () => {
    const files = [fi("small.ts", 1, "1"), fi("big.ts", 2, "2")];
    largestFiles(files, 1);
    expect(files.map((f) => f.path)).toEqual(["small.ts", "big.ts"]);
  });
});
