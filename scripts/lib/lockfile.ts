import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LockfileDuplicate, PackageManager } from "./types.ts";

const LOCKFILES: { kind: string; pm: PackageManager }[] = [
  { kind: "pnpm-lock.yaml", pm: "pnpm" },
  { kind: "package-lock.json", pm: "npm" },
  { kind: "yarn.lock", pm: "yarn" },
];

/**
 * Detect the repo's lockfile. Precedence matters because migrated repos often
 * keep a stale lockfile from the previous package manager around:
 * pnpm-lock.yaml > package-lock.json > yarn.lock.
 */
export function detectLockfile(cwd: string): { kind: string; pm: PackageManager } | null {
  for (const lockfile of LOCKFILES) {
    if (existsSync(join(cwd, lockfile.kind))) return { ...lockfile };
  }
  return null;
}

/**
 * Extract package name -> distinct resolved versions from a lockfile.
 *
 * Deliberately line-based — no YAML dependency (builtins only), and lockfiles
 * are machine-written with stable indentation. Unrecognized lines are skipped,
 * never fatal: a weird entry costs one data point, not the scan.
 */
export function parseLockfileVersions(kind: string, content: string): Map<string, Set<string>> {
  if (kind === "pnpm-lock.yaml") return parsePnpmLock(content);
  if (kind === "package-lock.json") return parseNpmLock(content);
  if (kind === "yarn.lock") return parseYarnLock(content);
  return new Map();
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
    const entry = /^ {2}(\S[^:]*):(?: \{\})?\s*$/.exec(line);
    if (entry === null) continue;
    let key = entry[1];
    if ((key.startsWith("'") && key.endsWith("'")) || (key.startsWith('"') && key.endsWith('"'))) {
      key = key.slice(1, -1); // v9 quotes keys that start with "@"
    }
    if (key.startsWith("/")) key = key.slice(1); // v6 prefixes every key with "/"
    const paren = key.indexOf("(");
    if (paren !== -1) key = key.slice(0, paren); // peer-dependency suffix
    const at = key.lastIndexOf("@");
    if (at <= 0) continue; // no version separator (or a bare scope)
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
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
        pending.push(cleaned.slice(0, at));
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

function addVersion(versions: Map<string, Set<string>>, name: string, version: string): void {
  let set = versions.get(name);
  if (set === undefined) {
    set = new Set();
    versions.set(name, set);
  }
  set.add(version);
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
