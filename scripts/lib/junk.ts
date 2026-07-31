import type { FileInfo, JunkCategory, JunkFinding } from "./types.ts";

/**
 * Junk detection — files that are tracked in git but almost never belong there:
 * build output, caches, logs, OS/editor droppings, backup copies, archives,
 * generated bundles, and `.env`-style sensitive files.
 *
 * Rules run in a fixed order and a file gets its FIRST matching category.
 * Sensitive runs before everything else on purpose: `dist/.env` and
 * `server.pem.bak` must land in the report-only sensitive bucket — the planner
 * never emits a delete action for those — not in a deletable build-artifact or
 * backup-copy item. After that the broad location rules win, so
 * `dist/app.min.js` is reported once as a build artifact, not again as
 * generated.
 */

/** Directory names that only ever hold build output. */
const BUILD_DIRS =
  /^(dist|build|out|output|\.next|\.nuxt|\.output|\.svelte-kit|\.vercel|\.netlify|coverage|\.nyc_output|storybook-static|node_modules)$/;

const CACHE_DIRS = /^(\.cache|\.turbo|\.parcel-cache|\.pnpm-store)$/;

const EDITOR_DIRS = /^(\.idea|\.vscode)$/;

/** Rotated debug logs (`npm-debug.log.1234567`) lack the `.log` suffix, hence no `$`. */
const DEBUG_LOGS = /^(npm-debug|yarn-error|yarn-debug|pnpm-debug|lerna-debug)\.log/;

/** Suffix on the basename before its final extension: `utils-old.ts`, `api.orig.ts`… */
const BACKUP_SUFFIX = /[._-](old|bak|backup|copy|orig|tmp)$/;

/** Finder/Explorer-style numbered copies: `logo (1).png`. */
const NUMBERED_COPY = / \(\d+\)$/;

const BACKUP_EXTS = new Set(["bak", "orig", "rej"]);

/** `.env` variants that are meant to be committed. */
const ENV_EXCEPTIONS = new Set([".env.example", ".env.template", ".env.sample", ".env.test"]);

/** Trailing extensions stripped before deciding a basename is key material. */
const KEY_BACKUP_TOKENS = new Set(["old", "bak", "backup", "copy", "orig", "tmp", "rej"]);

/**
 * "pem" or "key" when the basename is key material, null otherwise.
 *
 * `.pem`/`.key` must be the final extension once backup suffixes are peeled
 * off: `server.pem`, `server.pem.bak`, and `private.key.orig` qualify, while
 * `app.key.ts` (code) and `monkey.pem.md` (docs) do not.
 */
function keyMaterialExt(base: string): string | null {
  const parts = base.toLowerCase().split(".");
  while (parts.length > 1 && KEY_BACKUP_TOKENS.has(parts[parts.length - 1])) parts.pop();
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  return last === "pem" || last === "key" ? last : null;
}

const ARCHIVE_EXTS = new Set(["zip", "tar", "gz", "tgz", "rar", "7z", "iso", "dmg", "exe", "jar"]);

interface JunkRule {
  category: JunkCategory;
  /** Returns the human-readable pattern name on a match, null otherwise.
   *  `dirSegments` is the path's directory segments — the basename excluded,
   *  so a file literally named "dist" never reads as a build directory. */
  match(file: FileInfo, base: string, dirSegments: string[]): string | null;
}

/** Ordered: first matching rule wins. Sensitive is first — a secret stays in
 *  the report-only sensitive bucket no matter what directory it sits in or
 *  what backup suffix it carries. */
const RULES: JunkRule[] = [
  {
    category: "sensitive",
    match: (_file, base) => {
      if ((base === ".env" || base.startsWith(".env.")) && !ENV_EXCEPTIONS.has(base)) {
        return "committed .env file";
      }
      if (base === ".netrc") return ".netrc credentials file";
      if (base.startsWith("id_rsa") || base.startsWith("id_ed25519")) return "SSH key file";
      const keyExt = keyMaterialExt(base);
      if (keyExt !== null) return `key material (*.${keyExt})`;
      return null;
    },
  },
  {
    category: "build-artifact",
    match: (_file, _base, dirSegments) => {
      const seg = dirSegments.find((s) => BUILD_DIRS.test(s));
      return seg ? `build output directory "${seg}"` : null;
    },
  },
  {
    category: "cache",
    match: (_file, base, dirSegments) => {
      const seg = dirSegments.find((s) => CACHE_DIRS.test(s));
      if (seg) return `cache directory "${seg}"`;
      return base === ".eslintcache" ? ".eslintcache" : null;
    },
  },
  {
    category: "log",
    match: (_file, base) => {
      if (DEBUG_LOGS.test(base)) return "package-manager debug log";
      return base.endsWith(".log") ? "*.log" : null;
    },
  },
  {
    category: "os-or-editor",
    match: (_file, base, dirSegments) => {
      if (base === ".DS_Store") return ".DS_Store";
      if (base === "Thumbs.db") return "Thumbs.db";
      if (base === "desktop.ini") return "desktop.ini";
      if (base.endsWith(".swp")) return "vim swap file (*.swp)";
      if (base.endsWith("~")) return "editor backup (*~)";
      const seg = dirSegments.find((s) => EDITOR_DIRS.test(s));
      return seg ? `editor settings directory "${seg}"` : null;
    },
  },
  {
    category: "backup-copy",
    match: (file, base) => {
      const dot = base.lastIndexOf(".");
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const suffix = BACKUP_SUFFIX.exec(stem);
      if (suffix) return `backup suffix "${suffix[0]}"`;
      const copy = NUMBERED_COPY.exec(stem);
      if (copy) return `numbered copy suffix "${copy[0].trim()}"`;
      return BACKUP_EXTS.has(file.ext) ? `backup extension ".${file.ext}"` : null;
    },
  },
  {
    category: "binary-or-archive",
    match: (file) => (ARCHIVE_EXTS.has(file.ext) ? `archive extension ".${file.ext}"` : null),
  },
  {
    category: "generated",
    match: (file, base) => {
      if (base.endsWith(".min.js")) return "minified artifact (*.min.js)";
      if (base.endsWith(".min.css")) return "minified artifact (*.min.css)";
      if (base.endsWith(".bundle.js")) return "bundled artifact (*.bundle.js)";
      return file.ext === "map" ? "source map (*.map)" : null;
    },
  },
];

/**
 * Classify tracked files against the junk catalog.
 *
 * Every file is tested against the rules in order and reported at most once,
 * under its first matching category. Findings come back sorted by path.
 */
export function findJunk(files: FileInfo[]): JunkFinding[] {
  const findings: JunkFinding[] = [];
  for (const file of files) {
    const segments = file.path.split("/");
    const base = segments[segments.length - 1];
    const dirSegments = segments.slice(0, -1);
    for (const rule of RULES) {
      const pattern = rule.match(file, base, dirSegments);
      if (pattern !== null) {
        findings.push({ path: file.path, bytes: file.bytes, category: rule.category, pattern });
        break;
      }
    }
  }
  findings.sort((a, b) => (a.path < b.path ? -1 : 1));
  return findings;
}
