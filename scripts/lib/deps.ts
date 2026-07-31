import { builtinModules } from "node:module";
import { BIN_TO_PACKAGE } from "./catalogs.ts";
import type {
  DepField,
  DepUsage,
  MissingDep,
  PackageManifest,
  PackageReport,
  ProjectReport,
  ResolvedImportEdge,
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
  /** Authoritative graph-resolved edges. Raw specifiers are only a legacy test fallback. */
  resolvedEdges?: ResolvedImportEdge[];
  /** All tracked text files EXCEPT package.json manifests and lockfiles. */
  textFiles: { path: string; content: string }[];
  workspacePkgNames: Set<string>;
  projects?: ProjectReport[];
  orphanFiles?: Set<string>;
  dynamicImporters?: Set<string>;
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
  const authoritative = input.resolvedEdges !== undefined;
  const edgeImports = new Map<string, { name: string; context: ResolvedImportEdge["context"] }[]>();
  const workspaceImports = new Map<string, Set<string>>();
  for (const edge of input.resolvedEdges ?? []) {
    if ((edge.target !== "external-package" && edge.target !== "workspace-package") || edge.packageName === null) continue;
    edgeImports.set(edge.from, [...(edgeImports.get(edge.from) ?? []), { name: edge.packageName, context: edge.context }]);
    if (edge.target === "workspace-package") {
      const owner = owningManifest(manifests, edge.from);
      if (owner) workspaceImports.set(owner.dir, new Set([...(workspaceImports.get(owner.dir) ?? []), edge.packageName]));
    }
  }
  const importEntries = authoritative
    ? [...edgeImports.entries()].map(([file, values]) => [file, values.map((value) => value.name)] as const)
    : [...input.importsByFile.entries()];
  for (const [file, specs] of importEntries) {
    const owner = owningManifest(manifests, file);
    if (owner === null) continue;
    if (file.endsWith(".jsx") || file.endsWith(".tsx")) jsxDirs.add(owner.dir);
    let byPackage = importsByManifest.get(owner.dir);
    if (byPackage === undefined) {
      byPackage = new Map();
      importsByManifest.set(owner.dir, byPackage);
    }
    for (const spec of specs) {
      const pkg = authoritative ? spec : specifierToPackage(spec);
      if (pkg === null) continue;
      let files = byPackage.get(pkg);
      if (files === undefined) {
        files = new Set();
        byPackage.set(pkg, files);
      }
      files.add(file);
    }
  }

  // Text evidence is package-owned. Source modules are excluded because their
  // imports already came through resolved graph edges.
  const modulePaths = new Set(input.importsByFile.keys());
  const textHitCache = new Map<string, string[]>();
  const textHitsFor = (manifest: PackageManifest, name: string): string[] => {
    const cacheKey = `${manifest.dir}\0${name}`;
    const cached = textHitCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const re = wordRegex(name);
    const hits: string[] = [];
    for (const file of textFiles) {
      if (modulePaths.has(file.path)) continue;
      if (owningManifest(manifests, file.path)?.dir !== manifest.dir) continue;
      if (re.test(file.content)) {
        hits.push(file.path);
        if (hits.length === TEXT_HIT_CAP) break;
      }
    }
    textHitCache.set(cacheKey, hits);
    return hits;
  };

  const binsByPackage = new Map<string, string[]>();
  for (const [bin, pkg] of Object.entries(BIN_TO_PACKAGE)) {
    binsByPackage.set(pkg, [...(binsByPackage.get(pkg) ?? []), bin]);
  }

  const byDir = new Map(manifests.map((m) => [m.dir, m]));
  const packages: PackageReport[] = [];

  for (const manifest of manifests) {
    const ownedText = textFiles.filter((file) => owningManifest(manifests, file.path)?.dir === manifest.dir);
    const embeddedConfig = (key: string): { path: string; content: string }[] => {
      if (!Object.hasOwn(manifest.raw, key)) return [];
      return [{ path: `${manifest.dir === "." ? "" : `${manifest.dir}/`}package.json#${key}`, content: JSON.stringify(manifest.raw[key]) }];
    };
    const scriptsText = scriptsOf(manifest);
    const eslintConfigs = [...ownedText.filter((f) => isConfig(f.path, ".eslintrc", "eslint.config.")), ...embeddedConfig("eslintConfig")];
    const babelConfigs = [...ownedText.filter((f) => isConfig(f.path, ".babelrc", "babel.config.")), ...embeddedConfig("babel")];
    const prettierConfigs = [...ownedText.filter((f) => isConfig(f.path, ".prettierrc", "prettier.config.")), ...embeddedConfig("prettier")];
    const postcssConfigs = [...ownedText.filter((f) => isConfig(f.path, ".postcssrc", "postcss.config.")), ...embeddedConfig("postcss")];
    const jestConfigs = [...ownedText.filter((f) => isConfig(f.path, ".jestrc", "jest.config.")), ...embeddedConfig("jest")];
    const imported = importsByManifest.get(manifest.dir) ?? new Map<string, Set<string>>();
    const declared = new Set<string>();
    for (const field of DEP_FIELDS) {
      for (const name of Object.keys(manifest.fields[field])) declared.add(name);
    }

    // Direct evidence first — the @types rule consults it for the base package.
    const directlyUsed = new Set<string>();
    for (const name of declared) {
      if ((imported.get(name)?.size ?? 0) > 0 || textHitsFor(manifest, name).length > 0) {
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
      const genericBins = [name, name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name];
      const scriptBin = genericBins.find((bin) => wordRegex(bin).test(scriptsText));
      if (scriptBin) return `script binary "${scriptBin}" is invoked by package.json scripts`;
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
      const eslintPlugin = shorthandToken(name, "eslint-plugin");
      if (eslintPlugin !== null) {
        const config = eslintConfigs.find((f) => wordRegex(eslintPlugin).test(f.content));
        if (config) return `eslint config ${config.path} references plugin "${eslintPlugin}"`;
      }
      const babelPlugin = shorthandToken(name, "babel-plugin");
      if (babelPlugin !== null) {
        const config = babelConfigs.find((f) => wordRegex(babelPlugin).test(f.content));
        if (config) return `babel config ${config.path} references plugin "${babelPlugin}"`;
      }
      if ((name.startsWith("prettier-plugin-") || /^@[^/]+\/prettier-plugin-/.test(name)) && prettierConfigs.length > 0) {
        return `prettier plugin and config ${prettierConfigs[0].path} are package-scoped`;
      }
      if ((name.startsWith("postcss-") || name.endsWith("-postcss")) && postcssConfigs.some((f) => wordRegex(name.replace(/^postcss-/, "")).test(f.content))) {
        return `postcss config ${postcssConfigs[0].path} references this plugin`;
      }
      if ((name.startsWith("jest-") || name.includes("jest")) && jestConfigs.some((f) => wordRegex(name).test(f.content))) {
        return `jest config ${jestConfigs[0].path} references this package`;
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
          textHits: [...textHitsFor(manifest, name)],
          implicitReason: implicitReasonFor(name, range),
          evidence: [
            ...[...(imported.get(name) ?? [])].map((path) => ({ kind: "import" as const, path, detail: `resolved import of ${name}`, context: edgeImports.get(path)?.find((edge) => edge.name === name)?.context ?? "unknown" as const })),
            ...textHitsFor(manifest, name).map((path) => ({ kind: "config" as const, path, detail: `package-scoped mention of ${name}`, context: "config" as const })),
            ...(implicitReasonFor(name, range) ? [{ kind: "implicit" as const, path: manifest.dir === "." ? "package.json" : `${manifest.dir}/package.json`, detail: implicitReasonFor(name, range)!, context: "config" as const }] : []),
          ],
          contexts: [...new Set([...(imported.get(name) ?? [])].map((path) => edgeImports.get(path)?.find((edge) => edge.name === name)?.context ?? "unknown"))],
        });
      }
    }
    deps.sort((a, b) => cmp(a.name, b.name) || DEP_FIELDS.indexOf(a.field) - DEP_FIELDS.indexOf(b.field));

    const used = new Set<string>();
    for (const d of deps) {
      if (d.usedBy.length > 0 || d.textHits.length > 0 || d.implicitReason !== null) used.add(d.name);
    }
    const dynamicOwned = [...(input.dynamicImporters ?? [])].some((path) => owningManifest(manifests, path)?.dir === manifest.dir);
    const uncertain = dynamicOwned ? [...declared].filter((name) => !used.has(name)).sort() : [];
    const unused = [...declared].filter((name) => !used.has(name) && !uncertain.includes(name)).sort();
    const orphanOnly = [...declared].filter((name) => {
      const evidence = deps.filter((dep) => dep.name === name);
      const files = evidence.flatMap((dep) => dep.usedBy);
      return files.length > 0 && files.every((path) => input.orphanFiles?.has(path)) &&
        evidence.every((dep) => dep.textHits.length === 0 && dep.implicitReason === null);
    }).sort();

    const dualDeclared = Object.keys(manifest.fields.dependencies)
      .filter((name) => name in manifest.fields.devDependencies)
      .sort();

    const missing: MissingDep[] = [];
    for (const [pkg, importers] of imported) {
      if (declared.has(pkg)) continue;
      const workspaceTarget = manifests.find((candidate) =>
        candidate.name === pkg && candidate.dir !== manifest.dir &&
        (candidate.projectRoot ?? candidate.dir) === (manifest.projectRoot ?? manifest.dir),
      );
      const workspaceImport = authoritative
        ? (workspaceImports.get(manifest.dir)?.has(pkg) ?? false)
        : workspaceTarget !== undefined || input.workspacePkgNames.has(pkg);
      missing.push({
        name: pkg,
        importers: [...importers].sort(),
        declaredIn: nearestDeclaringAncestor(byDir, manifest.dir, manifest.projectRoot ?? ".", pkg),
        kind: workspaceImport ? "workspace" : "external",
        workspaceTargetDir: workspaceTarget?.dir ?? null,
        suggestedField: null,
        suggestedRange: workspaceImport ? "workspace:*" : null,
      });
    }
    missing.sort((a, b) => cmp(a.name, b.name));

    packages.push({
      dir: manifest.dir,
      name: manifest.name,
      manifest: manifest.raw,
      projectRoot: manifest.projectRoot ?? ".",
      projectKind: manifest.projectKind ?? "unmanaged",
      deps,
      unused,
      orphanOnly,
      uncertain,
      missing,
      dualDeclared,
    });
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
function shorthandToken(name: string, kind: "eslint-config" | "babel-preset" | "eslint-plugin" | "babel-plugin"): string | null {
  if (name.startsWith(`${kind}-`)) return name.slice(kind.length + 1);
  const scoped = /^(@[^/]+)\/(.+)$/.exec(name);
  if (scoped !== null && scoped[2] === kind) return scoped[1];
  if (scoped !== null && scoped[2].startsWith(`${kind}-`)) return `${scoped[1]}/${scoped[2].slice(kind.length + 1)}`;
  return null;
}

function nearestDeclaringAncestor(
  byDir: Map<string, PackageManifest>,
  fromDir: string,
  projectRoot: string,
  pkg: string,
): string | null {
  let dir = fromDir;
  while (dir !== ".") {
    const cut = dir.lastIndexOf("/");
    dir = cut === -1 ? "." : dir.slice(0, cut);
    const ancestor = byDir.get(dir);
    if (ancestor !== undefined && (ancestor.projectRoot ?? ".") === projectRoot && DEP_FIELDS.some((field) => pkg in ancestor.fields[field])) {
      return ancestor.dir;
    }
    if (dir === projectRoot) break;
  }
  return null;
}

function findWorkspaceSkew(manifests: PackageManifest[]): WorkspaceSkew[] {
  // One range per (manifest, name): the first declaring field wins, in DEP_FIELDS order.
  const rangesByName = new Map<string, { projectRoot: string; name: string; ranges: Record<string, string> }>();
  for (const manifest of manifests) {
    const seen = new Set<string>();
    for (const field of DEP_FIELDS) {
      for (const [name, range] of Object.entries(manifest.fields[field])) {
        if (seen.has(name)) continue;
        seen.add(name);
        const projectRoot = manifest.projectRoot ?? ".";
        const key = `${projectRoot}\0${name}`;
        const entry = rangesByName.get(key) ?? { projectRoot, name, ranges: {} };
        entry.ranges[manifest.dir] = range;
        rangesByName.set(key, entry);
      }
    }
  }
  return [...rangesByName.values()]
    .filter((entry) => new Set(Object.values(entry.ranges)).size >= 2)
    .map((entry) => ({ name: entry.name, ranges: entry.ranges, projectRoot: entry.projectRoot }))
    .sort((a, b) => cmp(a.projectRoot ?? ".", b.projectRoot ?? ".") || cmp(a.name, b.name));
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
