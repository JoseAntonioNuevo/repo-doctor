#!/usr/bin/env -S npx tsx
/**
 * SCAN — inventory the repository: files, duplicates, module graph, junk,
 * dependencies, and lockfile drift.
 *
 * Analyzes git-tracked files only and writes a machine-readable report
 * consumed by plan.ts and verify.ts. Read-only: nothing is modified.
 *
 * Standalone usage (no skill system required):
 *   node bin/repo-doctor-scan.mjs --cwd /path/to/repo
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, posix, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { OVERLAP_FAMILIES } from "./lib/catalogs.ts";
import { canonicalJson, resolveSafePath, sha256, writeArtifactAtomic } from "./lib/artifacts.ts";
import { analyzeDeps, loadManifests } from "./lib/deps.ts";
import { buildModuleGraph } from "./lib/graph.ts";
import { findJunk } from "./lib/junk.ts";
import { detectLockfile, findLockfileDuplicates, parseLockfile } from "./lib/lockfile.ts";
import { discoverProjects } from "./lib/projects.ts";
import { repositorySnapshot } from "./lib/repository.ts";
import { loadTsPaths, type TsConfigIssue, type TsPathsConfig, type WorkspacePkg } from "./lib/resolve.ts";
import { collectFileInfo, findDuplicates, largestFiles, listTrackedFiles } from "./lib/walk.ts";
import type {
  AssetFinding,
  LockfileDuplicate,
  OverlapFinding,
  PackageManager,
  PackageManifest,
  RepoReport,
  Diagnostic,
} from "./lib/types.ts";

export const TOOL_VERSION = "0.2.0";

const HELP = `scan — inventory a repository's files, module graph, and dependencies

Usage: node repo-doctor-scan.mjs [options]

Options:
  --cwd <dir>            Target repo root (default: current directory)
  --out <file>           Report path (default: .repo-doctor/report.json)
  --ignore <regex>       Drop matching tracked paths from ALL analysis
                         (repeatable)
  --entry <path>         Extra module-graph entrypoint, repo-relative
                         (repeatable) — use for files loaded dynamically
  --large-count <n>      How many largest files to report (default: 20)
  --min-dup-bytes <n>    Ignore duplicate files smaller than this (default: 1)
  --concurrency <n>      Parallel file reads (default: 8)
  --allow-output-outside-cwd
                         Permit the report outside the target root
  --help                 Show this help

Exit codes: 0 report written, 2 environment/usage error.`;

function fail(msg: string): never {
  console.error(`\nscan: ${msg}`);
  process.exit(2);
}

/** Extensions read as text and searched for asset/dependency references. */
const TEXT_EXTS = new Set(
  (
    "js,jsx,ts,tsx,mjs,cjs,mts,cts,json,jsonc,json5,yaml,yml,md,mdx,html,htm,css,scss," +
    "sass,less,vue,svelte,astro,toml,ini,txt,xml,svg,graphql,gql,prisma,sql,sh,bash,zsh," +
    "fish,ps1,py,rb,go,rs,env,cfg,conf,properties,tf,tfvars,mk,cmake,gradle,bat"
  ).split(","),
);

/** Extensions treated as assets (svg is BOTH text and asset — searched as both). */
const ASSET_EXTS = new Set(
  "png,jpg,jpeg,gif,webp,avif,ico,bmp,tiff,svg,woff,woff2,ttf,otf,eot,mp3,mp4,webm,ogg,wav,pdf".split(
    ",",
  ),
);

/** Assets served by convention — never flagged as unreferenced. */
const WELL_KNOWN_ASSET_PREFIXES = [
  "favicon",
  "robots.txt",
  "sitemap",
  "manifest",
  "apple-touch",
  "og-image",
  "opengraph-image",
  "twitter-image",
  "icon",
  "apple-icon",
];

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const LOCKFILE_NAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

const MODULE_EXTS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"];

/** First string leaf of a package.json exports-style value (import/require/default first). */
function firstStringLeaf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["import", "require", "default"]) {
    const hit = firstStringLeaf(record[key]);
    if (hit) return hit;
  }
  for (const v of Object.values(record)) {
    const hit = firstStringLeaf(v);
    if (hit) return hit;
  }
  return null;
}

/**
 * Derive the workspace-package view of the manifests for the module graph:
 * name, dir, and a best-effort entry file (main/module/exports["."], falling
 * back to <dir>/index.*). Only manifests with a real "name" participate —
 * unnamed manifests cannot be imported by specifier.
 */
function deriveWorkspacePkgs(manifests: PackageManifest[], fileSet: Set<string>): WorkspacePkg[] {
  const resolveEntry = (dir: string, candidate: string): string | null => {
    const base = posix.normalize(posix.join(dir === "." ? "" : dir, candidate));
    const tries = [
      base,
      ...MODULE_EXTS.map((e) => `${base}.${e}`),
      ...MODULE_EXTS.map((e) => `${base}/index.${e}`),
    ];
    return tries.find((p) => fileSet.has(p)) ?? null;
  };
  const pkgs: WorkspacePkg[] = [];
  for (const m of manifests) {
    if (typeof m.raw.name !== "string" || m.raw.name.length === 0) continue;
    const exportsRaw = m.raw.exports;
    const dotExport =
      exportsRaw !== null && typeof exportsRaw === "object" && "." in exportsRaw
        ? (exportsRaw as Record<string, unknown>)["."]
        : exportsRaw;
    const candidates = [m.raw.main, m.raw.module, firstStringLeaf(dotExport)].filter(
      (c): c is string => typeof c === "string" && c.length > 0,
    );
    let entry: string | null = null;
    for (const c of candidates) {
      entry = resolveEntry(m.dir, c);
      if (entry) break;
    }
    if (!entry) {
      const prefix = m.dir === "." ? "" : `${m.dir}/`;
      entry = MODULE_EXTS.map((e) => `${prefix}index.${e}`).find((p) => fileSet.has(p)) ?? null;
    }
    pkgs.push({ name: m.raw.name, dir: m.dir, entry, projectRoot: m.projectRoot ?? m.dir, imports: m.raw.imports, exports: m.raw.exports });
  }
  return pkgs.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export interface ScanOptions {
  /** Absolute repo root. */
  cwd: string;
  /** Tracked paths matching any of these are dropped from ALL analysis. */
  ignore?: RegExp[];
  /** Extra module-graph entrypoints, repo-relative. */
  entries?: string[];
  largeCount?: number;
  minDupBytes?: number;
  concurrency?: number;
}

/**
 * The whole scan pipeline as a library call, shared by this CLI and verify.ts
 * (which re-scans after cleanup). Throws on environment errors (not a git
 * repo, nothing to scan) — callers translate that into exit code 2.
 */
export async function runScan(options: ScanOptions): Promise<RepoReport> {
  const cwd = realpathSync(resolve(options.cwd));
  const ignore = options.ignore ?? [];
  const largeCount = options.largeCount ?? 20;
  const minDupBytes = options.minDupBytes ?? 1;
  const concurrency = options.concurrency ?? 8;
  const warnings: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const indexOnly = new Set<string>();
  try {
    const status = execFileSync("git", ["ls-files", "-v", "-z", "--cached"], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    for (const record of status.split("\0")) if (record[0] === "S" || record[0] === "s") indexOnly.add(record.slice(2));
  } catch {
    // listTrackedFiles below reports the repository error; fixture callers may inject a non-Git tree.
  }
  const readFile = (relPath: string): string => {
    if (indexOnly.has(relPath)) return execFileSync("git", ["show", `:${relPath}`], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    try {
      return readFileSync(join(cwd, relPath), "utf8");
    } catch {
      return execFileSync("git", ["show", `:${relPath}`], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    }
  };

  // --- Tracked files --------------------------------------------------------
  const allTracked = await listTrackedFiles(cwd);
  const paths = allTracked.filter((p) => !ignore.some((re) => re.test(p))).sort();
  if (paths.length === 0) {
    throw new Error(
      ignore.length > 0
        ? "no tracked files left after --ignore filters"
        : "no git-tracked files found — is this an empty repository?",
    );
  }
  const files = (await collectFileInfo(cwd, paths, concurrency)).sort((a, b) =>
    a.path < b.path ? -1 : 1,
  );
  if (files.length < paths.length) {
    warnings.push(
      `${paths.length - files.length} tracked file(s) could not be read and were skipped`,
    );
    diagnostics.push({
      code: "inventory.unreadable-tracked-files",
      severity: "error",
      source: "inventory",
      message: `${paths.length - files.length} tracked file(s) could not be read from the worktree or Git index.`,
      affects: ["inventory", "graph", "dependencies"],
      scope: { kind: "repo", path: "." },
    });
  }
  const fileSet = new Set(files.map((f) => f.path));

  // --- Manifests, tsconfig paths, workspace packages ------------------------
  const loaded = loadManifests(cwd, files.map((f) => f.path), readFile);
  const manifests = loaded.manifests;
  warnings.push(...loaded.warnings);
  for (const warning of loaded.warnings) diagnostics.push({ code: "dependencies.manifest-unparseable", severity: "error", source: "dependencies", message: warning, affects: ["dependencies", "workspace"], scope: { kind: "repo", path: "." } });
  const discovered = discoverProjects({ manifests, trackedFiles: paths, readFile });
  diagnostics.push(...discovered.diagnostics, ...discovered.projects.flatMap((project) => project.diagnostics));
  // Per-package alias configs: each manifest dir gets its own tracked
  // tsconfig.json (apps/web/tsconfig.json owns apps/web's "@/*"), the root
  // config covers everything else.
  const rootConfig = fileSet.has("tsconfig.json") ? "tsconfig.json" : fileSet.has("jsconfig.json") ? "jsconfig.json" : null;
  const configDiagnostics = (issues: TsConfigIssue[], scope: string): void => {
    for (const issue of issues) diagnostics.push({
      code: issue.code,
      severity: "error",
      source: "graph",
      message: issue.message,
      affects: ["graph", "dependencies"],
      scope: { kind: scope === "." ? "repo" : "package", path: scope },
    });
  };
  const rootIssues: TsConfigIssue[] = [];
  const rootTsPaths = rootConfig ? loadTsPaths(cwd, rootConfig, rootIssues) : null;
  configDiagnostics(rootIssues, ".");
  const tsPathsByDir = new Map<string, TsPathsConfig | null>([[".", rootTsPaths]]);
  for (const m of manifests) {
    if (m.dir === ".") continue;
    const tsCfg = `${m.dir}/tsconfig.json`;
    const jsCfg = `${m.dir}/jsconfig.json`;
    const cfg = fileSet.has(tsCfg) ? tsCfg : fileSet.has(jsCfg) ? jsCfg : null;
    const issues: TsConfigIssue[] = [];
    const loadedConfig = cfg ? loadTsPaths(cwd, cfg, issues) : rootTsPaths;
    configDiagnostics(issues, m.dir);
    tsPathsByDir.set(m.dir, loadedConfig);
  }
  const workspacePkgs = deriveWorkspacePkgs(manifests, fileSet);

  // --- Module graph ---------------------------------------------------------
  const normalizedEntries = (options.entries ?? [])
    .map((e) => e.replace(/\\/g, "/").replace(/^\.\//, ""))
    .sort();
  for (const e of normalizedEntries) {
    if (!fileSet.has(e)) warnings.push(`--entry ${e} is not a git-tracked file — ignored as a graph root`);
  }
  const extraEntries = normalizedEntries.filter((e) => fileSet.has(e));
  const { graph, importsByFile } = buildModuleGraph({
    cwd,
    files,
    manifests,
    tsPathsByDir,
    workspacePkgs,
    extraEntries,
    readFile,
  });
  diagnostics.push(...graph.health.diagnostics);
  const moduleFileSet = new Set(graph.moduleFiles);
  if (graph.moduleFiles.length > 0 && !graph.entrypoints.some((e) => moduleFileSet.has(e.path))) {
    warnings.push(
      "no module entrypoints discovered — orphan analysis is unreliable; pass --entry <path>",
    );
  }

  // --- Text corpus (dependency text-hits + asset reference search) ----------
  const textFiles: { path: string; content: string; lower: string }[] = [];
  for (const f of files) {
    if (f.bytes > MAX_TEXT_BYTES) continue;
    const known = TEXT_EXTS.has(f.ext);
    if (!known && f.ext !== "") continue;
    try {
      const buf = Buffer.from(readFile(f.path));
      // Extensionless files qualify only when they sniff as text (no NUL).
      if (!known && buf.subarray(0, 512).includes(0)) continue;
      const content = buf.toString("utf8");
      textFiles.push({ path: f.path, content, lower: content.toLowerCase() });
    } catch {
      continue; // vanished mid-scan — already counted by the read-skip warning
    }
  }

  // --- Orphan external-reference evidence -----------------------------------
  // An "orphan" whose repo-relative path is mentioned in some tracked text file
  // (README, CI workflow, Makefile…) or that carries a shebang is run outside
  // the import graph — the planner downgrades it off these fields. Lockfiles
  // and the orphan itself are not evidence.
  for (const orphan of graph.orphans) {
    const refs: string[] = [];
    for (const t of textFiles) {
      if (t.path === orphan.path || LOCKFILE_NAMES.has(basename(t.path))) continue;
      if (!t.content.includes(orphan.path)) continue;
      refs.push(t.path);
      if (refs.length === 3) break;
    }
    orphan.pathReferencedBy = refs; // textFiles iterate path-sorted — refs stay sorted
  }

  // --- Dependencies ---------------------------------------------------------
  const depsAnalysis = analyzeDeps({
    manifests,
    importsByFile,
    resolvedEdges: graph.resolvedEdges,
    textFiles: textFiles
      .filter((t) => {
        const b = basename(t.path);
        return b !== "package.json" && !LOCKFILE_NAMES.has(b);
      })
      .map((t) => ({ path: t.path, content: t.content })),
    workspacePkgNames: new Set(workspacePkgs.map((p) => p.name)),
    projects: discovered.projects,
    orphanFiles: new Set(graph.orphans.map((orphan) => orphan.path)),
    dynamicImporters: new Set(graph.dynamicImporters),
  });
  for (const project of discovered.projects) {
    project.workspaceSkew = depsAnalysis.workspaceSkew.filter((item) => (item.projectRoot ?? ".") === project.rootDir);
  }

  // --- Lockfile -------------------------------------------------------------
  const lock: { kind: string; pm: PackageManager } | null = detectLockfile(cwd, paths);
  let lockfileDuplicates: LockfileDuplicate[] = [];
  for (const project of discovered.projects) {
    const path = project.manager.lockfilePath;
    if (!path) continue;
    const parsed = parseLockfile(posix.basename(path), readFile(path));
    for (const item of parsed.diagnostics) {
      item.scope = { kind: "project", path: project.rootDir };
      diagnostics.push(item);
      warnings.push(item.message);
    }
    const duplicates = findLockfileDuplicates(parsed.versions);
    project.lockfile = { path, dialect: parsed.dialect, parseStatus: parsed.parseStatus, diagnostics: parsed.diagnostics };
    project.lockfileDuplicates = duplicates;
    if (project.rootDir === ".") {
      lockfileDuplicates = duplicates;
    }
  }

  // --- Unreferenced assets --------------------------------------------------
  const unreferencedAssets: AssetFinding[] = [];
  for (const f of files) {
    if (!ASSET_EXTS.has(f.ext)) continue;
    if (f.path.startsWith(".github/")) continue;
    const base = basename(f.path);
    const needle = base.toLowerCase();
    if (WELL_KNOWN_ASSET_PREFIXES.some((p) => needle.startsWith(p))) continue;
    const referenced = textFiles.some((t) => t.path !== f.path && t.lower.includes(needle));
    if (!referenced) {
      unreferencedAssets.push({
        path: f.path,
        bytes: f.bytes,
        reason: `basename "${base}" appears in no tracked text file`,
      });
    }
  }
  unreferencedAssets.sort((a, b) => (a.path < b.path ? -1 : 1));

  // --- Overlapping same-purpose package families ----------------------------
  const declaredByManifest: { dir: string; names: Set<string> }[] = manifests.map(
    (m: PackageManifest) => {
      const names = new Set<string>();
      for (const field of Object.values(m.fields)) for (const n of Object.keys(field)) names.add(n);
      return { dir: m.dir, names };
    },
  );
  const overlaps: OverlapFinding[] = [];
  for (const { dir, names } of declaredByManifest) {
    for (const fam of OVERLAP_FAMILIES) {
      const present = fam.packages.filter((p: string) => names.has(p)).sort();
      if (present.length >= 2) {
        overlaps.push({ family: fam.family, packages: present, packageDir: dir, hint: fam.hint });
      }
    }
  }
  overlaps.sort((a, b) =>
    a.packageDir !== b.packageDir ? (a.packageDir < b.packageDir ? -1 : 1) : a.family < b.family ? -1 : 1,
  );

  // --- Report ---------------------------------------------------------------
  const declaredDeps = declaredByManifest.reduce((s, m) => s + m.names.size, 0);
  const scanOptions = { ignore: ignore.map((re) => re.source), entries: normalizedEntries, largeCount, minDupBytes };
  const source = repositorySnapshot(cwd, files);
  const uniqueDiagnostics = [...new Map(diagnostics.map((item) => [canonicalJson({ code: item.code, source: item.source, scope: item.scope, affects: item.affects, message: item.message }), item])).values()];
  diagnostics.splice(0, diagnostics.length, ...uniqueDiagnostics);
  const lockProjects = discovered.projects.filter((project) => project.lockfile.path !== null);
  const health = {
    inventory: diagnostics.some((item) => item.affects.includes("inventory")) ? "degraded" as const : "complete" as const,
    graph: graph.moduleFiles.length === 0 ? "not-applicable" as const : diagnostics.some((item) => item.affects.includes("graph")) ? "degraded" as const : "complete" as const,
    dependencies: manifests.length === 0 ? "not-applicable" as const : diagnostics.some((item) => item.affects.includes("dependencies")) ? "degraded" as const : "complete" as const,
    workspace: manifests.length === 0 ? "not-applicable" as const : diagnostics.some((item) => item.affects.includes("workspace")) ? "degraded" as const : "complete" as const,
    lockfile: lockProjects.length === 0
      ? "not-applicable" as const
      : lockProjects.every((project) => project.lockfile.parseStatus === "parsed")
        ? "complete" as const
        : "degraded" as const,
  };
  const rootProject = discovered.projects.find((project) => project.rootDir === ".");
  return {
    version: 2,
    tool: "repo-doctor",
    toolVersion: TOOL_VERSION,
    createdAt: new Date().toISOString(),
    cwd,
    source,
    scanOptions,
    scanOptionsDigest: sha256(canonicalJson(scanOptions)),
    health,
    diagnostics,
    projects: discovered.projects,
    packageManager: rootProject?.manager.status === "resolved" ? rootProject.manager.name : null,
    lockfileKind: rootProject?.lockfile.path ?? lock?.kind ?? null,
    totals: {
      trackedFiles: files.length,
      trackedBytes: files.reduce((s, f) => s + f.bytes, 0),
      moduleFiles: graph.moduleFiles.length,
      packages: manifests.length,
      declaredDeps,
    },
    files,
    duplicateGroups: findDuplicates(files, minDupBytes),
    graph,
    unreferencedAssets,
    packages: depsAnalysis.packages,
    workspaceSkew: depsAnalysis.workspaceSkew,
    lockfileDuplicates,
    overlaps,
    junk: findJunk(files),
    largeFiles: largestFiles(files, largeCount),
    warnings,
  };
}

export async function scanMain(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cwd: { type: "string", default: "." },
      out: { type: "string", default: ".repo-doctor/report.json" },
      ignore: { type: "string", multiple: true, default: [] },
      entry: { type: "string", multiple: true, default: [] },
      "large-count": { type: "string", default: "20" },
      "min-dup-bytes": { type: "string", default: "1" },
      concurrency: { type: "string", default: "8" },
      "allow-output-outside-cwd": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const requestedCwd = resolve(values.cwd!);
  if (!existsSync(requestedCwd)) fail(`--cwd does not exist: ${requestedCwd}`);
  const cwd = realpathSync(requestedCwd);
  let outPath: string;
  try {
    outPath = resolveSafePath(values.out!, { cwd, allowOutside: values["allow-output-outside-cwd"]!, rejectTracked: true });
  } catch (error) {
    return fail((error as Error).message);
  }
  const ignore = (values.ignore ?? []).map((p) => {
    try {
      return new RegExp(p);
    } catch {
      return fail(`invalid --ignore regex: ${p}`);
    }
  });
  const largeCount = Number(values["large-count"]);
  const minDupBytes = Number(values["min-dup-bytes"]);
  const concurrency = Number(values.concurrency);
  if (!Number.isSafeInteger(largeCount) || largeCount < 0) fail("--large-count must be a non-negative safe integer");
  if (!Number.isSafeInteger(minDupBytes) || minDupBytes < 0) fail("--min-dup-bytes must be a non-negative safe integer");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) fail("--concurrency must be a positive safe integer");

  let report: RepoReport;
  try {
    report = await runScan({
      cwd,
      ignore,
      entries: values.entry ?? [],
      largeCount,
      minDupBytes,
      concurrency,
    });
  } catch (err) {
    return fail((err as Error).message);
  }
  const outFile = writeArtifactAtomic(outPath, `${JSON.stringify(report, null, 2)}\n`, {
    cwd,
    allowOutside: values["allow-output-outside-cwd"]!,
    rejectTracked: true,
  });

  const t = report.totals;
  const unused = report.packages.reduce((s, p) => s + p.unused.length, 0);
  console.error(`report written: ${outFile}`);
  console.error(
    `${t.trackedFiles} tracked files (${(t.trackedBytes / (1024 * 1024)).toFixed(1)} MB), ` +
      `${t.packages} package(s) — ${report.graph.orphans.length} orphan module(s), ` +
      `${report.junk.length} junk file(s), ${unused} unused dep(s)`,
  );
  for (const w of report.warnings) console.error(`⚠️  ${w}`);
  console.error(`\nnext: node \"$REPO_DOCTOR_ROOT/bin/repo-doctor-plan.mjs\" --cwd ${JSON.stringify(cwd)} --report ${JSON.stringify(relative(cwd, outFile))}`);
}
