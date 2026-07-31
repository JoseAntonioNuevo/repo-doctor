import { describe, expect, it } from "vitest";
import { buildPlan, type PlanOptions } from "../scripts/lib/planner.ts";
import { formatBytes, renderPlanMarkdown } from "../scripts/lib/render.ts";
import type {
  CleanupPlan,
  DepField,
  DepUsage,
  DuplicateGroup,
  EntryPoint,
  FileInfo,
  JunkCategory,
  JunkFinding,
  OrphanModule,
  PackageReport,
  RepoReport,
} from "../scripts/lib/types.ts";

function graph(over: Partial<RepoReport["graph"]> = {}): RepoReport["graph"] {
  return { moduleFiles: [], entrypoints: [], orphans: [], unresolved: [], dynamicImporters: [], resolvedEdges: [], health: { status: "complete", diagnostics: [] }, ...over };
}

function report(over: Partial<RepoReport> = {}): RepoReport {
  return {
    version: 2,
    tool: "repo-doctor",
    toolVersion: "0.2.0",
    createdAt: "2026-01-01T00:00:00.000Z",
    cwd: "/repo",
    source: { repository: { id: "repo", kind: "git-history", root: "/repo", head: "abc", rootCommits: ["root"] }, inventoryDigest: "inventory", indexDigest: "index", trackedWorktreeClean: true },
    scanOptions: { ignore: [], entries: [], largeCount: 20, minDupBytes: 1 },
    scanOptionsDigest: "options",
    health: { inventory: "complete", graph: "complete", dependencies: "complete", workspace: "complete", lockfile: "complete" },
    diagnostics: [],
    projects: [{ rootDir: ".", kind: "standalone", manager: { status: "resolved", name: "pnpm", version: "11", source: "packageManager", lockfilePath: "pnpm-lock.yaml", conflicts: [] }, workspacePatterns: [], packageDirs: ["."], packageNames: ["root"], workspaceSkew: [], lockfile: { path: "pnpm-lock.yaml", dialect: "pnpm-v9", parseStatus: "parsed", diagnostics: [] }, diagnostics: [] }],
    packageManager: "pnpm",
    lockfileKind: "pnpm-lock.yaml",
    totals: { trackedFiles: 0, trackedBytes: 0, moduleFiles: 0, packages: 0, declaredDeps: 0 },
    files: [],
    duplicateGroups: [],
    graph: graph(),
    unreferencedAssets: [],
    packages: [],
    workspaceSkew: [],
    lockfileDuplicates: [],
    overlaps: [],
    junk: [],
    largeFiles: [],
    warnings: [],
    ...over,
  };
}

function entry(path: string): EntryPoint {
  return { path, reason: "package.json main" };
}

function orphan(path: string, bytes = 100, importers: string[] = [], over: Partial<OrphanModule> = {}): OrphanModule {
  return { path, bytes, importers, pathReferencedBy: [], hasShebang: false, ...over };
}

function file(path: string, over: Partial<FileInfo> = {}): FileInfo {
  return { path, bytes: 10, hash: `h-${path}`, ext: "", symlink: false, ...over };
}

function junk(path: string, category: JunkCategory, bytes = 10): JunkFinding {
  return { path, bytes, category, pattern: `${category} rule` };
}

function dup(paths: string[], bytes = 100): DuplicateGroup {
  return { hash: `h-${paths[0]}`, bytes, paths, wastedBytes: bytes * (paths.length - 1) };
}

function pkg(dir: string, over: Partial<PackageReport> = {}): PackageReport {
  return { dir, name: dir === "." ? "root" : dir, deps: [], unused: [], missing: [], dualDeclared: [], ...over };
}

function dep(name: string, field: DepField, over: Partial<DepUsage> = {}): DepUsage {
  return { name, field, range: "^1.0.0", usedBy: [], textHits: [], implicitReason: null, ...over };
}

const LOW: PlanOptions = { keep: [], minConfidence: "low" };

describe("plan computation", () => {
  it("deletes an unknown-status duplicate copy at medium only, telling the user to grep first", () => {
    // Neither copy is provably referenced — deletion must never be high.
    const plan = buildPlan(report({ duplicateGroups: [dup(["src/copy.ts", "src/a.ts"], 100)] }), LOW);
    expect(plan.items).toHaveLength(1);
    const item = plan.items[0];
    expect(item.action).toBe("delete-file");
    expect(item.target).toBe("src/copy.ts");
    expect(item.confidence).toBe("medium");
    expect(item.evidence).toContain("byte-identical to src/a.ts (100 bytes)");
    expect(item.evidence).toContain("grep for the path before deleting");
    expect(item.reclaimBytes).toBe(100);
  });

  it("never targets the reachable copy of a duplicate pair even when the copy-named file sorts first", () => {
    // '-' sorts before '.', so src/util-copy.ts < src/util.ts — the old
    // lexicographic-canonical rule deleted the LIVE file. Survivor rank must
    // keep the reachable module and target the copy instead.
    const plan = buildPlan(
      report({
        files: [file("src/util.ts"), file("src/util-copy.ts")],
        duplicateGroups: [dup(["src/util-copy.ts", "src/util.ts"], 80)],
        graph: graph({ moduleFiles: ["src/index.ts", "src/util.ts"], entrypoints: [entry("src/index.ts")] }),
      }),
      LOW,
    );
    expect(plan.items.some((i) => i.target === "src/util.ts")).toBe(false);
    expect(plan.items).toHaveLength(1);
    const item = plan.items[0];
    expect(item.target).toBe("src/util-copy.ts");
    expect(item.action).toBe("delete-file");
    expect(item.confidence).toBe("medium"); // reference status unknown — never high
    expect(item.evidence).toContain("byte-identical to src/util.ts");
  });

  it("deletes the unreferenced twin of a duplicated asset at high, keeping the referenced copy, with no second item", () => {
    // img/logo-unused.png sorts BEFORE img/logo.png — the old rule kept the
    // unreferenced twin and deleted the referenced one at high.
    const plan = buildPlan(
      report({
        duplicateGroups: [dup(["img/logo-unused.png", "img/logo.png"], 500)],
        unreferencedAssets: [
          { path: "img/logo-unused.png", bytes: 500, reason: "basename referenced by no tracked text file" },
        ],
      }),
      LOW,
    );
    expect(plan.items.some((i) => i.target === "img/logo.png")).toBe(false);
    const items = plan.items.filter((i) => i.target === "img/logo-unused.png");
    expect(items).toHaveLength(1); // the asset pass must not add a second item for the same path
    expect(items[0].action).toBe("delete-file");
    expect(items[0].confidence).toBe("high");
    expect(items[0].evidence).toContain("byte-identical to img/logo.png");
    expect(items[0].evidence).toContain("referenced nowhere");
    expect(items[0].reclaimBytes).toBe(500);
  });

  it("treats duplicated LICENSE files as deliberate per-package duplicates: review low, never delete", () => {
    const plan = buildPlan(report({ duplicateGroups: [dup(["LICENSE", "packages/a/LICENSE"], 1000)] }), LOW);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].target).toBe("packages/a/LICENSE");
    expect(plan.items[0].action).toBe("review-file");
    expect(plan.items[0].confidence).toBe("low");
    expect(plan.items[0].evidence).toContain("deliberate per-package duplicate");
  });

  it("reviews a duplicate member that reachable code imports instead of deleting it", () => {
    const plan = buildPlan(
      report({
        duplicateGroups: [dup(["src/a.ts", "src/b.ts"], 60)],
        graph: graph({ moduleFiles: ["src/index.ts", "src/a.ts", "src/b.ts"], entrypoints: [entry("src/index.ts")] }),
      }),
      LOW,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].target).toBe("src/b.ts");
    expect(plan.items[0].action).toBe("review-file");
    expect(plan.items[0].confidence).toBe("medium");
    expect(plan.items[0].evidence).toContain("consolidate importers first");
  });

  it("downgrades a duplicate copy that is an entrypoint to review-file medium", () => {
    const plan = buildPlan(
      report({
        duplicateGroups: [dup(["src/a.ts", "bin/cli.js"], 100)],
        graph: graph({ moduleFiles: ["src/a.ts"], entrypoints: [entry("bin/cli.js")] }),
      }),
      LOW,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].target).toBe("bin/cli.js");
    expect(plan.items[0].action).toBe("review-file");
    expect(plan.items[0].confidence).toBe("medium");
    expect(plan.items[0].evidence).toContain("entrypoint");
  });

  it("skips symlink members of duplicate groups entirely", () => {
    // A two-member group whose twin is a symlink proposes nothing at all.
    const pair = buildPlan(
      report({
        files: [file("src/real.ts"), file("src/link.ts", { symlink: true })],
        duplicateGroups: [dup(["src/link.ts", "src/real.ts"], 40)],
      }),
      LOW,
    );
    expect(pair.items).toHaveLength(0);
    // In a three-member group the symlink gets no item; the rest proceed.
    const trio = buildPlan(
      report({
        files: [file("lib/a.js", { symlink: true }), file("lib/b.js"), file("lib/c.js")],
        duplicateGroups: [dup(["lib/a.js", "lib/b.js", "lib/c.js"], 40)],
      }),
      LOW,
    );
    expect(trio.items.map((i) => i.target)).toEqual(["lib/c.js"]);
    expect(trio.items[0].evidence).toContain("byte-identical to lib/b.js");
  });

  it("emits one instruction per path when a file is both junk and an orphan", () => {
    // A committed dist/ file is usually also unreachable — it must get ONE
    // untrack-and-gitignore item (with the graph evidence merged in), never a
    // contradictory delete-file item on top, and its bytes count once.
    const plan = buildPlan(
      report({
        files: [file("dist/index.js", { bytes: 73 }), file("app.js", { bytes: 73 })],
        graph: graph({
          moduleFiles: ["src/index.ts", "dist/index.js"],
          entrypoints: [entry("src/index.ts")],
          orphans: [orphan("dist/index.js", 73)],
        }),
        junk: [junk("dist/index.js", "build-artifact", 73)],
        duplicateGroups: [dup(["app.js", "dist/index.js"], 73)],
      }),
      LOW,
    );
    const forPath = plan.items.filter((i) => i.target === "dist/index.js");
    expect(forPath).toHaveLength(1);
    expect(forPath[0].action).toBe("untrack-and-gitignore");
    expect(forPath[0].evidence).toContain("unreachable in the module graph");
    expect(plan.summary.reclaimBytes).toBe(73);
  });

  it("emits one instruction when a junk path is also an unreferenced asset", () => {
    const plan = buildPlan(
      report({
        junk: [junk("notes-old.pdf", "backup-copy", 900)],
        unreferencedAssets: [{ path: "notes-old.pdf", bytes: 900, reason: "basename referenced by no tracked text file" }],
      }),
      LOW,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action).toBe("delete-file"); // the junk routing owns the path
    expect(plan.items[0].confidence).toBe("medium");
  });

  it("vetoes untracking a junk-named file the module graph proves reachable", () => {
    // src/output/formatter.ts matches a build-dir pattern but live code imports it.
    const plan = buildPlan(
      report({
        junk: [junk("src/output/formatter.ts", "build-artifact", 200)],
        graph: graph({ moduleFiles: ["src/index.ts", "src/output/formatter.ts"], entrypoints: [entry("src/index.ts")] }),
      }),
      LOW,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action).toBe("review-file");
    expect(plan.items[0].confidence).toBe("medium");
    expect(plan.items[0].evidence).toContain("reachable");
  });

  it("vetoes deleting a backup-named file that reachable code imports", () => {
    // src/deep-copy.ts matches the '-copy' backup pattern but is a live module.
    const plan = buildPlan(
      report({
        junk: [junk("src/deep-copy.ts", "backup-copy", 120)],
        graph: graph({ moduleFiles: ["src/index.ts", "src/deep-copy.ts"], entrypoints: [entry("src/index.ts")] }),
      }),
      LOW,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action).toBe("review-file");
    expect(plan.items[0].confidence).toBe("medium");
    expect(plan.items[0].evidence).toContain("reachable");
  });

  it("flags orphans as high-confidence deletes when the graph has no dynamic or unresolved imports", () => {
    const plan = buildPlan(
      report({
        graph: graph({
          moduleFiles: ["src/index.ts", "src/dead.ts", "src/dead2.ts"],
          entrypoints: [entry("src/index.ts")],
          orphans: [orphan("src/dead.ts", 42, ["src/dead2.ts"])],
        }),
      }),
      LOW,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action).toBe("delete-file");
    expect(plan.items[0].confidence).toBe("high");
    expect(plan.items[0].evidence).toContain("unreachable from the only entrypoint");
    expect(plan.items[0].evidence).toContain("1 fellow orphan");
    expect(plan.items[0].reclaimBytes).toBe(42);
  });

  it("downgrades orphans to medium when the repo has dynamic imports", () => {
    const plan = buildPlan(
      report({
        graph: graph({
          moduleFiles: ["src/index.ts", "src/dead.ts"],
          entrypoints: [entry("src/index.ts")],
          orphans: [orphan("src/dead.ts")],
          dynamicImporters: ["src/loader.ts"],
        }),
      }),
      LOW,
    );
    expect(plan.items[0].confidence).toBe("medium");
    expect(plan.items[0].evidence).toContain("its package has dynamic imports — verify none loads this file");
  });

  it("downgrades orphans to medium when the repo has unresolved imports", () => {
    const plan = buildPlan(
      report({
        graph: graph({
          moduleFiles: ["src/index.ts", "src/dead.ts"],
          entrypoints: [entry("src/index.ts")],
          orphans: [orphan("src/dead.ts")],
          unresolved: [{ from: "src/x.ts", specifier: "./gone" }],
        }),
      }),
      LOW,
    );
    expect(plan.items[0].confidence).toBe("medium");
    expect(plan.items[0].evidence).toContain("unresolved imports");
  });

  it("rescues an orphan whose path other files reference to review-file medium, citing the referencer", () => {
    const plan = buildPlan(
      report({
        graph: graph({
          moduleFiles: ["src/index.ts", "scripts/migrate.ts"],
          entrypoints: [entry("src/index.ts")],
          orphans: [orphan("scripts/migrate.ts", 50, [], { pathReferencedBy: ["package.json"] })],
        }),
      }),
      LOW,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action).toBe("review-file");
    expect(plan.items[0].confidence).toBe("medium");
    expect(plan.items[0].evidence).toContain("referenced by package.json");
    expect(plan.items[0].reclaimBytes).toBe(0);
  });

  it("rescues a shebang orphan to review-file medium instead of deleting it", () => {
    const plan = buildPlan(
      report({
        graph: graph({
          moduleFiles: ["src/index.ts", "tools/release.ts"],
          entrypoints: [entry("src/index.ts")],
          orphans: [orphan("tools/release.ts", 80, [], { hasShebang: true })],
        }),
      }),
      LOW,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action).toBe("review-file");
    expect(plan.items[0].confidence).toBe("medium");
    expect(plan.items[0].evidence).toContain("shebang");
  });

  it("caps every orphan item at low and warns when the graph has no module entrypoint", () => {
    const warning = "no module entrypoints discovered — orphan findings are unreliable; re-scan with --entry";
    // Case 1: entrypoints entirely empty.
    const empty = buildPlan(
      report({ graph: graph({ moduleFiles: ["src/dead.ts"], orphans: [orphan("src/dead.ts")] }) }),
      LOW,
    );
    expect(empty.items).toHaveLength(1);
    expect(empty.items[0].confidence).toBe("low");
    expect(empty.items[0].evidence).toContain("no module entrypoints");
    expect(empty.summary.warnings).toContain(warning);
    // Case 2: entrypoints exist but none is a module file — even a backup-named
    // orphan (normally high) is capped.
    const nonModule = buildPlan(
      report({
        graph: graph({
          moduleFiles: ["src/dead.ts", "src/dead-old.ts"],
          entrypoints: [entry("scripts/build.sh")],
          orphans: [orphan("src/dead.ts"), orphan("src/dead-old.ts")],
        }),
        junk: [junk("src/dead-old.ts", "backup-copy")],
      }),
      LOW,
    );
    expect(nonModule.items).toHaveLength(2);
    for (const item of nonModule.items) expect(item.confidence).toBe("low");
    const backup = nonModule.items.find((i) => i.target === "src/dead-old.ts");
    expect(backup?.evidence).toContain("backup copy");
    expect(nonModule.summary.warnings).toContain(warning);
  });

  it("merges an orphan that is also a backup copy into one high item mentioning both signals", () => {
    const plan = buildPlan(
      report({
        graph: graph({
          moduleFiles: ["src/index.ts", "src/utils-old.ts"],
          entrypoints: [entry("src/index.ts")],
          orphans: [orphan("src/utils-old.ts", 30)],
          dynamicImporters: ["src/loader.ts"],
        }),
        junk: [junk("src/utils-old.ts", "backup-copy", 30)],
      }),
      LOW,
    );
    // One item, high despite the dynamic imports, carrying both signals.
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action).toBe("delete-file");
    expect(plan.items[0].confidence).toBe("high");
    expect(plan.items[0].evidence).toContain("unreachable");
    expect(plan.items[0].evidence).toContain("backup copy");
  });

  it("routes build artifacts, logs, and caches to untrack-and-gitignore high", () => {
    const plan = buildPlan(
      report({
        junk: [junk("dist/main.js", "build-artifact"), junk("npm-debug.log", "log"), junk(".eslintcache", "cache")],
      }),
      LOW,
    );
    expect(plan.items).toHaveLength(3);
    for (const item of plan.items) {
      expect(item.action).toBe("untrack-and-gitignore");
      expect(item.confidence).toBe("high");
      expect(item.evidence).toContain(".gitignore");
    }
  });

  it("untracks OS droppings but only reviews .idea and .vscode files", () => {
    const plan = buildPlan(
      report({ junk: [junk(".DS_Store", "os-or-editor"), junk(".vscode/settings.json", "os-or-editor")] }),
      LOW,
    );
    const ds = plan.items.find((i) => i.target === ".DS_Store");
    const vscode = plan.items.find((i) => i.target === ".vscode/settings.json");
    expect(ds?.action).toBe("untrack-and-gitignore");
    expect(ds?.confidence).toBe("high");
    expect(vscode?.action).toBe("review-file");
    expect(vscode?.confidence).toBe("medium");
  });

  it("proposes deleting backup copies at medium confidence when they are not orphans", () => {
    const plan = buildPlan(report({ junk: [junk("src/utils-old.ts", "backup-copy", 55)] }), LOW);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action).toBe("delete-file");
    expect(plan.items[0].confidence).toBe("medium");
    expect(plan.items[0].reclaimBytes).toBe(55);
  });

  it("routes generated files to untrack medium and archives to review medium", () => {
    const plan = buildPlan(
      report({ junk: [junk("public/app.min.js", "generated"), junk("release.zip", "binary-or-archive")] }),
      LOW,
    );
    const generated = plan.items.find((i) => i.target === "public/app.min.js");
    const archive = plan.items.find((i) => i.target === "release.zip");
    expect(generated?.action).toBe("untrack-and-gitignore");
    expect(generated?.confidence).toBe("medium");
    expect(archive?.action).toBe("review-file");
    expect(archive?.confidence).toBe("medium");
  });

  it("never proposes any delete action for sensitive files, even byte-duplicated ones", () => {
    const plan = buildPlan(
      report({
        junk: [junk(".env", "sensitive"), junk("config/.env", "sensitive")],
        duplicateGroups: [dup([".env", "config/.env"], 200)],
      }),
      LOW,
    );
    expect(plan.items.some((i) => i.action === "delete-file")).toBe(false);
    const sensitive = plan.items.filter((i) => i.action === "review-sensitive");
    expect(sensitive).toHaveLength(2);
    for (const item of sensitive) {
      expect(item.confidence).toBe("high");
      expect(item.evidence).toBe("may contain secrets — never auto-delete; rotate credentials, untrack, and gitignore");
      expect(item.reclaimBytes).toBe(0);
    }
  });

  it("reviews unreferenced assets at low confidence with the scan reason", () => {
    const plan = buildPlan(
      report({
        unreferencedAssets: [{ path: "assets/old-logo.png", bytes: 5000, reason: "basename referenced by no tracked text file" }],
      }),
      LOW,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action).toBe("review-file");
    expect(plan.items[0].confidence).toBe("low");
    expect(plan.items[0].evidence).toContain("basename referenced by no tracked text file (5000 bytes)");
  });

  it("grades unused deps by field: dev high, runtime medium, peer and optional low", () => {
    const plan = buildPlan(
      report({
        packages: [
          pkg(".", {
            deps: [
              dep("dev-only", "devDependencies"),
              dep("runtime", "dependencies"),
              dep("peer", "peerDependencies"),
              dep("optional", "optionalDependencies"),
            ],
            unused: ["dev-only", "runtime", "peer", "optional"],
          }),
        ],
      }),
      LOW,
    );
    const byTarget = new Map(plan.items.map((i) => [i.target, i]));
    expect(byTarget.get("dev-only")?.confidence).toBe("high");
    expect(byTarget.get("runtime")?.confidence).toBe("medium");
    expect(byTarget.get("peer")?.confidence).toBe("low");
    expect(byTarget.get("optional")?.confidence).toBe("low");
    expect(plan.items.every((i) => i.action === "remove-dep" && i.packageDir === ".")).toBe(true);
    expect(byTarget.get("dev-only")?.id).toBe("remove-dep:dev-only:.");
    expect(byTarget.get("dev-only")?.evidence).toContain("devDependencies (^1.0.0)");
  });

  it("keeps an unused multi-field dependency manual at medium confidence", () => {
    const plan = buildPlan(
      report({
        packages: [
          pkg(".", {
            deps: [dep("lodash", "dependencies"), dep("lodash", "devDependencies")],
            unused: ["lodash"],
            dualDeclared: ["lodash"],
          }),
        ],
      }),
      LOW,
    );
    expect(plan.items).toHaveLength(1);
    const item = plan.items[0];
    expect(item.action).toBe("remove-dep");
    expect(item.confidence).toBe("medium");
    expect(item.evidence).toContain("least-safe runtime declaration controls");
    expect(plan.items.some((i) => i.action === "move-dep")).toBe(false);
  });

  it("keeps the dependencies side of a dual-declared dep imported by reachable non-test code", () => {
    const plan = buildPlan(
      report({
        graph: graph({ moduleFiles: ["src/app.ts"] }),
        packages: [
          pkg(".", {
            deps: [dep("lodash", "dependencies", { usedBy: ["src/app.ts"] }), dep("lodash", "devDependencies")],
            dualDeclared: ["lodash"],
          }),
        ],
      }),
      LOW,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action).toBe("move-dep");
    expect(plan.items[0].confidence).toBe("medium");
    expect(plan.items[0].evidence).toContain("keep the dependencies entry");
  });

  it("keeps the devDependencies side when a dual-declared dep is only used by tests", () => {
    const plan = buildPlan(
      report({
        packages: [
          pkg(".", {
            deps: [dep("lodash", "dependencies", { usedBy: ["tests/app.test.ts"] }), dep("lodash", "devDependencies")],
            dualDeclared: ["lodash"],
          }),
        ],
      }),
      LOW,
    );
    expect(plan.items[0].evidence).toContain("keep the devDependencies entry");
  });

  it("treats undeclared imports as high-priority missing deps and hoisted ones as low", () => {
    const plan = buildPlan(
      report({
        packages: [
          pkg("packages/app", {
            missing: [
              { name: "left-pad", importers: ["src/a.ts"], declaredIn: null },
              { name: "lodash", importers: ["src/b.ts"], declaredIn: "." },
            ],
          }),
        ],
      }),
      LOW,
    );
    const leftPad = plan.items.find((i) => i.target === "left-pad");
    const lodash = plan.items.find((i) => i.target === "lodash");
    expect(leftPad?.action).toBe("add-missing-dep");
    expect(leftPad?.confidence).toBe("high");
    expect(leftPad?.evidence).toContain("imported by 1 file (e.g. src/a.ts) but declared in no manifest");
    expect(lodash?.confidence).toBe("low");
    expect(lodash?.evidence).toContain("works via hoisting from . — declare explicitly");
    expect(lodash?.packageDir).toBe("packages/app");
  });

  it("downgrades add-missing-dep to low when every importer is an orphan the plan deletes", () => {
    const plan = buildPlan(
      report({
        graph: graph({
          moduleFiles: ["src/index.ts", "src/dead.ts"],
          entrypoints: [entry("src/index.ts")],
          orphans: [orphan("src/dead.ts")],
        }),
        packages: [pkg(".", { missing: [{ name: "left-pad", importers: ["src/dead.ts"], declaredIn: null }] })],
      }),
      LOW,
    );
    const item = plan.items.find((i) => i.target === "left-pad");
    expect(item?.action).toBe("add-missing-dep");
    expect(item?.confidence).toBe("low");
    expect(item?.evidence).toContain("only imported by files this plan deletes");
    expect(item?.evidence).toContain("delete those first and re-scan");
  });

  it("aligns workspace version skew with a dir-to-range evidence list", () => {
    const plan = buildPlan(
      report({ workspaceSkew: [{ name: "react", ranges: { "packages/b": "^18.0.0", ".": "^17.0.0" } }] }),
      LOW,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action).toBe("align-versions");
    expect(plan.items[0].confidence).toBe("medium");
    expect(plan.items[0].evidence).toContain("2 distinct ranges across the workspace: . → ^17.0.0, packages/b → ^18.0.0");
  });

  it("deduplicates lockfile drift into one project-level review item", () => {
    const lockfileDuplicates = Array.from({ length: 21 }, (_, i) => ({
      name: `dep-${String(i + 1).padStart(2, "0")}`,
      versions: ["1.0.0", "2.0.0"],
    }));
    lockfileDuplicates.push({ name: "dep-22", versions: ["1.0.0", "2.0.0", "3.0.0"] });
    const plan = buildPlan(report({ lockfileDuplicates }), LOW);
    const items = plan.items.filter((i) => i.action === "dedupe-lockfile");
    expect(items).toHaveLength(1);
    expect(items[0].target).toBe("pnpm-lock.yaml");
    expect(items[0].confidence).toBe("low");
    expect(items[0].relatedTargets).toContain("dep-22");
    expect(items[0].evidence).toContain("22 dependency names resolve to multiple versions");
  });

  it("consolidates overlapping package families at low confidence with the catalog hint", () => {
    const plan = buildPlan(
      report({
        overlaps: [{ family: "date libraries", packages: ["moment", "dayjs"], packageDir: ".", hint: "pick one date library" }],
      }),
      LOW,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].action).toBe("consolidate-overlap");
    expect(plan.items[0].target).toBe("date libraries");
    expect(plan.items[0].packageDir).toBe(".");
    expect(plan.items[0].confidence).toBe("low");
    expect(plan.items[0].evidence).toContain("2 date libraries in one manifest (dayjs, moment) — pick one date library");
  });

  it("emits one instruction when a path is both an orphan and a duplicate member", () => {
    // The orphan pass claims src/copy.ts first; the duplicate pass must not
    // add a second item, and the reachable twin src/a.ts survives untouched.
    const plan = buildPlan(
      report({
        duplicateGroups: [dup(["src/a.ts", "src/copy.ts"], 100)],
        graph: graph({
          moduleFiles: ["src/index.ts", "src/a.ts", "src/copy.ts"],
          entrypoints: [entry("src/index.ts")],
          orphans: [orphan("src/copy.ts", 100)],
        }),
      }),
      LOW,
    );
    expect(plan.items.some((i) => i.target === "src/a.ts")).toBe(false);
    const items = plan.items.filter((i) => i.target === "src/copy.ts");
    expect(items).toHaveLength(1);
    expect(items[0].action).toBe("delete-file");
    expect(items[0].confidence).toBe("high");
    expect(items[0].evidence).toContain("unreachable");
  });

  it("dedupes colliding remove-dep items keeping the least-safe confidence", () => {
    // Unused dep declared in two fields (not the dual dependencies/devDependencies
    // pair): one id, strongest confidence wins.
    const plan = buildPlan(
      report({
        packages: [pkg(".", { deps: [dep("tool", "devDependencies"), dep("tool", "peerDependencies")], unused: ["tool"] })],
      }),
      LOW,
    );
    const items = plan.items.filter((i) => i.target === "tool");
    expect(items).toHaveLength(1);
    expect(items[0].confidence).toBe("low");
  });

  it("rescues items matching --keep patterns without counting them as actions", () => {
    const plan = buildPlan(
      report({
        files: [file("src/a.ts", { bytes: 10 }), file("src/b.ts", { bytes: 20 })],
        graph: graph({
          moduleFiles: ["src/index.ts", "src/a.ts", "src/b.ts"],
          entrypoints: [entry("src/index.ts")],
          orphans: [orphan("src/a.ts", 10), orphan("src/b.ts", 20)],
        }),
      }),
      { keep: ["b\\.ts$"], minConfidence: "low" },
    );
    const rescued = plan.items.find((i) => i.target === "src/b.ts");
    expect(rescued?.rescued).toBe(true);
    expect(rescued?.keepPattern).toBe("b\\.ts$");
    expect(plan.items).toHaveLength(2); // still in the plan as an audit trail
    expect(plan.summary.itemsRescued).toBe(1);
    expect(plan.summary.deleteFiles).toBe(1);
    expect(plan.summary.byAction["delete-file"]).toBe(1);
    expect(plan.summary.reclaimBytes).toBe(10); // rescued bytes do not count
  });

  it("rescues by plan-item id as well as by target", () => {
    const plan = buildPlan(
      report({ packages: [pkg(".", { deps: [dep("lodash", "devDependencies")], unused: ["lodash"] })] }),
      { keep: ["^remove-dep:lodash"], minConfidence: "low" },
    );
    expect(plan.items[0].rescued).toBe(true);
    expect(plan.items[0].keepPattern).toBe("^remove-dep:lodash");
    expect(plan.summary.removeDeps).toBe(0);
  });

  it("keeps review-only findings visible regardless of --min-confidence", () => {
    const r = report({
      graph: graph({
        moduleFiles: ["src/index.ts", "src/dead.ts"],
        entrypoints: [entry("src/index.ts")],
        orphans: [orphan("src/dead.ts")],
      }), // high
      junk: [junk("src/utils-old.ts", "backup-copy")], // medium
      unreferencedAssets: [{ path: "img/x.png", bytes: 1, reason: "unreferenced" }], // low
    });
    const medium = buildPlan(r, { keep: [], minConfidence: "medium" });
    expect(medium.items.map((i) => i.target).sort()).toEqual(["img/x.png", "src/dead.ts", "src/utils-old.ts"]);
    expect(medium.summary.warnings).toEqual([]);
    const high = buildPlan(r, { keep: [], minConfidence: "high" });
    expect(high.items.map((i) => i.target).sort()).toEqual(["img/x.png", "src/dead.ts", "src/utils-old.ts"]);
    expect(high.summary.warnings).toEqual([]);
  });

  it("sorts items by action group order, then confidence high-to-low, then target", () => {
    const plan = buildPlan(
      report({
        duplicateGroups: [dup(["img/_canon.png", "img/aa.png", "img/b.png"], 10)],
        unreferencedAssets: [
          { path: "img/aa.png", bytes: 10, reason: "unreferenced" },
          { path: "img/b.png", bytes: 10, reason: "unreferenced" },
          { path: "img/x.png", bytes: 1, reason: "unreferenced" },
        ],
        junk: [junk("src/a-old.ts", "backup-copy"), junk("dist/x.js", "build-artifact")],
        packages: [pkg(".", { deps: [dep("unused-a", "devDependencies")], unused: ["unused-a"] })],
      }),
      LOW,
    );
    expect(plan.items.map((i) => [i.action, i.target])).toEqual([
      ["delete-file", "img/aa.png"], // high before medium, targets ascending within a tier
      ["delete-file", "img/b.png"],
      ["delete-file", "src/a-old.ts"],
      ["review-file", "img/x.png"],
      ["remove-dep", "unused-a"],
      ["untrack-and-gitignore", "dist/x.js"],
    ]);
  });

  it("is deterministic: repeat and re-ordered-input runs are byte-identical minus createdAt", () => {
    const rich = (): RepoReport =>
      report({
        files: [file("lib/x.js"), file("lib/y.js"), file("lib/z.js", { symlink: true })],
        duplicateGroups: [dup(["src/a.ts", "src/a-copy.ts"], 50), dup(["lib/x.js", "lib/y.js", "lib/z.js"], 30)],
        graph: graph({
          moduleFiles: ["src/index.ts", "src/a.ts", "src/dead.ts", "src/dead2.ts"],
          entrypoints: [entry("src/index.ts")],
          orphans: [orphan("src/dead.ts", 10), orphan("src/dead2.ts", 20, ["src/dead.ts"])],
        }),
        junk: [junk("dist/app.js", "build-artifact"), junk(".env", "sensitive"), junk("notes-old.md", "backup-copy")],
        unreferencedAssets: [
          { path: "img/a.png", bytes: 5, reason: "unreferenced" },
          { path: "img/b.png", bytes: 6, reason: "unreferenced" },
        ],
        packages: [
          pkg("packages/app", {
            deps: [
              dep("axios", "dependencies"),
              dep("vitest", "devDependencies", { usedBy: ["tests/a.test.ts"] }),
              dep("vitest", "dependencies", { usedBy: ["tests/a.test.ts"] }),
            ],
            unused: ["axios"],
            dualDeclared: ["vitest"],
            missing: [{ name: "left-pad", importers: ["src/b.ts", "src/a.ts"], declaredIn: null }],
          }),
          pkg("."),
        ],
        workspaceSkew: [{ name: "react", ranges: { "packages/app": "^18.2.0", ".": "^18.3.0" } }],
        lockfileDuplicates: [
          { name: "tslib", versions: ["1.14.1", "2.6.2"] },
          { name: "semver", versions: ["6.3.1", "7.6.0"] },
        ],
        overlaps: [{ family: "date libraries", packages: ["moment", "dayjs"], packageDir: "packages/app", hint: "pick one" }],
      });
    const reordered = (): RepoReport => {
      const clone: RepoReport = JSON.parse(JSON.stringify(rich()));
      clone.files.reverse();
      clone.duplicateGroups.reverse();
      for (const g of clone.duplicateGroups) g.paths.reverse();
      clone.graph.moduleFiles.reverse();
      clone.graph.entrypoints.reverse();
      clone.graph.orphans.reverse();
      clone.junk.reverse();
      clone.unreferencedAssets.reverse();
      clone.packages.reverse();
      for (const p of clone.packages) {
        p.deps.reverse();
        p.unused.reverse();
        p.missing.reverse();
      }
      clone.workspaceSkew.reverse();
      clone.lockfileDuplicates.reverse();
      clone.overlaps.reverse();
      return clone;
    };
    const opts: PlanOptions = { keep: ["img/"], minConfidence: "low" };
    const stable = (plan: CleanupPlan): string => JSON.stringify({ ...plan, createdAt: "<t>" });
    const first = stable(buildPlan(rich(), opts));
    expect(stable(buildPlan(rich(), opts))).toBe(first);
    expect(stable(buildPlan(reordered(), opts))).toBe(first);
  });
});

describe("markdown rendering", () => {
  it("formats bytes as B, KB, and MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("renders a markdown plan with summary estimates, action sections, rescued items, and next steps", () => {
    const r = report({
      totals: { trackedFiles: 10, trackedBytes: 10_000, moduleFiles: 5, packages: 1, declaredDeps: 3 },
      files: [file("src/index.ts"), file("src/dead.ts", { bytes: 4000 }), file(".env"), file("img/old.png", { bytes: 2000 })],
      graph: graph({
        moduleFiles: ["src/index.ts", "src/dead.ts"],
        entrypoints: [entry("src/index.ts")],
        orphans: [orphan("src/dead.ts", 4000)],
      }),
      junk: [junk(".env", "sensitive")],
      unreferencedAssets: [{ path: "img/old.png", bytes: 2000, reason: "basename referenced by no tracked text file" }],
    });
    const plan = buildPlan(r, { keep: ["old\\.png$"], minConfidence: "low" });
    const md = renderPlanMarkdown(plan, r);
    expect(md).toContain("# Repo cleanup plan");
    expect(md).toContain("| Tracked files | 10 | **9** |");
    expect(md).toContain("| Tracked size | 9.8 KB | 5.9 KB |");
    expect(md).toContain("## Delete files (1)");
    expect(md).toContain("## Sensitive files — review, never auto-delete (1)");
    expect(md).toContain("## Rescued by --keep (1)");
    expect(md).toContain("<code>old\\.png$</code>");
    expect(md).toContain("repo-doctor-verify.mjs");
    expect(md).toContain("--run-gates --trust-repo");
  });

  it("estimates the declared-deps delta from adds minus removes; move-dep does not change the count", () => {
    const r = report({
      totals: { trackedFiles: 5, trackedBytes: 1000, moduleFiles: 3, packages: 1, declaredDeps: 5 },
      graph: graph({ moduleFiles: ["src/app.ts"] }),
      packages: [
        pkg(".", {
          deps: [
            dep("unused-x", "devDependencies"),
            dep("lodash", "dependencies", { usedBy: ["src/app.ts"] }),
            dep("lodash", "devDependencies"),
          ],
          unused: ["unused-x"],
          dualDeclared: ["lodash"],
        }),
      ],
    });
    const plan = buildPlan(r, LOW);
    expect(plan.summary.byAction["remove-dep"]).toBe(1);
    expect(plan.summary.byAction["move-dep"]).toBe(1);
    const md = renderPlanMarkdown(plan, r);
    // 5 declared − 1 removed; the move-dep must NOT subtract (the old code showed 3).
    expect(md).toContain("| Declared deps | 5 | 4 |");
  });

  it("renders explicit tool-root, exact approval, and trusted-gate semantics", () => {
    const r = report();
    const md = renderPlanMarkdown(buildPlan(r, LOW), r);
    expect(md).toContain("REPO_DOCTOR_ROOT='<repo-doctor-root>'");
    expect(md).toContain("--approve <item-id>");
    expect(md).toContain("repo-doctor-verify.mjs");
    expect(md).toContain("--run-gates --trust-repo");
  });

  it("renders warnings verbatim and omits action sections whose items were all rescued", () => {
    const r = report({
      graph: graph({
        moduleFiles: ["src/index.ts", "src/dead.ts"],
        entrypoints: [entry("src/index.ts")],
        orphans: [orphan("src/dead.ts")],
      }),
      unreferencedAssets: [{ path: "img/x.png", bytes: 1, reason: "unreferenced" }],
    });
    const plan = buildPlan(r, { keep: ["^delete-file:src/dead\\.ts$"], minConfidence: "medium" });
    const md = renderPlanMarkdown(plan, r);
    expect(md).toContain("## Review files");
    expect(md).not.toContain("## Delete files");
    expect(md).toContain("## Rescued by --keep (1)");
  });
});
