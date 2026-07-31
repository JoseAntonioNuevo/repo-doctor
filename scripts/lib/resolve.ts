/**
 * Specifier resolution: map an import specifier to a tracked file, an external
 * package, a Node builtin, or "unresolved". Everything works on the tracked
 * file set — no filesystem probing beyond reading tsconfig files.
 */
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";

/** tsconfig alias config; baseUrl and every paths target are repo-relative. */
export interface TsPathsConfig {
  baseUrl: string | null;
  paths: Record<string, string[]>;
}

/** One workspace package; entry is repo-relative (from main/module/exports), null when unknown. */
export interface WorkspacePkg {
  name: string;
  dir: string;
  entry: string | null;
}

export type Resolution =
  | { kind: "internal"; path: string }
  | { kind: "package"; name: string }
  | { kind: "builtin" }
  | { kind: "unresolved" };

const BUILTINS = new Set(builtinModules);

/** Candidate extensions in trial order — TypeScript first, SFCs (whose script
 *  blocks import like any module) after plain JS, declarations last. */
const EXTS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "astro", "d.ts"];

function stripJsonComments(text: string): string {
  const out = text.split("");
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 2;
      else {
        if (ch === '"') inString = false;
        i += 1;
      }
    } else if (ch === '"') {
      inString = true;
      i += 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") out[i++] = " ";
    } else if (ch === "/" && text[i + 1] === "*") {
      out[i] = out[i + 1] = " ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] !== "\n") out[i] = " ";
        i += 1;
      }
      if (i < text.length) {
        out[i] = out[i + 1] = " ";
        i += 2;
      }
    } else i += 1;
  }
  return out.join("");
}

/** Parse a JSONC object file: comments and trailing commas allowed. */
function readJsonc(absPath: string): Record<string, unknown> | null {
  if (!existsSync(absPath)) return null;
  const text = stripJsonComments(readFileSync(absPath, "utf8")).replace(/,\s*([}\]])/g, "$1");
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function compilerOptionsOf(config: Record<string, unknown>): Record<string, unknown> {
  const co = config["compilerOptions"];
  return typeof co === "object" && co !== null ? (co as Record<string, unknown>) : {};
}

function toRepoRel(cwd: string, absPath: string): string {
  const rel = relative(cwd, absPath).replace(/\\/g, "/");
  return rel === "" ? "." : rel;
}

/**
 * Load baseUrl/paths from a tsconfig, following one relative `extends` hop.
 * Each option resolves relative to the config file that declared it, and the
 * result is rewritten repo-relative. Any read or parse problem returns null —
 * a broken tsconfig must degrade alias resolution, not kill the scan.
 */
export function loadTsPaths(cwd: string, tsconfigPath = "tsconfig.json"): TsPathsConfig | null {
  try {
    const abs = isAbsolute(tsconfigPath) ? tsconfigPath : join(cwd, tsconfigPath);
    const raw = readJsonc(abs);
    if (raw === null) return null;

    const ownDir = dirname(abs);
    const own = compilerOptionsOf(raw);
    let parent: Record<string, unknown> = {};
    let parentDir = ownDir;
    const ext = raw["extends"];
    if (typeof ext === "string" && (ext.startsWith("./") || ext.startsWith("../"))) {
      let parentAbs = resolve(ownDir, ext);
      if (!existsSync(parentAbs) && !parentAbs.endsWith(".json")) parentAbs += ".json";
      const parentRaw = readJsonc(parentAbs);
      if (parentRaw !== null) {
        parent = compilerOptionsOf(parentRaw);
        parentDir = dirname(parentAbs);
      }
    }

    const pick = (key: string): { value: unknown; dir: string } | null =>
      own[key] !== undefined
        ? { value: own[key], dir: ownDir }
        : parent[key] !== undefined
          ? { value: parent[key], dir: parentDir }
          : null;

    const basePick = pick("baseUrl");
    const baseAbs =
      basePick !== null && typeof basePick.value === "string"
        ? resolve(basePick.dir, basePick.value)
        : null;

    const paths: Record<string, string[]> = {};
    const pathsPick = pick("paths");
    if (pathsPick !== null && typeof pathsPick.value === "object" && pathsPick.value !== null) {
      // Targets are baseUrl-relative; without a baseUrl they resolve from the
      // declaring config's directory (TypeScript >= 4.1 semantics).
      const targetBase = baseAbs ?? pathsPick.dir;
      const record = pathsPick.value as Record<string, unknown>;
      for (const pattern of Object.keys(record).sort()) {
        const targets = record[pattern];
        if (!Array.isArray(targets)) continue;
        const rel = targets
          .filter((t): t is string => typeof t === "string")
          .map((t) => toRepoRel(cwd, resolve(targetBase, t)));
        if (rel.length > 0) paths[pattern] = rel;
      }
    }

    return { baseUrl: baseAbs === null ? null : toRepoRel(cwd, baseAbs), paths };
  } catch {
    return null;
  }
}

/** Posix-normalize a repo-relative path and drop any trailing slash. */
function normalized(p: string): string {
  return posix.normalize(p).replace(/\/+$/, "");
}

/** Try one repo-relative base as a file: exact, +ext, ESM .js rewrite, then /index. */
function tryFileCandidates(base: string, fileSet: Set<string>): string | null {
  if (fileSet.has(base)) return base;
  for (const ext of EXTS) if (fileSet.has(`${base}.${ext}`)) return `${base}.${ext}`;
  if (base.endsWith(".js")) {
    // ESM TypeScript style: source says "./util.js", the tracked file is util.ts(x).
    const stem = base.slice(0, -3);
    for (const ext of ["ts", "tsx"]) if (fileSet.has(`${stem}.${ext}`)) return `${stem}.${ext}`;
  }
  // base "." is the repo root itself — its index candidates carry no prefix.
  const indexBase = base === "." ? "" : `${base}/`;
  for (const ext of EXTS) if (fileSet.has(`${indexBase}index.${ext}`)) return `${indexBase}index.${ext}`;
  return null;
}

/** Pick the tsconfig paths pattern for a specifier: exact match first, then longest wildcard prefix. */
function matchTsPath(
  spec: string,
  paths: Record<string, string[]>,
): { targets: string[]; star: string } | null {
  if (Object.hasOwn(paths, spec)) return { targets: paths[spec], star: "" };
  let best: { prefixLen: number; targets: string[]; star: string } | null = null;
  for (const pattern of Object.keys(paths)) {
    const starAt = pattern.indexOf("*");
    if (starAt === -1) continue;
    const prefix = pattern.slice(0, starAt);
    const suffix = pattern.slice(starAt + 1);
    if (spec.length < prefix.length + suffix.length) continue;
    if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
    if (best === null || prefix.length > best.prefixLen) {
      best = {
        prefixLen: prefix.length,
        targets: paths[pattern],
        star: spec.slice(prefix.length, spec.length - suffix.length),
      };
    }
  }
  return best === null ? null : { targets: best.targets, star: best.star };
}

/**
 * Resolve one specifier from one file. Order: builtin, relative, tsconfig
 * alias, workspace package, external package. Relative and alias specifiers
 * never fall through to "package" — a miss there is a broken import, and it
 * surfaces as unresolved.
 */
export function resolveSpecifier(
  fromFile: string,
  spec: string,
  fileSet: Set<string>,
  tsPaths: TsPathsConfig | null,
  workspacePkgs: WorkspacePkg[],
): Resolution {
  if (spec.startsWith("node:") || BUILTINS.has(spec)) return { kind: "builtin" };

  if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
    // "." and ".." are directory-index imports, exactly like "./" and "../".
    const base = normalized(posix.join(posix.dirname(fromFile), spec));
    if (base === ".." || base.startsWith("../")) return { kind: "unresolved" }; // escapes the repo root
    const hit = tryFileCandidates(base, fileSet);
    return hit === null ? { kind: "unresolved" } : { kind: "internal", path: hit };
  }

  if (tsPaths !== null) {
    const match = matchTsPath(spec, tsPaths.paths);
    if (match !== null) {
      for (const target of match.targets) {
        const base = normalized(target.replace("*", match.star));
        if (base.startsWith("../")) continue;
        const hit = tryFileCandidates(base, fileSet);
        if (hit !== null) return { kind: "internal", path: hit };
      }
      return { kind: "unresolved" };
    }
  }

  for (const pkg of workspacePkgs) {
    if (spec === pkg.name) {
      if (pkg.entry !== null) return { kind: "internal", path: pkg.entry };
      for (const ext of EXTS) {
        const index = `${pkg.dir}/index.${ext}`;
        if (fileSet.has(index)) return { kind: "internal", path: index };
      }
      return { kind: "package", name: pkg.name };
    }
    if (spec.startsWith(`${pkg.name}/`)) {
      // Subpath into a workspace package: an untracked hit (e.g. built dist/)
      // is normal, so a miss stays "package" rather than becoming noise.
      const base = normalized(posix.join(pkg.dir, spec.slice(pkg.name.length + 1)));
      const hit = base.startsWith("../") ? null : tryFileCandidates(base, fileSet);
      return hit === null ? { kind: "package", name: pkg.name } : { kind: "internal", path: hit };
    }
  }

  if (spec.startsWith("/")) return { kind: "unresolved" }; // absolute specifiers are never npm packages
  // package.json subpath imports ("#…") are internal aliases, never npm packages;
  // without the (unmodeled) imports map they are unresolved, not a missing dep.
  if (spec.startsWith("#")) return { kind: "unresolved" };

  const segments = spec.split("/");
  if (spec.startsWith("@")) {
    // "@/x"-style alias misses and a bare "@scope" are never valid npm names —
    // unresolved keeps them out of missing-dep candidates and lets the
    // orphan-confidence downgrade fire instead.
    if (segments.length < 2 || segments[0] === "@" || segments[1] === "") {
      return { kind: "unresolved" };
    }
    return { kind: "package", name: `${segments[0]}/${segments[1]}` };
  }
  return { kind: "package", name: segments[0] };
}
