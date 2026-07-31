import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildModuleGraph } from "../scripts/lib/graph.ts";
import type { GraphInput } from "../scripts/lib/graph.ts";
import type { TsPathsConfig } from "../scripts/lib/resolve.ts";
import type { FileInfo, PackageManifest } from "../scripts/lib/types.ts";
import { runScan } from "../scripts/scan.ts";

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function manifest(dir: string, raw: Record<string, unknown> = {}): PackageManifest {
  return {
    dir,
    name: typeof raw["name"] === "string" ? (raw["name"] as string) : dir,
    raw,
    fields: { dependencies: {}, devDependencies: {}, peerDependencies: {}, optionalDependencies: {} },
  };
}

/**
 * Build the graph over an in-memory repo. readFile throws on any path outside
 * the fixture, so a stray filesystem-shaped read fails loudly.
 */
function graphOf(files: Record<string, string>, opts: Partial<GraphInput> = {}) {
  const infos: FileInfo[] = Object.keys(files)
    .sort()
    .map((path) => ({
      path,
      bytes: files[path].length,
      hash: `h:${path}`,
      ext: extOf(path),
      symlink: false,
    }));
  return buildModuleGraph({
    cwd: "/repo",
    files: infos,
    manifests: [manifest(".")],
    tsPathsByDir: new Map<string, TsPathsConfig | null>(),
    workspacePkgs: [],
    extraEntries: [],
    readFile: (p) => {
      if (!(p in files)) throw new Error(`unexpected read: ${p}`);
      return files[p];
    },
    ...opts,
  });
}

function reasonsOf(graph: ReturnType<typeof buildModuleGraph>["graph"]): Map<string, string> {
  return new Map(graph.entrypoints.map((e) => [e.path, e.reason]));
}

describe("buildModuleGraph entrypoints", () => {
  it("roots every package.json field reference, with extension rewriting", () => {
    const { graph } = graphOf(
      {
        "src/entry.ts": "",
        "src/mod.mjs": "",
        "src/api.d.ts": "",
        "src/browser-shim.ts": "",
        "src/exported.ts": "",
        "cli/run.ts": "",
        "cli/seed.ts": "",
      },
      {
        manifests: [
          manifest(".", {
            main: "./src/entry.js", // points at compiled output — must find the .ts source
            module: "./src/mod.mjs",
            types: "./src/api.d.ts",
            browser: { "./shim": "./src/browser-shim.ts" },
            bin: { rd: "./cli/run.ts" },
            exports: { ".": { import: "./src/exported.ts" } },
            scripts: { seed: "node cli/seed.ts --reset" },
          }),
        ],
      },
    );
    const reasons = reasonsOf(graph);
    expect(reasons.get("src/entry.ts")).toBe("package.json main");
    expect(reasons.get("src/mod.mjs")).toBe("package.json module");
    expect(reasons.get("src/api.d.ts")).toBe("package.json types"); // field beats the d.ts convention
    expect(reasons.get("src/browser-shim.ts")).toBe("package.json browser");
    expect(reasons.get("cli/run.ts")).toBe("package.json bin");
    expect(reasons.get("src/exported.ts")).toBe("package.json exports");
    expect(reasons.get("cli/seed.ts")).toBe("package.json scripts");
    expect(graph.orphans).toEqual([]);
  });

  it("records one entrypoint per file with the first matching reason", () => {
    // index.ts is both the main field and a conventional root — fields win.
    const { graph } = graphOf(
      { "index.ts": "" },
      { manifests: [manifest(".", { main: "./index.ts" })] },
    );
    expect(graph.entrypoints).toEqual([{ path: "index.ts", reason: "package.json main" }]);
  });

  it("treats framework route and middleware files as roots relative to their manifest dir", () => {
    const { graph } = graphOf(
      {
        "apps/web/pages/home.tsx": "",
        "apps/web/middleware.ts": "",
        "src/app/page.tsx": "",
        "src/instrumentation.ts": "",
        "apps/web/deep/pages/nested.tsx": "", // pages/ is not directly under a manifest dir
      },
      { manifests: [manifest("."), manifest("apps/web")] },
    );
    const reasons = reasonsOf(graph);
    expect(reasons.get("apps/web/pages/home.tsx")).toBe("framework route file");
    expect(reasons.get("src/app/page.tsx")).toBe("framework route file");
    expect(reasons.get("apps/web/middleware.ts")).toBe("framework middleware/instrumentation");
    expect(reasons.get("src/instrumentation.ts")).toBe("framework middleware/instrumentation");
    expect(graph.orphans.map((o) => o.path)).toEqual(["apps/web/deep/pages/nested.tsx"]);
  });

  it("treats conventional index/main/server files as roots per manifest dir", () => {
    const { graph } = graphOf(
      {
        "index.ts": "",
        "src/main.ts": "",
        "packages/lib/src/index.ts": "", // needs the packages/lib manifest, not the root one
        "src/helper.ts": "",
      },
      { manifests: [manifest("."), manifest("packages/lib")] },
    );
    const reasons = reasonsOf(graph);
    expect(reasons.get("index.ts")).toBe("conventional root file");
    expect(reasons.get("src/main.ts")).toBe("conventional root file");
    expect(reasons.get("packages/lib/src/index.ts")).toBe("conventional root file");
    expect(graph.orphans.map((o) => o.path)).toEqual(["src/helper.ts"]);
  });

  it("roots config, test, story, declaration, and ops-directory modules by convention", () => {
    const { graph } = graphOf(
      {
        "vite.config.ts": "",
        ".eslintrc.cjs": "",
        "src/util.test.ts": "",
        "e2e/checkout.ts": "",
        "src/Button.stories.tsx": "",
        "types/global.d.ts": "",
        "scripts/release.ts": "",
        "db/migrations/0001-init.ts": "",
      },
      { manifests: [] },
    );
    const reasons = reasonsOf(graph);
    expect(reasons.get("vite.config.ts")).toBe("config file");
    expect(reasons.get(".eslintrc.cjs")).toBe("config file");
    expect(reasons.get("src/util.test.ts")).toBe("test file");
    expect(reasons.get("e2e/checkout.ts")).toBe("test file");
    expect(reasons.get("src/Button.stories.tsx")).toBe("storybook file");
    expect(reasons.get("types/global.d.ts")).toBe("type declaration file");
    expect(reasons.get("scripts/release.ts")).toBe("ops/tooling directory");
    expect(reasons.get("db/migrations/0001-init.ts")).toBe("ops/tooling directory");
    expect(graph.orphans).toEqual([]);
  });

  it("honors --entry files with the pinned reason and traverses from them", () => {
    const { graph } = graphOf(
      {
        "src/plugin.ts": `import "./plugin-dep.ts";`,
        "src/plugin-dep.ts": "",
      },
      { manifests: [], extraEntries: ["src/plugin.ts"] },
    );
    expect(graph.entrypoints).toEqual([{ path: "src/plugin.ts", reason: "user-provided --entry" }]);
    expect(graph.orphans).toEqual([]); // the dep is reached through the forced entry
  });
});

describe("buildModuleGraph reachability", () => {
  it("makes every html file a root and follows its src/href edges to modules", () => {
    const { graph } = graphOf(
      {
        "index.html": [
          `<link rel="stylesheet" href="./styles.css">`,
          `<script type="module" src="/src/boot.tsx?v=2"></script>`,
          `<script src="./widgets/menu.ts"></script>`,
          `<script src="https://cdn.example.com/analytics.js"></script>`,
          `<a href="./docs/about.html">about</a>`,
        ].join("\n"),
        "docs/about.html": "",
        "src/boot.tsx": `import "./store.ts";`,
        "src/store.ts": "",
        "widgets/menu.ts": "",
        "styles.css": "body {}",
      },
      { manifests: [] },
    );
    expect(graph.entrypoints).toEqual([
      { path: "docs/about.html", reason: "html file" },
      { path: "index.html", reason: "html file" },
    ]);
    // boot.tsx via the server-root src (query string stripped), menu.ts via
    // the relative src, store.ts one BFS hop further; the CDN url adds nothing.
    expect(graph.orphans).toEqual([]);
    expect(graph.unresolved).toEqual([]);
  });

  it("keeps orphan clusters together and lists their orphan importers", () => {
    const solo = "export const x = 1;";
    const { graph } = graphOf({
      "index.ts": `import "./used.ts";`,
      "used.ts": "",
      "src/dead-a.ts": `import { b } from "./dead-b.ts";`,
      "src/dead-b.ts": `import { a } from "./dead-a.ts";`,
      "src/dead-solo.ts": solo,
    });
    expect(graph.orphans.map((o) => [o.path, o.importers])).toEqual([
      ["src/dead-a.ts", ["src/dead-b.ts"]],
      ["src/dead-b.ts", ["src/dead-a.ts"]],
      ["src/dead-solo.ts", []],
    ]);
    expect(graph.orphans[2].bytes).toBe(solo.length);
  });

  it("reports unresolved imports from reachable files only", () => {
    const { graph } = graphOf({
      "index.ts": `import "./missing.ts";\nimport "./real.ts";`,
      "real.ts": "",
      "src/dead.ts": `import "./ghost.ts";`, // orphan — its broken import is noise
    });
    expect(graph.unresolved).toEqual([{ from: "index.ts", specifier: "./missing.ts" }]);
    expect(graph.orphans.map((o) => o.path)).toEqual(["src/dead.ts"]);
  });

  it("flags dynamic importers whether reachable or not", () => {
    const { graph } = graphOf({
      "index.ts": `const name = "./x.ts";\nexport const load = () => import(name);`,
      "src/lazy-dead.ts": `module.exports = (id) => require(id);`,
    });
    expect(graph.dynamicImporters).toEqual(["index.ts", "src/lazy-dead.ts"]);
  });

  it("keeps files reached only through a tsconfig alias out of the orphan list", () => {
    const { graph } = graphOf(
      {
        "index.ts": `import "@/lib/box";`,
        "src/lib/box.ts": "",
      },
      { tsPathsByDir: new Map([[".", { baseUrl: null, paths: { "@/*": ["src/*"] } }]]) },
    );
    expect(graph.orphans).toEqual([]);
    expect(graph.unresolved).toEqual([]);
  });

  it("resolves each file's aliases with its own manifest's tsconfig, not the root one", () => {
    // Reviewer scenario: apps/web declares "@/*" in its own tsconfig; the root
    // has none. The web page's "@/components/button" must resolve inside
    // apps/web, while the same specifier from a root file stays unresolved —
    // never the phantom package "@/components".
    const webPaths: TsPathsConfig = { baseUrl: null, paths: { "@/*": ["apps/web/src/*"] } };
    const { graph } = graphOf(
      {
        "index.ts": `import "@/components/button";`,
        "apps/web/src/pages/home.tsx": `import Button from "@/components/button";`,
        "apps/web/src/components/button.tsx": "",
      },
      {
        manifests: [manifest("."), manifest("apps/web")],
        tsPathsByDir: new Map([
          [".", null],
          ["apps/web", webPaths],
        ]),
      },
    );
    expect(graph.orphans).toEqual([]); // button.tsx is reached through the web alias
    expect(graph.unresolved).toEqual([{ from: "index.ts", specifier: "@/components/button" }]);
  });

  it("parses SFC files as modules: their imports create edges and they can be roots or orphans", () => {
    const { graph } = graphOf(
      {
        "src/pages/index.astro": [
          "---",
          `import Card from "../components/Card.vue";`,
          `import { helper } from "../lib/helper.ts";`,
          "---",
          "<Card />",
        ].join("\n"),
        "src/components/Card.vue": [
          "<script setup>",
          `import { fmt } from "../lib/fmt";`,
          "</script>",
          "<template><div /></template>",
        ].join("\n"),
        "src/lib/helper.ts": "",
        "src/lib/fmt.ts": "",
        "src/components/Unused.svelte": "<script>let x = 1;</script>",
      },
      { manifests: [manifest(".")] },
    );
    expect(graph.moduleFiles).toContain("src/components/Card.vue");
    expect(reasonsOf(graph).get("src/pages/index.astro")).toBe("framework route file");
    // Card.vue and fmt.ts live only through SFC imports; Unused.svelte is a real orphan.
    expect(graph.orphans.map((o) => o.path)).toEqual(["src/components/Unused.svelte"]);
    expect(graph.unresolved).toEqual([]);
  });

  it("flags orphans whose source opens with a shebang and defaults pathReferencedBy empty", () => {
    const { graph } = graphOf({
      "index.ts": "",
      "examples/make-demo.ts": "#!/usr/bin/env -S npx tsx\nexport {};",
      "src/dead.ts": "export {};",
    });
    expect(graph.orphans.map((o) => [o.path, o.hasShebang])).toEqual([
      ["examples/make-demo.ts", true],
      ["src/dead.ts", false],
    ]);
    // The graph has no text corpus — scan.ts owns pathReferencedBy population.
    expect(graph.orphans.map((o) => o.pathReferencedBy)).toEqual([[], []]);
  });

  it("maps every module file to its raw specifier list for deps analysis", () => {
    const { importsByFile } = graphOf({
      "index.ts": `import react from "react";\nimport { join } from "node:path";\nimport "./util.ts";`,
      "util.ts": "",
      "src/dead.ts": `import "lodash";`, // orphans still feed dependency usage
    });
    expect([...importsByFile.keys()]).toEqual(["index.ts", "src/dead.ts", "util.ts"]);
    expect(importsByFile.get("index.ts")).toEqual(["./util.ts", "node:path", "react"]);
    expect(importsByFile.get("src/dead.ts")).toEqual(["lodash"]);
  });
});

// --- runScan pipeline (real git fixtures, like walk.test.ts) -----------------

const dirs: string[] = [];

/** A scratch git repo with the given files staged (tracked, no commit needed). */
function gitRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rd-scan-"));
  dirs.push(dir);
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const NO_ENTRY_WARNING =
  "no module entrypoints discovered — orphan analysis is unreliable; pass --entry <path>";

describe("runScan", () => {
  it("records scanOptions and warns when no entrypoint is a module file", async () => {
    const dir = gitRepo({
      "src/helper.ts": "export const x = 1;", // matches no root convention
      "notes.md": "docs",
    });
    const report = await runScan({ cwd: dir, ignore: [/ignored-nothing/] });
    expect(report.scanOptions).toEqual({ ignore: ["ignored-nothing"], entries: [] });
    expect(report.warnings).toContain(NO_ENTRY_WARNING);
    expect(report.graph.orphans.map((o) => o.path)).toEqual(["src/helper.ts"]);
  });

  it("normalizes --entry inputs into scanOptions and drops the honesty warning", async () => {
    const dir = gitRepo({ "src/helper.ts": "export const x = 1;" });
    const report = await runScan({ cwd: dir, entries: ["./src/helper.ts"] });
    expect(report.scanOptions).toEqual({ ignore: [], entries: ["src/helper.ts"] });
    expect(report.warnings).not.toContain(NO_ENTRY_WARNING);
    expect(report.graph.orphans).toEqual([]);
  });

  it("loads each package's own tsconfig paths instead of only the root one", async () => {
    // Reviewer scenario: only apps/web/tsconfig.json declares "@/*" — the old
    // single loadTsPaths(cwd) call ignored it, orphaning button.tsx (HIGH) and
    // leaving "@/components/button" package-shaped.
    const dir = gitRepo({
      "package.json": JSON.stringify({ name: "root", private: true }),
      "apps/web/package.json": JSON.stringify({ name: "web" }),
      "apps/web/tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      }),
      "apps/web/src/pages/home.tsx": `import Button from "@/components/button";`,
      "apps/web/src/components/button.tsx": "export const Button = 1;",
    });
    const report = await runScan({ cwd: dir });
    expect(report.graph.orphans).toEqual([]);
    expect(report.graph.unresolved).toEqual([]);
  });

  it("marks orphans referenced by path in tracked text files and orphans with shebangs", async () => {
    const dir = gitRepo({
      "README.md": "Regenerate the demo with `npx tsx examples/make-demo.ts`.",
      "docs/dev.md": "See examples/make-demo.ts for the fixture generator.",
      "examples/make-demo.ts": "#!/usr/bin/env -S npx tsx\nexport {};",
      "src/dead.ts": "export {};",
    });
    const report = await runScan({ cwd: dir });
    expect(report.graph.orphans.map((o) => [o.path, o.pathReferencedBy, o.hasShebang])).toEqual([
      ["examples/make-demo.ts", ["README.md", "docs/dev.md"], true],
      ["src/dead.ts", [], false],
    ]);
  });
});
