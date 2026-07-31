import { posix } from "node:path";
import type {
  EntryPoint,
  FileInfo,
  ModuleGraph,
  OrphanModule,
  PackageManifest,
  UnresolvedImport,
} from "./types.ts";
import { extractImports, isModuleFile } from "./imports.ts";
import { resolveSpecifier } from "./resolve.ts";
import type { TsPathsConfig, WorkspacePkg } from "./resolve.ts";

/**
 * Module graph: entrypoint discovery, internal import edges, and BFS
 * reachability over the tracked file set.
 *
 * Entrypoints are everything a build tool, framework, test runner, or human
 * plausibly executes directly — package.json fields, framework routes, config
 * files, tests, HTML pages… Any module file BFS cannot reach from that set is
 * an orphan candidate. File contents arrive through the injected `readFile`,
 * so the whole graph runs against a purely in-memory repo in tests. All paths
 * are repo-root-relative posix.
 */

export interface GraphInput {
  cwd: string;
  files: FileInfo[];
  /** Every tracked package.json, parsed (see deps.ts). */
  manifests: PackageManifest[];
  /**
   * tsconfig alias config per manifest dir ("." for the repo root). Each
   * importing file resolves with the config of its OWNING manifest — the
   * longest-prefix dir — so per-package "@/*" aliases never leak across
   * workspace packages. Missing dirs fall back to the "." entry.
   */
  tsPathsByDir: Map<string, TsPathsConfig | null>;
  workspacePkgs: WorkspacePkg[];
  /** Extra entrypoints from --entry flags, repo-relative. */
  extraEntries: string[];
  /** Injected for testability — the graph never touches the filesystem itself. */
  readFile(relPath: string): string;
}

/** SFC sources — their script blocks import like any JS/TS module. */
const SFC_RE = /\.(?:vue|svelte|astro)$/i;

/** Module files for graph purposes: JS/TS modules plus vue/svelte/astro SFCs. */
function isGraphModuleFile(path: string): boolean {
  return isModuleFile(path) || SFC_RE.test(path);
}

/**
 * Build the import graph and reachability report.
 *
 * `importsByFile` maps every module file (reachable or not) to its raw,
 * sorted specifier list — deps.ts turns those into package names later.
 * `unresolved` is restricted to reachable files: a dead file full of broken
 * imports is already reported as an orphan, and its noise would drown the
 * real signal.
 */
export function buildModuleGraph(input: GraphInput): {
  graph: ModuleGraph;
  importsByFile: Map<string, string[]>;
} {
  const fileSet = new Set<string>();
  const bytesOf = new Map<string, number>();
  for (const f of input.files) {
    fileSet.add(f.path);
    bytesOf.set(f.path, f.bytes);
  }
  const moduleFiles = input.files.map((f) => f.path).filter(isGraphModuleFile).sort();
  const htmlFiles = input.files
    .filter((f) => f.ext === "html" || f.ext === "htm")
    .map((f) => f.path)
    .sort();

  // A file that vanished between the inventory pass and this read parses as
  // empty — one racy file must not kill the scan.
  const readSource = (path: string): string => {
    try {
      return input.readFile(path);
    } catch {
      return "";
    }
  };

  // Each file resolves aliases with the tsconfig of its owning manifest —
  // the longest-prefix dir — with "." as the repo-wide fallback.
  const tsDirs = [...input.tsPathsByDir.keys()]
    .filter((d) => d !== ".")
    .sort((a, b) => b.length - a.length || cmp(a, b));
  const tsPathsFor = (path: string): TsPathsConfig | null => {
    for (const dir of tsDirs) {
      if (path.startsWith(`${dir}/`)) return input.tsPathsByDir.get(dir) ?? null;
    }
    return input.tsPathsByDir.get(".") ?? null;
  };

  // Parse every module file exactly once, reachable or not: orphan clusters
  // and dynamic-importer flags need edges from unreached files too.
  const edges = new Map<string, string[]>();
  const importsByFile = new Map<string, string[]>();
  const unresolvedByFile = new Map<string, string[]>();
  const dynamicImporters: string[] = [];
  const shebangFiles = new Set<string>();
  for (const path of moduleFiles) {
    const source = readSource(path);
    if (source.startsWith("#!")) shebangFiles.add(path);
    const { specifiers, hasDynamicNonLiteral } = extractImports(source);
    importsByFile.set(path, specifiers);
    if (hasDynamicNonLiteral) dynamicImporters.push(path);
    const internal = new Set<string>();
    const unresolved: string[] = [];
    const tsPaths = tsPathsFor(path);
    for (const spec of specifiers) {
      const res = resolveSpecifier(path, spec, fileSet, tsPaths, input.workspacePkgs);
      if (res.kind === "internal") internal.add(res.path);
      else if (res.kind === "unresolved") unresolved.push(spec);
    }
    edges.set(path, [...internal].sort());
    unresolvedByFile.set(path, unresolved);
  }
  for (const path of htmlFiles) edges.set(path, htmlEdges(path, readSource(path), fileSet));

  const entrypoints = collectEntrypoints(input, moduleFiles, htmlFiles, fileSet);

  // BFS over internal edges; entrypoints count as reachable themselves.
  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const e of entrypoints) {
    if (!reachable.has(e.path)) {
      reachable.add(e.path);
      queue.push(e.path);
    }
  }
  for (let i = 0; i < queue.length; i += 1) {
    for (const target of edges.get(queue[i]) ?? []) {
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }

  // Orphans, annotated with which OTHER orphans import them — a cluster that
  // only references itself dies together.
  const orphanSet = new Set(moduleFiles.filter((p) => !reachable.has(p)));
  const importersOf = new Map<string, Set<string>>();
  for (const orphan of orphanSet) {
    for (const target of edges.get(orphan) ?? []) {
      if (target === orphan || !orphanSet.has(target)) continue;
      let set = importersOf.get(target);
      if (!set) importersOf.set(target, (set = new Set()));
      set.add(orphan);
    }
  }
  const orphans: OrphanModule[] = [...orphanSet].sort().map((path) => ({
    path,
    bytes: bytesOf.get(path) ?? 0,
    importers: [...(importersOf.get(path) ?? [])].sort(),
    // The graph has no text corpus — scan.ts fills this from tracked text files.
    pathReferencedBy: [],
    hasShebang: shebangFiles.has(path),
  }));

  const unresolved: UnresolvedImport[] = [];
  for (const path of moduleFiles) {
    if (!reachable.has(path)) continue; // orphan noise stays out of the report
    for (const spec of unresolvedByFile.get(path) ?? []) {
      unresolved.push({ from: path, specifier: spec });
    }
  }
  unresolved.sort(
    (a, b) => cmp(a.from, b.from) || cmp(a.specifier, b.specifier),
  );

  return {
    graph: { moduleFiles, entrypoints, orphans, unresolved, dynamicImporters },
    importsByFile,
  };
}

/** Conventional route directories, checked as prefixes relative to a manifest dir. */
const ROUTE_PREFIXES = ["app/", "pages/", "routes/", "src/app/", "src/pages/", "src/routes/"];
const MIDDLEWARE_RE = /^(?:src\/)?(?:middleware|instrumentation)\.[^/]+$/;
const CONVENTIONAL_ROOT_RE = /^(?:(?:index|server)|src\/(?:index|main|server))\.[^/]+$/;
const CONFIG_RE = /\.config\.[cm]?[jt]s$/;
const RC_RE = /^\.?\w+rc\.[cm]?[jt]s$/;
const TEST_BASENAME_RE = /\.(?:test|spec)\./;
const TEST_SEGMENTS = new Set(["__tests__", "tests", "test", "e2e", "cypress", "playwright"]);
const STORY_BASENAME_RE = /\.stories\./;
const OPS_PREFIXES = ["scripts/", "tools/", "bin/"];
const OPS_SEGMENTS = new Set(["migrations", "prisma", "supabase", "drizzle", "seeds"]);

/**
 * Discover entrypoints, one per path: conventions are checked in fixed
 * priority order (package.json fields first, --entry last) and the first
 * matching reason wins, so the report never flip-flops between reasons.
 */
function collectEntrypoints(
  input: GraphInput,
  moduleFiles: string[],
  htmlFiles: string[],
  fileSet: Set<string>,
): EntryPoint[] {
  const reasons = new Map<string, string>();
  const add = (path: string, reason: string): void => {
    if (!reasons.has(path)) reasons.set(path, reason);
  };
  const manifests = [...input.manifests].sort((a, b) => cmp(a.dir, b.dir));

  // 1. package.json fields — a reference that resolves to a tracked file is
  // an executed root by definition.
  for (const m of manifests) {
    for (const { field, ref } of manifestRefs(m)) {
      const hit = ref.length === 0 ? null : resolveFileRef(m.dir, ref, fileSet);
      if (hit !== null) add(hit, `package.json ${field}`);
    }
  }

  // 2. Framework routes + special roots, relative to each manifest dir —
  // frameworks load these by filename, never by import.
  for (const path of moduleFiles) {
    for (const m of manifests) {
      const rel = relUnder(m.dir, path);
      if (rel === null) continue;
      if (ROUTE_PREFIXES.some((p) => rel.startsWith(p))) add(path, "framework route file");
      else if (MIDDLEWARE_RE.test(rel)) add(path, "framework middleware/instrumentation");
    }
  }

  // 3. Conventional roots per manifest dir.
  for (const path of moduleFiles) {
    for (const m of manifests) {
      const rel = relUnder(m.dir, path);
      if (rel !== null && CONVENTIONAL_ROOT_RE.test(rel)) add(path, "conventional root file");
    }
  }

  // 4–8. Basename/segment conventions: tools discover these files themselves,
  // so nothing imports them and reachability alone would call them dead.
  for (const path of moduleFiles) {
    const base = basenameOf(path);
    if (CONFIG_RE.test(base) || RC_RE.test(base)) add(path, "config file");
  }
  for (const path of moduleFiles) {
    if (TEST_BASENAME_RE.test(basenameOf(path)) || dirSegmentsOf(path).some((s) => TEST_SEGMENTS.has(s))) {
      add(path, "test file");
    }
  }
  for (const path of moduleFiles) {
    if (STORY_BASENAME_RE.test(basenameOf(path)) || dirSegmentsOf(path).includes(".storybook")) {
      add(path, "storybook file");
    }
  }
  for (const path of moduleFiles) if (path.endsWith(".d.ts")) add(path, "type declaration file");
  for (const path of moduleFiles) {
    if (OPS_PREFIXES.some((p) => path.startsWith(p)) || dirSegmentsOf(path).some((s) => OPS_SEGMENTS.has(s))) {
      add(path, "ops/tooling directory");
    }
  }

  // 9. Every HTML page is a root; its script/link edges are built separately.
  for (const path of htmlFiles) add(path, "html file");

  // 10. User-forced entries, verbatim — the escape hatch for anything the
  // conventions miss (reason string is pinned by the plan tooling).
  for (const entry of input.extraEntries) add(posix.normalize(entry), "user-provided --entry");

  return [...reasons.entries()]
    .map(([path, reason]) => ({ path, reason }))
    .sort((a, b) => cmp(a.path, b.path));
}

/** File-looking tokens inside package.json scripts values, e.g. `tsx scripts/scan.ts`. */
const SCRIPT_FILE_RE = /[\w./-]+\.(?:c|m)?[jt]sx?\b/g;

/**
 * Entry-file references declared by one manifest, in field priority order:
 * main, module, types, browser, bin, exports (every string leaf), scripts.
 */
function manifestRefs(m: PackageManifest): { field: string; ref: string }[] {
  const out: { field: string; ref: string }[] = [];
  for (const field of ["main", "module", "types"]) {
    const value = m.raw[field];
    if (typeof value === "string") out.push({ field, ref: value });
  }
  for (const field of ["browser", "bin"]) {
    const value = m.raw[field];
    if (typeof value === "string") out.push({ field, ref: value });
    else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record).sort()) {
        if (typeof record[key] === "string") out.push({ field, ref: record[key] as string });
      }
    }
  }
  for (const ref of stringLeaves(m.raw["exports"])) out.push({ field: "exports", ref });
  const scripts = m.raw["scripts"];
  if (typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)) {
    const record = scripts as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      const value = record[key];
      if (typeof value !== "string") continue;
      for (const match of value.matchAll(SCRIPT_FILE_RE)) out.push({ field: "scripts", ref: match[0] });
    }
  }
  return out;
}

/** Every string leaf of a package.json `exports` value, conditions and arrays included. */
function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.keys(record).sort().flatMap((key) => stringLeaves(record[key]));
  }
  return [];
}

const HTML_REF_RE = /\b(?:src|href)\s*=\s*(["'])([^"']+)\1/gi;

/**
 * src/href attribute values in an HTML entrypoint that land on tracked module
 * files (Vite-style `<script type="module" src="/src/main.tsx">`). A leading
 * `/` means the serve root — the repo root here — everything else resolves
 * relative to the page. External URLs and non-module hits (css, images,
 * other pages) are not edges.
 */
function htmlEdges(htmlPath: string, source: string, fileSet: Set<string>): string[] {
  const out = new Set<string>();
  HTML_REF_RE.lastIndex = 0;
  for (let m = HTML_REF_RE.exec(source); m !== null; m = HTML_REF_RE.exec(source)) {
    const ref = m[2].split(/[?#]/)[0].trim(); // dev servers version-tag with ?v=…
    if (ref.length === 0 || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) continue;
    const hit = ref.startsWith("/")
      ? resolveFileRef(".", ref.replace(/^\/+/, ""), fileSet)
      : resolveFileRef(posix.dirname(htmlPath), ref, fileSet);
    if (hit !== null && isGraphModuleFile(hit)) out.add(hit);
  }
  return [...out].sort();
}

/**
 * Resolve a bare file reference (manifest field, scripts token, html
 * attribute) from a directory, reusing the relative-specifier machinery so
 * `./src/index.js` still finds `src/index.ts` and `./lib` finds its index.
 */
function resolveFileRef(fromDir: string, ref: string, fileSet: Set<string>): string | null {
  const spec = ref.startsWith("./") || ref.startsWith("../") ? ref : `./${ref}`;
  const res = resolveSpecifier(posix.join(fromDir, "package.json"), spec, fileSet, null, []);
  return res.kind === "internal" ? res.path : null;
}

/** Path of `path` relative to manifest dir `dir`, or null when outside it. */
function relUnder(dir: string, path: string): string | null {
  if (dir === "." || dir === "") return path;
  return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null;
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Directory segments of a repo-relative path (the basename excluded). */
function dirSegmentsOf(path: string): string[] {
  return path.split("/").slice(0, -1);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
