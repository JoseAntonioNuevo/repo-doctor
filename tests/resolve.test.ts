import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTsPaths, resolveSpecifier } from "../scripts/lib/resolve.ts";
import type { TsPathsConfig, WorkspacePkg } from "../scripts/lib/resolve.ts";

describe("resolveSpecifier", () => {
  const from = "src/main.ts";

  it("classifies node builtins with and without the node: prefix", () => {
    expect(resolveSpecifier(from, "node:fs", new Set(), null, [])).toEqual({ kind: "builtin" });
    expect(resolveSpecifier(from, "path", new Set(), null, [])).toEqual({ kind: "builtin" });
    expect(resolveSpecifier(from, "fs/promises", new Set(), null, [])).toEqual({ kind: "builtin" });
  });

  it("resolves relative specifiers with and without extension guessing", () => {
    const files = new Set(["src/util.ts", "src/main.ts"]);
    expect(resolveSpecifier(from, "./util.ts", files, null, [])).toEqual({
      kind: "internal",
      path: "src/util.ts",
    });
    expect(resolveSpecifier(from, "./util", files, null, [])).toEqual({
      kind: "internal",
      path: "src/util.ts",
    });
  });

  it("falls back to the directory index module", () => {
    const files = new Set(["src/lib/index.tsx"]);
    expect(resolveSpecifier(from, "./lib", files, null, [])).toEqual({
      kind: "internal",
      path: "src/lib/index.tsx",
    });
  });

  it("rewrites ESM-style .js specifiers to their TypeScript source", () => {
    const files = new Set(["src/util.ts", "src/App.tsx"]);
    expect(resolveSpecifier(from, "./util.js", files, null, [])).toEqual({
      kind: "internal",
      path: "src/util.ts",
    });
    expect(resolveSpecifier(from, "./App.js", files, null, [])).toEqual({
      kind: "internal",
      path: "src/App.tsx",
    });
  });

  it("reports untracked relative targets and root escapes as unresolved", () => {
    const files = new Set(["src/util.ts"]);
    expect(resolveSpecifier(from, "./missing", files, null, [])).toEqual({ kind: "unresolved" });
    expect(resolveSpecifier(from, "../../outside", files, null, [])).toEqual({ kind: "unresolved" });
  });

  it("resolves '.' and '..' as directory-index imports, never as packages", () => {
    const files = new Set(["src/index.ts", "index.ts"]);
    expect(resolveSpecifier("src/main.ts", ".", files, null, [])).toEqual({
      kind: "internal",
      path: "src/index.ts",
    });
    expect(resolveSpecifier("src/main.ts", "..", files, null, [])).toEqual({
      kind: "internal",
      path: "index.ts",
    });
    // ".." from a root-level file escapes the repo — unresolved, not package "..".
    expect(resolveSpecifier("main.ts", "..", files, null, [])).toEqual({ kind: "unresolved" });
  });

  it("resolves SFC targets exactly and through extension guessing", () => {
    const files = new Set(["src/Card.vue", "src/Panel.svelte", "src/Hero.astro"]);
    expect(resolveSpecifier(from, "./Card.vue", files, null, [])).toEqual({
      kind: "internal",
      path: "src/Card.vue",
    });
    expect(resolveSpecifier(from, "./Card", files, null, [])).toEqual({
      kind: "internal",
      path: "src/Card.vue",
    });
    expect(resolveSpecifier(from, "./Panel", files, null, [])).toEqual({
      kind: "internal",
      path: "src/Panel.svelte",
    });
    expect(resolveSpecifier(from, "./Hero", files, null, [])).toEqual({
      kind: "internal",
      path: "src/Hero.astro",
    });
  });

  it("resolves tsconfig path aliases through the wildcard", () => {
    const tsPaths: TsPathsConfig = { baseUrl: null, paths: { "@/*": ["src/*"] } };
    const files = new Set(["src/hooks/use-thing.ts"]);
    expect(resolveSpecifier(from, "@/hooks/use-thing", files, tsPaths, [])).toEqual({
      kind: "internal",
      path: "src/hooks/use-thing.ts",
    });
  });

  it("prefers the longest alias prefix when several patterns match", () => {
    const tsPaths: TsPathsConfig = {
      baseUrl: null,
      paths: { "@/*": ["src/*"], "@/lib/*": ["packages/lib/src/*"] },
    };
    const files = new Set(["packages/lib/src/box.ts", "src/lib/box.ts"]);
    expect(resolveSpecifier(from, "@/lib/box", files, tsPaths, [])).toEqual({
      kind: "internal",
      path: "packages/lib/src/box.ts",
    });
  });

  it("tries alias targets in order and reports a full miss as unresolved, not package", () => {
    const tsPaths: TsPathsConfig = {
      baseUrl: null,
      paths: { "#shared/*": ["src/shared/*", "legacy/shared/*"] },
    };
    const files = new Set(["legacy/shared/x.ts"]);
    expect(resolveSpecifier(from, "#shared/x", files, tsPaths, [])).toEqual({
      kind: "internal",
      path: "legacy/shared/x.ts",
    });
    expect(resolveSpecifier(from, "#shared/nope", files, tsPaths, [])).toEqual({
      kind: "unresolved",
    });
  });

  it("matches an exact (wildcard-free) alias pattern first", () => {
    const tsPaths: TsPathsConfig = {
      baseUrl: null,
      paths: { "~config": ["src/config.ts"], "~config/*": ["config/*"] },
    };
    const files = new Set(["src/config.ts", "config/env.ts"]);
    expect(resolveSpecifier(from, "~config", files, tsPaths, [])).toEqual({
      kind: "internal",
      path: "src/config.ts",
    });
    expect(resolveSpecifier(from, "~config/env", files, tsPaths, [])).toEqual({
      kind: "internal",
      path: "config/env.ts",
    });
  });

  const ui: WorkspacePkg = { name: "@acme/ui", dir: "packages/ui", entry: "packages/ui/src/index.ts" };

  it("maps a workspace package name to its entry module", () => {
    expect(resolveSpecifier(from, "@acme/ui", new Set(), null, [ui])).toEqual({
      kind: "internal",
      path: "packages/ui/src/index.ts",
    });
  });

  it("resolves workspace subpaths under the package directory", () => {
    const files = new Set(["packages/ui/button.tsx"]);
    expect(resolveSpecifier(from, "@acme/ui/button", files, null, [ui])).toEqual({
      kind: "internal",
      path: "packages/ui/button.tsx",
    });
    expect(resolveSpecifier(from, "@acme/ui/styles.css", new Set(), null, [ui])).toEqual({
      kind: "package",
      name: "@acme/ui",
    });
  });

  it("falls back to the package dir index, then package, when the entry is unknown", () => {
    const bare: WorkspacePkg = { name: "@acme/utils", dir: "packages/utils", entry: null };
    const files = new Set(["packages/utils/index.ts"]);
    expect(resolveSpecifier(from, "@acme/utils", files, null, [bare])).toEqual({
      kind: "internal",
      path: "packages/utils/index.ts",
    });
    expect(resolveSpecifier(from, "@acme/utils", new Set(), null, [bare])).toEqual({
      kind: "package",
      name: "@acme/utils",
    });
  });

  it("names external packages by first segment, or scope plus name when scoped", () => {
    expect(resolveSpecifier(from, "lodash/fp/merge", new Set(), null, [])).toEqual({
      kind: "package",
      name: "lodash",
    });
    expect(resolveSpecifier(from, "@scope/pkg/sub/deep", new Set(), null, [])).toEqual({
      kind: "package",
      name: "@scope/pkg",
    });
    expect(resolveSpecifier(from, "react", new Set(), null, [])).toEqual({
      kind: "package",
      name: "react",
    });
  });

  it("never classifies '@/…' alias misses or bare scopes as packages", () => {
    // Reviewer scenario: apps/web's "@/*" alias not loaded — "@/components/button"
    // must surface as unresolved (downgrading orphan confidence), never as the
    // phantom package "@/components".
    expect(resolveSpecifier(from, "@/components/button", new Set(), null, [])).toEqual({
      kind: "unresolved",
    });
    expect(resolveSpecifier(from, "@", new Set(), null, [])).toEqual({ kind: "unresolved" });
    expect(resolveSpecifier(from, "@scope", new Set(), null, [])).toEqual({ kind: "unresolved" });
    expect(resolveSpecifier(from, "@scope/", new Set(), null, [])).toEqual({ kind: "unresolved" });
  });

  it("treats package.json subpath imports ('#…') as unresolved, never as packages", () => {
    expect(resolveSpecifier(from, "#imports", new Set(), null, [])).toEqual({
      kind: "unresolved",
    });
    expect(resolveSpecifier(from, "#app/composables", new Set(), null, [])).toEqual({
      kind: "unresolved",
    });
    // A tsconfig alias for a '#…' pattern still wins over the blanket rule.
    const tsPaths: TsPathsConfig = { baseUrl: null, paths: { "#lib/*": ["src/lib/*"] } };
    expect(
      resolveSpecifier(from, "#lib/box", new Set(["src/lib/box.ts"]), tsPaths, []),
    ).toEqual({ kind: "internal", path: "src/lib/box.ts" });
  });
});

const dirs: string[] = [];

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rd-resolve-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("loadTsPaths", () => {
  it("parses JSONC with comments and trailing commas into repo-relative targets", () => {
    const dir = repo({
      "tsconfig.json": `{
  // path aliases for the app
  "compilerOptions": {
    "baseUrl": "./src", /* targets resolve from here */
    "paths": {
      "@/*": ["app/*"],
    },
  },
}`,
    });
    expect(loadTsPaths(dir)).toEqual({ baseUrl: "src", paths: { "@/*": ["src/app/*"] } });
  });

  it("follows one relative extends hop with the child's options winning", () => {
    const dir = repo({
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@base/*": ["base/*"] } },
      }),
      "web/tsconfig.json": JSON.stringify({
        extends: "../tsconfig.base.json",
        compilerOptions: { paths: { "@web/*": ["src/*"] } },
      }),
    });
    // Child paths replace the parent's wholesale; the inherited baseUrl still
    // anchors them at the repo root — tsconfig semantics, not a merge.
    expect(loadTsPaths(dir, "web/tsconfig.json")).toEqual({
      baseUrl: ".",
      paths: { "@web/*": ["src/*"] },
    });
  });

  it("keeps a parse-clean config with no aliases as an empty paths record", () => {
    const dir = repo({ "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }) });
    expect(loadTsPaths(dir)).toEqual({ baseUrl: null, paths: {} });
  });

  it("returns null for a missing or unparseable tsconfig", () => {
    expect(loadTsPaths(repo({}))).toBeNull();
    expect(loadTsPaths(repo({ "tsconfig.json": "{ not json" }))).toBeNull();
  });
});
