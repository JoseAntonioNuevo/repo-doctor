import { builtinModules } from "node:module";
import { BIN_TO_PACKAGE } from "./catalogs.ts";
import type {
  DepField,
  DepUsage,
  MissingDep,
  PackageManifest,
  PackageReport,
  WorkspaceSkew,
} from "./types.ts";

const DEP_FIELDS: DepField[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const BUILTINS = new Set(builtinModules);

/** Cap on recorded text-hit file paths per dependency — evidence, not a census. */
const TEXT_HIT_CAP = 5;

function isBuiltinModule(spec: string): boolean {
  return spec.startsWith("node:") || BUILTINS.has(spec);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Parse every tracked package.json outside node_modules.
 *
 * Unparseable manifests are skipped with a warning instead of aborting — one
 * broken fixture must not hide the rest of the repo. `readFile` takes a
 * repo-relative path and is injected so tests can run against an in-memory
 * tree; `cwd` is part of the shared scan call shape and unused here.
 */
export function loadManifests(
  cwd: string,
  trackedFiles: string[],
  readFile: (p: string) => string,
): { manifests: PackageManifest[]; warnings: string[] } {
  const manifests: PackageManifest[] = [];
  const warnings: string[] = [];
  const candidates = trackedFiles
    .filter(
      (p) =>
        (p === "package.json" || p.endsWith("/package.json")) &&
        !p.split("/").includes("node_modules"),
    )
    .sort();
  for (const path of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFile(path));
    } catch (err) {
      warnings.push(`Skipped unparseable ${path}: ${(err as Error).message}`);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      warnings.push(`Skipped ${path}: not a JSON object`);
      continue;
    }
    const raw = parsed as Record<string, unknown>;
    const dir = path === "package.json" ? "." : path.slice(0, -"/package.json".length);
    const fields = {} as Record<DepField, Record<string, string>>;
    for (const field of DEP_FIELDS) {
      const value = raw[field];
      const ranges: Record<string, string> = {};
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        for (const [name, range] of Object.entries(value as Record<string, unknown>)) {
          if (typeof range === "string") ranges[name] = range;
        }
      }
      fields[field] = ranges;
    }
    const name = typeof raw["name"] === "string" && raw["name"] !== "" ? (raw["name"] as string) : dir;
    manifests.push({ dir, name, raw, fields });
  }
  manifests.sort((a, b) => cmp(a.dir, b.dir)); // "." first — dir order, not manifest-path order
  return { manifests, warnings };
}

/**
 * Map an import specifier to the npm package that would provide it.
 * "@scope/name/sub" -> "@scope/name", "lodash/fp" -> "lodash"; relative
 * paths and Node builtins return null — those are the module graph's job.
 */
export function specifierToPackage(spec: string): string | null {
  if (spec === "" || spec.startsWith(".") || spec.startsWith("/")) return null;
  if (isBuiltinModule(spec)) return null;
  const segments = spec.split("/");
  const name = spec.startsWith("@")
    ? segments.length >= 2 && segments[1] !== ""
      ? `${segments[0]}/${segments[1]}`
      : null
    : segments[0];
  // Protocol-ish specifiers (data:, https:, virtual:…) are never npm names.
  if (name === null || name.includes(":")) return null;
  return name;
}

export interface DepsInput {
  manifests: PackageManifest[];
  /** Module file -> raw import specifiers, from the module graph. */
  importsByFile: Map<string, string[]>;
  /** All tracked text files EXCEPT package.json manifests and lockfiles. */
  textFiles: { path: string; content: string }[];
  workspacePkgNames: Set<string>;
}

/**
 * Classify every declared dependency of every manifest as used, unused,
 * missing, dual-declared, or version-skewed.
 *
 * Usage evidence, in decreasing strength: an import from the manifest's own
 * files, a whole-word mention in any tracked text file, or an implicit-use
 * rule (@types pairing, bin catalog, config shorthand, JSX runtime,
 * workspace links).
 * "Unused" means none of the three — the planner still treats runtime
 * dependencies more cautiously than dev ones.
 */
export function analyzeDeps(input: DepsInput): {
  packages: PackageReport[];
  workspaceSkew: WorkspaceSkew[];
} {
  const manifests = [...input.manifests].sort((a, b) => cmp(a.dir, b.dir));
  const textFiles = [...input.textFiles].sort((a, b) => cmp(a.path, b.path));

  // A module file belongs to the manifest whose dir is its longest path prefix.
  const importsByManifest = new Map<string, Map<string, Set<string>>>();
  // Manifest dirs owning at least one .jsx/.tsx module: the automatic JSX
  // runtime imports react invisibly, so "react" counts as used there even when
  // no file spells out the import.
  const jsxDirs = new Set<string>();
  for (const [file, specs] of input.importsByFile) {
    const owner = owningManifest(manifests, file);
    if (owner === null) continue;
    if (file.endsWith(".jsx") || file.endsWith(".tsx")) jsxDirs.add(owner.dir);
    let byPackage = importsByManifest.get(owner.dir);
    if (byPackage === undefined) {
      byPackage = new Map();
      importsByManifest.set(owner.dir, byPackage);
    }
    for (const spec of specs) {
      const pkg = specifierToPackage(spec);
      if (pkg === null) continue;
      let files = byPackage.get(pkg);
      if (files === undefined) {
        files = new Set();
        byPackage.set(pkg, files);
      }
      files.add(file);
    }
  }

  // Word-boundary search over every text file is the expensive part — cache per name.
  const textHitCache = new Map<string, string[]>();
  const textHitsFor = (name: string): string[] => {
    const cached = textHitCache.get(name);
    if (cached !== undefined) return cached;
    const re = wordRegex(name);
    const hits: string[] = [];
    for (const file of textFiles) {
      if (re.test(file.content)) {
        hits.push(file.path);
        if (hits.length === TEXT_HIT_CAP) break;
      }
    }
    textHitCache.set(name, hits);
    return hits;
  };

  const scriptsText = manifests.map(scriptsOf).join("\n");
  const eslintConfigs = textFiles.filter((f) => isConfig(f.path, ".eslintrc", "eslint.config."));
  const babelConfigs = textFiles.filter((f) => isConfig(f.path, ".babelrc", "babel.config."));
  const hasPrettierConfig = textFiles.some((f) => isConfig(f.path, ".prettierrc", "prettier.config."));

  const binsByPackage = new Map<string, string[]>();
  for (const [bin, pkg] of Object.entries(BIN_TO_PACKAGE)) {
    binsByPackage.set(pkg, [...(binsByPackage.get(pkg) ?? []), bin]);
  }

  const byDir = new Map(manifests.map((m) => [m.dir, m]));
  const packages: PackageReport[] = [];

  for (const manifest of manifests) {
    const imported = importsByManifest.get(manifest.dir) ?? new Map<string, Set<string>>();
    const declared = new Set<string>();
    for (const field of DEP_FIELDS) {
      for (const name of Object.keys(manifest.fields[field])) declared.add(name);
    }

    // Direct evidence first — the @types rule consults it for the base package.
    const directlyUsed = new Set<string>();
    for (const name of declared) {
      if ((imported.get(name)?.size ?? 0) > 0 || textHitsFor(name).length > 0) {
        directlyUsed.add(name);
      }
    }

    const implicitReasonFor = (name: string, range: string): string | null => {
      if (name === "react" && jsxDirs.has(manifest.dir)) return "JSX runtime";
      const typesBase = typesBaseOf(name);
      if (typesBase !== null) {
        if (typesBase === "node") return "types for the Node.js runtime";
        if (isBuiltinModule(typesBase)) return `types for Node.js builtin "${typesBase}"`;
        if (imported.has(typesBase) || directlyUsed.has(typesBase)) {
          return `types for used package ${typesBase}`;
        }
      }
      for (const bin of binsByPackage.get(name) ?? []) {
        if (wordRegex(bin).test(scriptsText)) return `bin "${bin}" appears in package.json scripts`;
      }
      const eslintToken = shorthandToken(name, "eslint-config");
      if (eslintToken !== null) {
        const config = eslintConfigs.find((f) => wordRegex(eslintToken).test(f.content));
        if (config !== undefined) return `eslint config ${config.path} references "${eslintToken}"`;
      }
      const babelToken = shorthandToken(name, "babel-preset");
      if (babelToken !== null) {
        const config = babelConfigs.find((f) => wordRegex(babelToken).test(f.content));
        if (config !== undefined) return `babel config ${config.path} references "${babelToken}"`;
      }
      if (name.startsWith("prettier-plugin-") && hasPrettierConfig) {
        return "prettier plugin and a prettier config is present";
      }
      if (range.startsWith("workspace:") || input.workspacePkgNames.has(name)) {
        return "workspace package";
      }
      return null;
    };

    const deps: DepUsage[] = [];
    for (const field of DEP_FIELDS) {
      for (const [name, range] of Object.entries(manifest.fields[field])) {
        deps.push({
          name,
          field,
          range,
          usedBy: [...(imported.get(name) ?? [])].sort(),
          textHits: [...textHitsFor(name)],
          implicitReason: implicitReasonFor(name, range),
        });
      }
    }
    deps.sort((a, b) => cmp(a.name, b.name) || DEP_FIELDS.indexOf(a.field) - DEP_FIELDS.indexOf(b.field));

    const used = new Set<string>();
    for (const d of deps) {
      if (d.usedBy.length > 0 || d.textHits.length > 0 || d.implicitReason !== null) used.add(d.name);
    }
    const unused = [...declared].filter((name) => !used.has(name)).sort();

    const dualDeclared = Object.keys(manifest.fields.dependencies)
      .filter((name) => name in manifest.fields.devDependencies)
      .sort();

    const missing: MissingDep[] = [];
    for (const [pkg, importers] of imported) {
      if (declared.has(pkg) || input.workspacePkgNames.has(pkg)) continue;
      missing.push({
        name: pkg,
        importers: [...importers].sort(),
        declaredIn: nearestDeclaringAncestor(byDir, manifest.dir, pkg),
      });
    }
    missing.sort((a, b) => cmp(a.name, b.name));

    packages.push({ dir: manifest.dir, name: manifest.name, deps, unused, missing, dualDeclared });
  }

  return { packages, workspaceSkew: findWorkspaceSkew(manifests) };
}

function owningManifest(manifests: PackageManifest[], file: string): PackageManifest | null {
  const prefixLen = (dir: string): number => (dir === "." ? 0 : dir.length);
  let best: PackageManifest | null = null;
  for (const m of manifests) {
    if (m.dir !== "." && !file.startsWith(`${m.dir}/`)) continue;
    if (best === null || prefixLen(m.dir) > prefixLen(best.dir)) best = m;
  }
  return best;
}

function scriptsOf(manifest: PackageManifest): string {
  const scripts = manifest.raw["scripts"];
  if (typeof scripts !== "object" || scripts === null) return "";
  return Object.values(scripts)
    .filter((v): v is string => typeof v === "string")
    .join("\n");
}

function isConfig(path: string, dotPrefix: string, filePrefix: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.startsWith(dotPrefix) || base.startsWith(filePrefix);
}

/** "@types/foo" -> "foo"; "@types/babel__core" -> "@babel/core" (DefinitelyTyped scope mangling). */
function typesBaseOf(name: string): string | null {
  if (!name.startsWith("@types/")) return null;
  const base = name.slice("@types/".length);
  const mangled = base.indexOf("__");
  if (mangled === -1) return base;
  return `@${base.slice(0, mangled)}/${base.slice(mangled + 2)}`;
}

/** "eslint-config-airbnb" -> "airbnb"; "@acme/eslint-config" -> "@acme" (the shorthand the tool resolves). */
function shorthandToken(name: string, kind: "eslint-config" | "babel-preset"): string | null {
  if (name.startsWith(`${kind}-`)) return name.slice(kind.length + 1);
  const scoped = /^(@[^/]+)\/(.+)$/.exec(name);
  if (scoped !== null && scoped[2] === kind) return scoped[1];
  return null;
}

function nearestDeclaringAncestor(
  byDir: Map<string, PackageManifest>,
  fromDir: string,
  pkg: string,
): string | null {
  let dir = fromDir;
  while (dir !== ".") {
    const cut = dir.lastIndexOf("/");
    dir = cut === -1 ? "." : dir.slice(0, cut);
    const ancestor = byDir.get(dir);
    if (ancestor !== undefined && DEP_FIELDS.some((field) => pkg in ancestor.fields[field])) {
      return ancestor.dir;
    }
  }
  return null;
}

function findWorkspaceSkew(manifests: PackageManifest[]): WorkspaceSkew[] {
  // One range per (manifest, name): the first declaring field wins, in DEP_FIELDS order.
  const rangesByName = new Map<string, Record<string, string>>();
  for (const manifest of manifests) {
    const seen = new Set<string>();
    for (const field of DEP_FIELDS) {
      for (const [name, range] of Object.entries(manifest.fields[field])) {
        if (seen.has(name)) continue;
        seen.add(name);
        const ranges = rangesByName.get(name) ?? {};
        ranges[manifest.dir] = range;
        rangesByName.set(name, ranges);
      }
    }
  }
  return [...rangesByName.entries()]
    .filter(([, ranges]) => new Set(Object.values(ranges)).size >= 2)
    .map(([name, ranges]) => ({ name, ranges }))
    .sort((a, b) => cmp(a.name, b.name));
}

/**
 * Whole-word matcher for package and bin names. `\b` cannot anchor before "@"
 * or other non-word characters, so scoped names get explicit lookarounds —
 * a literal `\b@scope/name\b` would never match after a quote or space.
 *
 * Hyphens are word-ish inside package names but `\b` treats them as
 * boundaries, so the tail also rejects an immediately following `-word`:
 * "lodash" must not match inside "lodash-es" (the stale-sibling case), while
 * subpaths like "lodash/fp" remain valid hits.
 */
function wordRegex(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lead = /^\w/.test(token) ? "\\b" : "(?<![\\w@])";
  const tail = /\w$/.test(token) ? "\\b(?!-\\w)" : "(?![\\w@])";
  return new RegExp(`${lead}${escaped}${tail}`);
}
