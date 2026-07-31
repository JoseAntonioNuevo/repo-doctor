import { posix } from "node:path";
import type {
  Diagnostic,
  PackageManager,
  PackageManagerResolution,
  PackageManifest,
  ProjectKind,
  ProjectReport,
} from "./types.ts";

const LOCKS: Record<string, PackageManager> = {
  "pnpm-lock.yaml": "pnpm",
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
};

function diagnostic(code: string, message: string, path = "."): Diagnostic {
  return {
    code,
    severity: "error",
    source: "workspace",
    message,
    affects: ["workspace", "dependencies", "lockfile"],
    scope: { kind: path === "." ? "repo" : "project", path },
  };
}

function parseManager(value: unknown): { name: PackageManager; version: string | null } | null {
  if (typeof value !== "string") return null;
  const match = /^(pnpm|npm|yarn|bun)(?:@(.+))?$/.exec(value.trim());
  return match ? { name: match[1] as PackageManager, version: match[2] ?? null } : null;
}

function globRegex(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        out += ".*";
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else if (ch === "{") {
      const end = pattern.indexOf("}", i + 1);
      if (end !== -1) {
        const values = pattern.slice(i + 1, end).split(",").map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        out += `(?:${values.join("|")})`;
        i = end;
      } else out += "\\{";
    } else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${out}/?$`);
}

export function matchesWorkspace(dir: string, patterns: string[]): boolean {
  let included = false;
  for (const raw of patterns) {
    const negative = raw.startsWith("!");
    const pattern = raw.replace(/^!/, "").replace(/^\.\//, "").replace(/\/$/, "");
    if (globRegex(pattern).test(dir)) included = !negative;
  }
  return included;
}

function manifestPatterns(root: PackageManifest, pnpmWorkspaceText: string | null): string[] {
  const value = root.raw.workspaces;
  const fromManifest = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : value && typeof value === "object" && Array.isArray((value as { packages?: unknown }).packages)
      ? ((value as { packages: unknown[] }).packages.filter((v): v is string => typeof v === "string"))
      : [];
  if (pnpmWorkspaceText === null) return fromManifest;
  const fromPnpm: string[] = [];
  let inPackages = false;
  for (const rawLine of pnpmWorkspaceText.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;
    const match = inPackages ? /^\s*-\s*["']?([^"']+?)["']?\s*$/.exec(line) : null;
    if (match) fromPnpm.push(match[1]);
  }
  return fromPnpm.length > 0 ? fromPnpm : fromManifest;
}

function resolveManager(
  root: PackageManifest,
  rootDir: string,
  tracked: Set<string>,
): PackageManagerResolution {
  const declared = parseManager(root.raw.packageManager);
  const locks = Object.entries(LOCKS)
    .map(([name, manager]) => ({ path: rootDir === "." ? name : `${rootDir}/${name}`, manager }))
    .filter(({ path }) => tracked.has(path));
  const conflicts: string[] = [];
  if (root.raw.packageManager !== undefined && declared === null) {
    conflicts.push(`invalid packageManager declaration ${JSON.stringify(root.raw.packageManager)}`);
  }
  if (declared && locks.some((lock) => lock.manager !== declared.name)) {
    conflicts.push(`packageManager declares ${declared.name} but tracked lockfile(s) belong to ${locks.map((lock) => lock.manager).join(", ")}`);
  }
  if (locks.length > 1) conflicts.push(`multiple package-manager lockfiles are tracked: ${locks.map((lock) => lock.path).join(", ")}`);
  if (conflicts.length > 0) {
    return { status: "ambiguous", name: null, version: null, source: null, lockfilePath: null, conflicts };
  }
  if (declared) {
    return {
      status: "resolved",
      name: declared.name,
      version: declared.version,
      source: "packageManager",
      lockfilePath: locks.find((lock) => lock.manager === declared.name)?.path ?? null,
      conflicts: [],
    };
  }
  if (locks.length === 1) {
    return { status: "resolved", name: locks[0].manager, version: null, source: "single-lockfile", lockfilePath: locks[0].path, conflicts: [] };
  }
  return { status: "none", name: null, version: null, source: null, lockfilePath: null, conflicts: [] };
}

export function discoverProjects(args: {
  manifests: PackageManifest[];
  trackedFiles: string[];
  readFile(path: string): string;
}): { projects: ProjectReport[]; diagnostics: Diagnostic[] } {
  const manifests = [...args.manifests].sort((a, b) => a.dir.localeCompare(b.dir));
  const root = manifests.find((manifest) => manifest.dir === ".");
  const tracked = new Set(args.trackedFiles);
  const diagnostics: Diagnostic[] = [];
  if (!root) return { projects: [], diagnostics: [diagnostic("workspace.no-root-manifest", "No tracked root package.json; dependency mutations are unavailable.")] };

  const pnpmWorkspaceText = tracked.has("pnpm-workspace.yaml") ? args.readFile("pnpm-workspace.yaml") : null;
  const patterns = manifestPatterns(root, pnpmWorkspaceText);
  const members = manifests.filter((manifest) => manifest.dir !== "." && matchesWorkspace(manifest.dir, patterns));
  const assigned = new Set([".", ...members.map((manifest) => manifest.dir)]);
  const rootKind: ProjectKind = patterns.length > 0 ? "workspace" : "standalone";
  const rootManager = resolveManager(root, ".", tracked);
  if (rootManager.status === "ambiguous") diagnostics.push(diagnostic("workspace.manager-ambiguous", rootManager.conflicts.join("; ")));
  const projects: ProjectReport[] = [{
    rootDir: ".",
    kind: rootKind,
    manager: rootManager,
    workspacePatterns: patterns,
    packageDirs: [".", ...members.map((manifest) => manifest.dir)].sort(),
    packageNames: [root, ...members].map((manifest) => manifest.name).sort(),
    workspaceSkew: [],
    lockfile: {
      path: rootManager.lockfilePath,
      dialect: rootManager.lockfilePath ? posix.basename(rootManager.lockfilePath) : null,
      parseStatus: rootManager.lockfilePath ? "parsed" : "not-applicable",
      diagnostics: [],
    },
    diagnostics: rootManager.conflicts.map((message) => diagnostic("workspace.manager-conflict", message)),
  }];

  for (const manifest of manifests.filter((candidate) => !assigned.has(candidate.dir))) {
    const manager = resolveManager(manifest, manifest.dir, tracked);
    const hasBoundary = manager.status !== "none";
    projects.push({
      rootDir: manifest.dir,
      kind: hasBoundary ? "standalone" : "unmanaged",
      manager,
      workspacePatterns: [],
      packageDirs: [manifest.dir],
      packageNames: [manifest.name],
      workspaceSkew: [],
      lockfile: {
        path: manager.lockfilePath,
        dialect: manager.lockfilePath ? posix.basename(manager.lockfilePath) : null,
        parseStatus: manager.lockfilePath ? "parsed" : "not-applicable",
        diagnostics: [],
      },
      diagnostics: hasBoundary ? [] : [diagnostic("workspace.unmanaged-manifest", `Nested ${manifest.dir}/package.json is not declared by a workspace and has no project boundary; dependency mutations are blocked.`, manifest.dir)],
    });
  }

  const names = new Map<string, string[]>();
  for (const manifest of manifests) names.set(manifest.name, [...(names.get(manifest.name) ?? []), manifest.dir]);
  for (const [name, dirs] of names) {
    if (dirs.length < 2) continue;
    const sortedDirs = dirs.sort();
    for (const dir of sortedDirs) {
      const item: Diagnostic = {
        ...diagnostic("workspace.duplicate-package-name", `Package name ${name} is duplicated in ${sortedDirs.join(", ")}; dependency mutations are blocked.`, dir),
        scope: { kind: "package", path: dir },
      };
      diagnostics.push(item);
      projects.find((candidate) => candidate.packageDirs.includes(dir))?.diagnostics.push(item);
    }
  }

  for (const project of projects) {
    for (const dir of project.packageDirs) {
      const manifest = manifests.find((candidate) => candidate.dir === dir);
      if (manifest) {
        manifest.projectRoot = project.rootDir;
        manifest.projectKind = project.kind;
      }
    }
  }
  return { projects: projects.sort((a, b) => a.rootDir.localeCompare(b.rootDir)), diagnostics };
}
