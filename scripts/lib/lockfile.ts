import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Diagnostic, LockfileDuplicate, PackageManager } from "./types.ts";

const LOCKFILES: { kind: string; pm: PackageManager }[] = [
  { kind: "pnpm-lock.yaml", pm: "pnpm" },
  { kind: "package-lock.json", pm: "npm" },
  { kind: "npm-shrinkwrap.json", pm: "npm" },
  { kind: "yarn.lock", pm: "yarn" },
  { kind: "bun.lock", pm: "bun" },
  { kind: "bun.lockb", pm: "bun" },
];

/**
 * Detect the repo's lockfile. Precedence matters because migrated repos often
 * keep a stale lockfile from the previous package manager around:
 * pnpm-lock.yaml > package-lock.json > yarn.lock.
 */
export function detectLockfile(cwd: string, trackedFiles?: string[]): { kind: string; pm: PackageManager } | null {
  if (trackedFiles === undefined) {
    for (const lockfile of LOCKFILES) if (existsSync(join(cwd, lockfile.kind))) return { ...lockfile };
    return null;
  }
  const tracked = trackedFiles ? new Set(trackedFiles) : null;
  const found = LOCKFILES.filter((lockfile) => tracked ? tracked.has(lockfile.kind) : existsSync(join(cwd, lockfile.kind)));
  if (found.length !== 1) return null;
  return found[0] ? { ...found[0] } : null;
}

export interface LockfileParseResult {
  dialect: string;
  parseStatus: "parsed" | "unsupported" | "invalid";
  versions: Map<string, Set<string>>;
  diagnostics: Diagnostic[];
}

const lockDiagnostic = (code: string, message: string): Diagnostic => ({
  code,
  severity: "error",
  source: "lockfile",
  message,
  affects: ["lockfile"],
  scope: { kind: "project", path: "." },
});

export function parseLockfile(kind: string, rawContent: string): LockfileParseResult {
  const content = rawContent.replace(/\r\n?/g, "\n");
  try {
    if (kind === "package-lock.json" || kind === "npm-shrinkwrap.json") {
      const parsed = JSON.parse(content) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { dialect: "npm-invalid", parseStatus: "invalid", versions: new Map(), diagnostics: [lockDiagnostic("lockfile.invalid-npm", "npm lockfile must contain a JSON object.")] };
      }
      const raw = parsed as { lockfileVersion?: unknown };
      if (raw.lockfileVersion !== undefined && typeof raw.lockfileVersion !== "number") {
        return { dialect: "npm-invalid", parseStatus: "invalid", versions: new Map(), diagnostics: [lockDiagnostic("lockfile.invalid-npm-version", "npm lockfileVersion must be numeric.")] };
      }
      const version = typeof raw.lockfileVersion === "number" ? raw.lockfileVersion : 1;
      if (![1, 2, 3].includes(version)) {
        return { dialect: `npm-v${version}`, parseStatus: "unsupported", versions: new Map(), diagnostics: [lockDiagnostic("lockfile.unsupported-npm-version", `Unsupported npm lockfileVersion ${version}.`)] };
      }
      return { dialect: `npm-v${version}`, parseStatus: "parsed", versions: parseNpmLock(content), diagnostics: [] };
    }
    if (kind === "pnpm-lock.yaml") {
      const match = /^lockfileVersion:\s*["']?([^"'\s]+)["']?/m.exec(content);
      if (!match) return { dialect: "pnpm-unknown", parseStatus: "invalid", versions: new Map(), diagnostics: [lockDiagnostic("lockfile.invalid-pnpm", "pnpm lockfile has no lockfileVersion.")] };
      const major = Number(match[1].split(".")[0]);
      if (![5, 6, 7, 8, 9].includes(major)) return { dialect: `pnpm-v${match[1]}`, parseStatus: "unsupported", versions: new Map(), diagnostics: [lockDiagnostic("lockfile.unsupported-pnpm-version", `Unsupported pnpm lockfileVersion ${match[1]}.`)] };
      return { dialect: `pnpm-v${match[1]}`, parseStatus: "parsed", versions: parsePnpmLock(content), diagnostics: [] };
    }
    if (kind === "yarn.lock") {
      const berry = /^__metadata:\s*$/m.test(content);
      if (berry) {
        const metadataVersion = /^__metadata:\s*\n\s+version:\s*([0-9]+)/m.exec(content)?.[1];
        if (metadataVersion !== undefined && ![6, 8].includes(Number(metadataVersion))) {
          return { dialect: `yarn-berry-v${metadataVersion}`, parseStatus: "unsupported", versions: new Map(), diagnostics: [lockDiagnostic("lockfile.unsupported-yarn-version", `Unsupported Yarn Berry lockfile version ${metadataVersion}.`)] };
        }
        return { dialect: "yarn-berry", parseStatus: "parsed", versions: parseYarnBerryLock(content), diagnostics: [] };
      }
      if (content.trim() !== "" && !/^#\s*yarn lockfile v1\b/m.test(content)) {
        return { dialect: "yarn-classic", parseStatus: "invalid", versions: new Map(), diagnostics: [lockDiagnostic("lockfile.invalid-yarn-classic", "Yarn Classic lockfile is missing its v1 header.")] };
      }
      return { dialect: "yarn-classic", parseStatus: "parsed", versions: parseYarnLock(content), diagnostics: [] };
    }
    if (kind === "bun.lock" || kind === "bun.lockb") {
      return { dialect: kind, parseStatus: "unsupported", versions: new Map(), diagnostics: [lockDiagnostic("lockfile.unsupported-bun-dialect", `${kind} is detected for gate selection, but duplicate-version analysis is unavailable.`)] };
    }
    return { dialect: kind, parseStatus: "unsupported", versions: new Map(), diagnostics: [lockDiagnostic("lockfile.unsupported-dialect", `Unsupported lockfile dialect: ${kind}.`)] };
  } catch (error) {
    return { dialect: kind, parseStatus: "invalid", versions: new Map(), diagnostics: [lockDiagnostic("lockfile.invalid", `${kind} could not be parsed: ${(error as Error).message}`)] };
  }
}

/**
 * Extract package name -> distinct resolved versions from a lockfile.
 *
 * Deliberately line-based — no YAML dependency (builtins only), and lockfiles
 * are machine-written with stable indentation. Unrecognized lines are skipped,
 * never fatal: a weird entry costs one data point, not the scan.
 */
export function parseLockfileVersions(kind: string, content: string): Map<string, Set<string>> {
  return parseLockfile(kind, content).versions;
}

/** Deps resolved to two or more versions — worst offenders first. */
export function findLockfileDuplicates(versions: Map<string, Set<string>>): LockfileDuplicate[] {
  return [...versions.entries()]
    .filter(([, set]) => set.size >= 2)
    .map(([name, set]) => ({ name, versions: [...set].sort(compareVersions) }))
    .sort((a, b) => b.versions.length - a.versions.length || (a.name < b.name ? -1 : 1));
}

/**
 * pnpm-lock.yaml, v6 and v9 dialects:
 *   v6: under `packages:` — `  /name@version(peer)(…):`
 *   v9: under `packages:` and `snapshots:` — `  name@version:` /
 *       `  '@scope/name@version':` (leaf snapshots end in `: {}`)
 */
function parsePnpmLock(content: string): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>();
  let section = "";
  for (const line of content.split("\n")) {
    if (line !== "" && !line.startsWith(" ")) {
      section = line.endsWith(":") ? line.slice(0, -1) : "";
      continue;
    }
    if (section !== "packages" && section !== "snapshots") continue;
    const entry = /^ {2}(.+):(?: \{\})?\s*$/.exec(line);
    if (entry === null) continue;
    let key = entry[1];
    if ((key.startsWith("'") && key.endsWith("'")) || (key.startsWith('"') && key.endsWith('"'))) {
      key = key.slice(1, -1); // v9 quotes keys that start with "@"
    }
    if (key.startsWith("/")) key = key.slice(1); // v6 prefixes every key with "/"
    const paren = key.indexOf("(");
    if (paren !== -1) key = key.slice(0, paren); // peer-dependency suffix
    const at = key.lastIndexOf("@");
    const slash = key.lastIndexOf("/");
    const separator = at > 0 ? at : slash;
    if (separator <= 0) continue; // no version separator (or a bare scope)
    const name = at > 0 ? descriptorName(key, at) : key.slice(0, slash);
    const version = key.slice(separator + 1);
    if (!/^\d/.test(version)) continue; // link:/file:/git deps carry no registry version
    addVersion(versions, name, version);
  }
  return versions;
}

/** package-lock.json: prefer the v2/v3 `packages` map, fall back to the legacy `dependencies` tree. */
function parseNpmLock(content: string): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>();
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return versions; // a corrupt lockfile costs the duplicate check, not the scan
  }
  if (typeof raw !== "object" || raw === null) return versions;
  const lock = raw as { packages?: unknown; dependencies?: unknown };
  if (typeof lock.packages === "object" && lock.packages !== null) {
    for (const [key, entry] of Object.entries(lock.packages as Record<string, unknown>)) {
      const cut = key.lastIndexOf("node_modules/");
      if (cut === -1) continue; // the root project and workspace links, not registry deps
      const name = key.slice(cut + "node_modules/".length);
      const version = versionOf(entry);
      if (name === "" || version === null) continue;
      addVersion(versions, name, version);
    }
    if (versions.size > 0) return versions;
  }
  collectLegacyDeps(lock.dependencies, versions);
  return versions;
}

function versionOf(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const version = (entry as { version?: unknown }).version;
  return typeof version === "string" && version !== "" ? version : null;
}

function collectLegacyDeps(tree: unknown, versions: Map<string, Set<string>>): void {
  if (typeof tree !== "object" || tree === null) return;
  for (const [name, entry] of Object.entries(tree as Record<string, unknown>)) {
    const version = versionOf(entry);
    if (version !== null) addVersion(versions, name, version);
    if (typeof entry === "object" && entry !== null) {
      collectLegacyDeps((entry as { dependencies?: unknown }).dependencies, versions);
    }
  }
}

/** yarn.lock v1: `name@range[, name@range]:` headers followed by `  version "x"`. */
function parseYarnLock(content: string): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>();
  let pending: string[] = [];
  for (const line of content.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    if (!line.startsWith(" ")) {
      pending = [];
      if (!line.endsWith(":")) continue;
      for (const spec of line.slice(0, -1).split(",")) {
        let cleaned = spec.trim();
        if (cleaned.startsWith('"') && cleaned.endsWith('"')) cleaned = cleaned.slice(1, -1);
        const at = cleaned.lastIndexOf("@");
        if (at <= 0) continue; // no range separator (yarn berry metadata keys land here too)
        pending.push(descriptorName(cleaned, at));
      }
      continue;
    }
    const version = /^ {2}version "?([^"\s]+)"?\s*$/.exec(line);
    if (version !== null && pending.length > 0) {
      for (const name of pending) addVersion(versions, name, version[1]);
      pending = [];
    }
  }
  return versions;
}

/** Yarn Berry stores a quoted descriptor header and a `version:` scalar. */
function parseYarnBerryLock(content: string): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>();
  let pending: string[] = [];
  for (const line of content.split("\n")) {
    if (!line.startsWith(" ") && line.endsWith(":")) {
      let header = line.slice(0, -1).trim();
      if (header.startsWith('"') && header.endsWith('"')) header = header.slice(1, -1);
      pending = header.split(/,\s*/).flatMap((descriptor) => {
        const cleaned = descriptor.replace(/^"|"$/g, "");
        const at = cleaned.startsWith("@") ? cleaned.indexOf("@", 1) : cleaned.indexOf("@");
        return at > 0 ? [descriptorName(cleaned, cleaned.lastIndexOf("@"))] : [];
      });
      continue;
    }
    const match = /^\s{2}version:\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (match && pending.length > 0) {
      for (const name of pending) addVersion(versions, name, match[1]);
      pending = [];
    }
  }
  return versions;
}

function addVersion(versions: Map<string, Set<string>>, name: string, version: string): void {
  let set = versions.get(name);
  if (set === undefined) {
    set = new Set();
    versions.set(name, set);
  }
  set.add(version);
}

/** Name portion of a registry descriptor, including npm aliases. */
function descriptorName(value: string, versionAt: number): string {
  const firstAt = value.startsWith("@") ? value.indexOf("@", 1) : value.indexOf("@");
  if (firstAt <= 0 || firstAt >= versionAt) return value.slice(0, versionAt);
  return value.slice(0, firstAt);
}

/** Numeric-aware version compare so "10.0.0" sorts after "9.0.0". */
function compareVersions(a: string, b: string): number {
  const as = a.split(/[.+-]/);
  const bs = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(as.length, bs.length); i += 1) {
    const x = as[i] ?? "";
    const y = bs[i] ?? "";
    if (x === y) continue;
    const xn = Number(x);
    const yn = Number(y);
    if (Number.isFinite(xn) && Number.isFinite(yn) && xn !== yn) return xn - yn;
    return x < y ? -1 : 1;
  }
  return 0;
}
