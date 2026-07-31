import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { writeArtifactAtomic } from "../scripts/lib/artifacts.ts";
import { analyzeDeps, loadManifests } from "../scripts/lib/deps.ts";
import { run } from "../scripts/lib/exec.ts";
import { extractImports } from "../scripts/lib/imports.ts";
import { detectLockfile, parseLockfile } from "../scripts/lib/lockfile.ts";
import { buildPlan } from "../scripts/lib/planner.ts";
import { discoverProjects } from "../scripts/lib/projects.ts";
import { renderPlanMarkdown } from "../scripts/lib/render.ts";
import { loadTsPaths, resolveSpecifier } from "../scripts/lib/resolve.ts";
import { compareScans, pickGates, resolveVerifyScanOptions } from "../scripts/lib/verify-core.ts";
import type { PackageManifest, PackageReport, RepoReport } from "../scripts/lib/types.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bins = {
  scan: join(root, "bin/repo-doctor-scan.mjs"),
  plan: join(root, "bin/repo-doctor-plan.mjs"),
  verify: join(root, "bin/repo-doctor-verify.mjs"),
};
const scratch: string[] = [];

function temp(prefix = "rd-v2-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function writeTree(base: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), content);
  }
}

function gitRepo(files: Record<string, string>, prefix = "rd-v2-"): string {
  const dir = temp(prefix);
  writeTree(dir, files);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Repo Doctor", "-c", "user.email=doctor@example.com", "commit", "-q", "-m", "fixture"], { cwd: dir });
  return dir;
}

function cli(file: string, args: string[], cwd = root) {
  return spawnSync(process.execPath, [file, ...args], { cwd, encoding: "utf8", env: process.env });
}

function manifest(dir: string, raw: Record<string, unknown>): PackageManifest {
  return loadManifests(".", [dir === "." ? "package.json" : `${dir}/package.json`], () => JSON.stringify(raw)).manifests[0];
}

function baseReport(over: Partial<RepoReport> = {}): RepoReport {
  return {
    version: 2, tool: "repo-doctor", toolVersion: "0.2.0", createdAt: "now", cwd: "/repo",
    source: { repository: { id: "repo", kind: "git-history", root: "/repo", head: "abc", rootCommits: ["root"] }, inventoryDigest: "inventory", indexDigest: "index", trackedWorktreeClean: true },
    scanOptions: { ignore: [], entries: [], largeCount: 20, minDupBytes: 1 }, scanOptionsDigest: "options",
    health: { inventory: "complete", graph: "complete", dependencies: "complete", workspace: "complete", lockfile: "not-applicable" },
    diagnostics: [], projects: [{ rootDir: ".", kind: "standalone", manager: { status: "none", name: null, version: null, source: null, lockfilePath: null, conflicts: [] }, workspacePatterns: [], packageDirs: ["."], packageNames: ["root"], workspaceSkew: [], lockfile: { path: null, dialect: null, parseStatus: "not-applicable", diagnostics: [] }, diagnostics: [] }],
    packageManager: null, lockfileKind: null,
    totals: { trackedFiles: 0, trackedBytes: 0, moduleFiles: 0, packages: 0, declaredDeps: 0 },
    files: [], duplicateGroups: [], graph: { moduleFiles: [], entrypoints: [], orphans: [], unresolved: [], dynamicImporters: [], resolvedEdges: [], health: { status: "complete", diagnostics: [] } },
    unreferencedAssets: [], packages: [], workspaceSkew: [], lockfileDuplicates: [], overlaps: [], junk: [], largeFiles: [], warnings: [],
    ...over,
  };
}

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("Repo Doctor 0.2.0 issue regression matrix", () => {
  it("[01] rejects a symlink artifact target and preserves its referent", () => {
    const dir = temp();
    writeFileSync(join(dir, "real.json"), "original");
    symlinkSync("real.json", join(dir, "out.json"));
    expect(() => writeArtifactAtomic("out.json", "replacement", { cwd: dir })).toThrow(/symlink/);
    expect(readFileSync(join(dir, "real.json"), "utf8")).toBe("original");
    mkdirSync(join(dir, "real-dir"));
    symlinkSync("real-dir", join(dir, "linked-dir"));
    expect(() => writeArtifactAtomic("linked-dir/out.json", "replacement", { cwd: dir })).toThrow(/symlink/);
  });

  it("[02] binds verify to the exact reviewed report bytes", () => {
    const dir = gitRepo({ ".gitignore": ".repo-doctor/\n", "package.json": JSON.stringify({ name: "fixture", main: "src/index.js" }), "src/index.js": "export const ok = true;\n" });
    expect(cli(bins.scan, ["--cwd", dir]).status).toBe(0);
    expect(cli(bins.plan, ["--cwd", dir]).status).toBe(0);
    const planPath = join(dir, ".repo-doctor/plan.json");
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    plan.source.reportSha256 = "sha256:tampered";
    writeFileSync(planPath, JSON.stringify(plan));
    const result = cli(bins.verify, ["--cwd", dir]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/not bound to these exact report bytes/);

    const clean = gitRepo({ ".gitignore": ".repo-doctor/\n", "package.json": JSON.stringify({ name: "fixture", main: "src/index.js" }), "src/index.js": "export const ok = true;\n" });
    expect(cli(bins.scan, ["--cwd", clean]).status).toBe(0);
    expect(cli(bins.plan, ["--cwd", clean]).status).toBe(0);
    const cleanPlanPath = join(clean, ".repo-doctor/plan.json");
    const cleanPlan = JSON.parse(readFileSync(cleanPlanPath, "utf8"));
    cleanPlan.items.push({ id: "delete-file:src/index.js", action: "delete-file", target: "src/index.js", packageDir: null, confidence: "high", disposition: "proposed", evidence: "tampered", evidenceItems: [], reclaimBytes: 1, rescued: false, keepPattern: null, prerequisites: [], relatedTargets: [], decision: { status: "approved", source: "approve-id", value: "delete-file:src/index.js" }, mutations: [{ kind: "delete-file", path: "src/index.js", beforeHash: "sha256:fake" }] });
    writeFileSync(cleanPlanPath, JSON.stringify(cleanPlan));
    const tampered = cli(bins.verify, ["--cwd", clean]);
    expect(tampered.status).toBe(2);
    expect(tampered.stderr).toMatch(/tampered plan|plan contents do not match/);
  });

  it("[03] rejects verify-time ignore or entry additions", () => {
    const report = baseReport({ scanOptions: { ignore: ["^vendor/"], entries: ["cli.ts"], largeCount: 20, minDupBytes: 1 } });
    expect(() => resolveVerifyScanOptions(report, ["^secret/"], [])).toThrow(/cannot add --ignore/);
    expect(() => resolveVerifyScanOptions(report, [], ["new.ts"])).toThrow(/cannot add --entry/);
  });

  it("[04] resolves multi-hop TS baseUrl, private imports, exports, and Vite globs", () => {
    const dir = temp();
    writeTree(dir, {
      "base.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
      "middle.json": JSON.stringify({ extends: "./base.json" }),
      "tsconfig.json": JSON.stringify({ extends: ["./middle.json"] }),
    });
    expect(loadTsPaths(dir)?.baseUrl).toBe(".");
    const files = new Set(["src/x.ts", "pkg/src/button.ts"]);
    const packages = [{ name: "root", dir: ".", entry: null, imports: { "#x": "./src/x.ts" } }, { name: "@acme/ui", dir: "pkg", entry: null, exports: { "./*": "./src/*.ts" } }];
    expect(resolveSpecifier("src/main.ts", "#x", files, null, packages)).toEqual({ kind: "internal", path: "src/x.ts" });
    expect(resolveSpecifier("src/main.ts", "@acme/ui/button", files, null, packages)).toEqual({ kind: "internal", path: "pkg/src/button.ts" });
    expect(extractImports('const pages = import.meta.glob(["./pages/*.ts", "!./pages/old.ts"]);').viteGlobs).toEqual(["!./pages/old.ts", "./pages/*.ts"]);
  });

  it("[05] treats resolved alias edges as files, not phantom npm packages", () => {
    const rootManifest = manifest(".", { name: "root" });
    const result = analyzeDeps({ manifests: [rootManifest], importsByFile: new Map([["src/app.ts", ["@/util"]]]), resolvedEdges: [{ from: "src/app.ts", specifier: "@/util", source: "static", context: "runtime", target: "file", path: "src/util.ts", packageName: null }], textFiles: [], workspacePkgNames: new Set() });
    expect(result.packages[0].missing).toEqual([]);
  });

  it("[06] lets the least-safe declaration control dependency confidence", () => {
    const pkg: PackageReport = { dir: ".", name: "root", deps: [{ name: "tool", field: "devDependencies", range: "1", usedBy: [], textHits: [], implicitReason: null }, { name: "tool", field: "peerDependencies", range: "1", usedBy: [], textHits: [], implicitReason: null }], unused: ["tool"], missing: [], dualDeclared: [] };
    expect(buildPlan(baseReport({ packages: [pkg] }), { keep: [], minConfidence: "low" }).items[0].confidence).toBe("low");
  });

  it("[07] requires Node 22.13 and exposes all committed MJS commands", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.engines.node).toBe(">=22.13");
    expect(Object.values(pkg.bin)).toEqual(["bin/repo-doctor-scan.mjs", "bin/repo-doctor-plan.mjs", "bin/repo-doctor-verify.mjs"]);
    for (const file of Object.values(bins)) expect(existsSync(file)).toBe(true);
  });

  it("[08] does not leak sibling script evidence between packages", () => {
    const manifests = [manifest(".", { name: "root", devDependencies: { turbo: "1" } }), manifest("apps/web", { name: "web", scripts: { build: "turbo build" } })];
    const result = analyzeDeps({ manifests, importsByFile: new Map(), textFiles: [], workspacePkgNames: new Set() });
    expect(result.packages.find((pkg) => pkg.dir === ".")?.unused).toEqual(["turbo"]);
  });

  it("[09] reports an undeclared workspace import instead of auto-rescuing it", () => {
    const manifests = [manifest(".", { name: "root" }), manifest("packages/ui", { name: "@acme/ui" })];
    const result = analyzeDeps({ manifests, importsByFile: new Map(), resolvedEdges: [{ from: "src/app.ts", specifier: "@acme/ui", source: "static", context: "runtime", target: "workspace-package", path: "packages/ui/index.ts", packageName: "@acme/ui" }], textFiles: [], workspacePkgNames: new Set(["@acme/ui"]) });
    expect(result.packages.find((pkg) => pkg.dir === ".")?.missing[0]).toMatchObject({ name: "@acme/ui", kind: "workspace", suggestedRange: "workspace:*" });
  });

  it("[10] distinguishes declared members, standalone roots, and unmanaged manifests", () => {
    const manifests = [manifest(".", { name: "root", packageManager: "pnpm@11", workspaces: ["packages/*"] }), manifest("packages/a", { name: "a" }), manifest("tools/standalone", { name: "standalone", packageManager: "npm@10" }), manifest("loose", { name: "loose" })];
    const tracked = ["package.json", "pnpm-lock.yaml", "packages/a/package.json", "tools/standalone/package.json", "tools/standalone/package-lock.json", "loose/package.json"];
    const projects = discoverProjects({ manifests, trackedFiles: tracked, readFile: () => "" }).projects;
    expect(projects.map((project) => [project.rootDir, project.kind])).toEqual([[".", "workspace"], ["loose", "unmanaged"], ["tools/standalone", "standalone"]]);
  });

  it("[11] recognizes scoped ESLint plugin shorthand in package-owned config", () => {
    const manifests = [manifest(".", { name: "root", devDependencies: { "@acme/eslint-plugin": "1" } })];
    const result = analyzeDeps({ manifests, importsByFile: new Map(), textFiles: [{ path: "eslint.config.js", content: 'plugins: { "@acme": plugin }' }], workspacePkgNames: new Set() });
    expect(result.packages[0].deps[0].implicitReason).toMatch(/eslint config/);
  });

  it("[12] blocks high-confidence unused dependency advice in a dynamic-loading package", () => {
    const manifests = [manifest(".", { name: "root", devDependencies: { plugin: "1" } })];
    const result = analyzeDeps({ manifests, importsByFile: new Map([["src/loader.ts", []]]), textFiles: [], workspacePkgNames: new Set(), dynamicImporters: new Set(["src/loader.ts"]) });
    expect(result.packages[0].unused).toEqual([]);
    expect(result.packages[0].uncertain).toEqual(["plugin"]);
  });

  it("[13] defers an orphan-only dependency until a fresh scan", () => {
    const pkg: PackageReport = { dir: ".", name: "root", deps: [{ name: "old-lib", field: "devDependencies", range: "1", usedBy: ["src/old.ts"], textHits: [], implicitReason: null }], unused: [], orphanOnly: ["old-lib"], missing: [], dualDeclared: [] };
    const report = baseReport({ files: [{ path: "src/old.ts", bytes: 1, hash: "h", ext: "ts", symlink: false }], graph: { ...baseReport().graph, moduleFiles: ["src/old.ts"], orphans: [{ path: "src/old.ts", bytes: 1, importers: [], pathReferencedBy: [], hasShebang: false }] }, packages: [pkg] });
    expect(buildPlan(report, { keep: [], minConfidence: "low" }).items.find((item) => item.target === "old-lib")).toMatchObject({ disposition: "deferred", mutations: [] });
  });

  it("[14] carries diagnostics into the plan and blocks only affected scope", () => {
    const diagnostic = { code: "graph.bad-config", severity: "error" as const, source: "graph" as const, message: "bad config", affects: ["graph" as const], scope: { kind: "file" as const, path: "src/old.ts" } };
    const report = baseReport({ diagnostics: [diagnostic], files: [{ path: "src/old.ts", bytes: 1, hash: "h", ext: "ts", symlink: false }], graph: { ...baseReport().graph, moduleFiles: ["src/old.ts"], orphans: [{ path: "src/old.ts", bytes: 1, importers: [], pathReferencedBy: [], hasShebang: false }] } });
    const plan = buildPlan(report, { keep: [], minConfidence: "high" });
    expect(plan.diagnostics).toEqual([diagnostic]);
    expect(plan.items[0].disposition).toBe("blocked");
  });

  it("[15] detects a newly hard-missing dependency even when it was previously hoisted", () => {
    const pkg = (declaredIn: string | null): PackageReport => ({ dir: "app", name: "app", deps: [], unused: [], missing: [{ name: "zod", importers: ["app/a.ts"], declaredIn }], dualDeclared: [] });
    expect(compareScans(baseReport({ packages: [pkg(".")] }), baseReport({ packages: [pkg(null)] })).regressions.newMissingDeps).toEqual([{ packageDir: "app", name: "zod" }]);
  });

  it("[16] performs a final scan and rejects gate-induced tracked changes", () => {
    const dir = gitRepo({ ".gitignore": ".repo-doctor/\n", "package.json": JSON.stringify({ name: "fixture", main: "src/index.js" }), "src/index.js": "export const value = 1;\n", "mutate.cjs": 'require("node:fs").writeFileSync("src/index.js", "export const value = 2;\\n")' });
    expect(cli(bins.scan, ["--cwd", dir]).status).toBe(0);
    expect(cli(bins.plan, ["--cwd", dir]).status).toBe(0);
    const result = cli(bins.verify, ["--cwd", dir, "--run-gates", "--trust-repo", "--skip-install", "--gate", "node mutate.cjs"]);
    expect(result.status).toBe(1);
    const verdict = JSON.parse(readFileSync(join(dir, ".repo-doctor/verify.json"), "utf8"));
    expect(verdict.regressions.gateInducedTrackedChanges).toContain("src/index.js");
  });

  it("[17] never defaults an unknown project to npm", () => {
    expect(pickGates(null, null, { skipInstall: false, skipTypecheck: false, skipBuild: false, skipTest: false, custom: [] })).toEqual([]);
  });

  it("[18] ignores untracked lockfiles and marks tracked multi-manager state ambiguous", () => {
    const dir = temp();
    writeTree(dir, { "pnpm-lock.yaml": "", "package-lock.json": "{}" });
    expect(detectLockfile(dir, ["package-lock.json"])).toEqual({ kind: "package-lock.json", pm: "npm" });
    expect(detectLockfile(dir, ["pnpm-lock.yaml", "package-lock.json"])).toBeNull();
    expect(detectLockfile(dir, ["package-lock.json", "npm-shrinkwrap.json"])).toBeNull();
  });

  it("[19] executes the compiled scanner through a symlink", () => {
    const dir = temp();
    const link = join(dir, "doctor scan.mjs");
    symlinkSync(bins.scan, link);
    expect(cli(link, ["--help"]).status).toBe(0);
  });

  it("[20] defines and quotes REPO_DOCTOR_ROOT instead of using an undefined skill variable", () => {
    const skill = readFileSync(join(root, "SKILL.md"), "utf8");
    expect(skill).toContain('REPO_DOCTOR_ROOT="/absolute/path/to/installed/repo-doctor"');
    expect(skill).toContain('node "$REPO_DOCTOR_ROOT/bin/repo-doctor-scan.mjs"');
    expect(skill).not.toContain("$SKILL");
  });

  it("[21] writes plan defaults under --cwd, not the tool checkout", () => {
    const dir = gitRepo({ ".gitignore": ".repo-doctor/\n", "package.json": JSON.stringify({ name: "fixture", main: "index.js" }), "index.js": "export {};\n" }, "repo doctor spaced ");
    expect(cli(bins.scan, ["--cwd", dir]).status).toBe(0);
    expect(cli(bins.plan, ["--cwd", dir]).status).toBe(0);
    expect(existsSync(join(dir, ".repo-doctor/plan.json"))).toBe(true);
  });

  it("[22] scrubs secrets by default and forwards only explicitly named variables", async () => {
    process.env.REPO_DOCTOR_TEST_SECRET = "visible-only-when-passed";
    const code = "process.stdout.write(process.env.REPO_DOCTOR_TEST_SECRET || 'absent')";
    const scrubbed = await run(process.execPath, ["-e", code], { cwd: root, timeoutMs: 5000, environment: "minimal" });
    const passed = await run(process.execPath, ["-e", code], { cwd: root, timeoutMs: 5000, environment: "minimal", passEnv: ["REPO_DOCTOR_TEST_SECRET"] });
    delete process.env.REPO_DOCTOR_TEST_SECRET;
    expect(scrubbed.stdout).toBe("absent");
    expect(passed.stdout).toBe("visible-only-when-passed");
  });

  it("[23] bounds output and times out the complete process invocation", async () => {
    const noisy = await run(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000))"], { cwd: root, timeoutMs: 5000 });
    expect(noisy.stdout.length).toBeLessThanOrEqual(64 * 1024);
    expect(noisy.stdoutTruncated).toBe(true);
    const timed = await run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: root, timeoutMs: 50 });
    expect(timed.timedOut).toBe(true);
  });

  it("[24] escapes Markdown table injection, HTML, newlines, and backticks", () => {
    const report = baseReport({ warnings: ["bad | <tag>\n`tick`"] });
    const markdown = renderPlanMarkdown(buildPlan(report, { keep: [], minConfidence: "low" }), report);
    expect(markdown).toContain("bad &#124; &lt;tag&gt;<br>&#96;tick&#96;");
  });

  it("[25] keeps rescued low-confidence items visible above a high threshold", () => {
    const report = baseReport({ unreferencedAssets: [{ path: "public/live.png", bytes: 1, reason: "unreferenced" }] });
    const plan = buildPlan(report, { keep: ["public/live"], minConfidence: "high" });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ rescued: true, decision: { status: "kept" } });
  });

  it("[26] parses CRLF Yarn Berry and reports corrupt locks explicitly", () => {
    const berry = parseLockfile("yarn.lock", '__metadata:\r\n  version: 8\r\n"pkg@npm:^1.0.0":\r\n  version: 1.2.3\r\n');
    expect(berry).toMatchObject({ dialect: "yarn-berry", parseStatus: "parsed" });
    expect([...berry.versions.get("pkg") ?? []]).toEqual(["1.2.3"]);
    expect(parseLockfile("package-lock.json", "{broken")).toMatchObject({ parseStatus: "invalid" });
    const alias = parseLockfile("yarn.lock", '# yarn lockfile v1\n"alias@npm:real@^1.0.0":\n  version "1.2.3"\n');
    expect([...alias.versions.get("alias") ?? []]).toEqual(["1.2.3"]);
  });
});
