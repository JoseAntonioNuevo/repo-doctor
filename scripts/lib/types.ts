/**
 * Shared data shapes for repo-doctor.
 *
 * All artifacts are versioned JSON so any agent (or CI job) can consume them
 * without running the producing script again.
 */

export type PackageManager = "pnpm" | "npm" | "yarn";

export type DepField =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies"
  | "optionalDependencies";

/** One tracked file in the repository. Paths are repo-root-relative, posix separators. */
export interface FileInfo {
  path: string;
  bytes: number;
  /** sha1 hex of the file content. */
  hash: string;
  /** Lowercase extension without the dot; "" when the file has none. */
  ext: string;
  /** True for symlinks — excluded from duplicate grouping and never a deletion candidate. */
  symlink: boolean;
}

/** Two or more tracked files with byte-identical content. */
export interface DuplicateGroup {
  hash: string;
  /** Size of one copy. */
  bytes: number;
  /** Sorted paths; length >= 2. */
  paths: string[];
  /** bytes * (paths.length - 1). */
  wastedBytes: number;
}

export interface EntryPoint {
  path: string;
  /** Why this file is a root, e.g. "package.json main", "next.js route file", "test file". */
  reason: string;
}

export interface OrphanModule {
  path: string;
  bytes: number;
  /** Other orphans that import this file (orphan clusters die together). */
  importers: string[];
  /** Tracked text files whose content mentions this file's repo-relative path (capped at 3) —
   *  strong evidence the "orphan" is run or referenced outside the import graph. */
  pathReferencedBy: string[];
  /** First line starts with "#!" — likely a manually invoked script, not dead code. */
  hasShebang: boolean;
}

export interface UnresolvedImport {
  from: string;
  specifier: string;
}

export interface ModuleGraph {
  /** All tracked files parsed as JS/TS modules. */
  moduleFiles: string[];
  entrypoints: EntryPoint[];
  /** Module files unreachable from every entrypoint. */
  orphans: OrphanModule[];
  /** Internal-looking specifiers that could not be resolved to a tracked file. */
  unresolved: UnresolvedImport[];
  /** Files containing a non-literal import()/require() — orphan confidence drops when present. */
  dynamicImporters: string[];
}

/** A non-module file (image, font, media…) whose basename appears nowhere in tracked text files. */
export interface AssetFinding {
  path: string;
  bytes: number;
  reason: string;
}

export interface DepUsage {
  name: string;
  field: DepField;
  range: string;
  /** Module files in this workspace package that import it. */
  usedBy: string[];
  /** Non-import evidence: tracked text files mentioning the name (configs, scripts…). Capped at 5. */
  textHits: string[];
  /** Evidence from the implicit-use catalogs (bin names, config shorthand, @types pairing); null when none. */
  implicitReason: string | null;
}

/** Parsed package.json; dir is "." for the repo root, repo-relative otherwise. */
export interface PackageManifest {
  dir: string;
  /** Package name, or the dir as fallback when unnamed. */
  name: string;
  raw: Record<string, unknown>;
  /** name -> range per dep field; empty objects when the field is absent. */
  fields: Record<DepField, Record<string, string>>;
}

export interface MissingDep {
  name: string;
  importers: string[];
  /** Another manifest dir that declares it (hoisting evidence), or null. */
  declaredIn: string | null;
}

/** Findings for one package.json (workspace-aware; dir is "." for the root). */
export interface PackageReport {
  dir: string;
  name: string;
  deps: DepUsage[];
  /** Dep names with no imports, no text hits, and no implicit-use rule. */
  unused: string[];
  missing: MissingDep[];
  /** Declared in both dependencies and devDependencies. */
  dualDeclared: string[];
}

/** Same dep declared with different ranges across workspace manifests. dir -> range. */
export interface WorkspaceSkew {
  name: string;
  ranges: Record<string, string>;
}

export interface LockfileDuplicate {
  name: string;
  /** Distinct resolved versions in the lockfile, sorted. */
  versions: string[];
}

export interface OverlapFinding {
  /** Catalog family id, e.g. "date libraries". */
  family: string;
  /** Declared packages from the same family in one manifest. */
  packages: string[];
  packageDir: string;
  hint: string;
}

export type JunkCategory =
  | "build-artifact"
  | "log"
  | "cache"
  | "os-or-editor"
  | "binary-or-archive"
  | "generated"
  | "backup-copy"
  | "sensitive";

export interface JunkFinding {
  path: string;
  bytes: number;
  category: JunkCategory;
  /** Human-readable name of the matching rule. */
  pattern: string;
}

export interface RepoReport {
  version: 1;
  tool: "repo-doctor";
  createdAt: string;
  cwd: string;
  /** The --ignore / --entry inputs this scan ran with. verify.ts replays them
   *  from the baseline so its re-scan measures with the same instrument. */
  scanOptions: { ignore: string[]; entries: string[] };
  packageManager: PackageManager | null;
  lockfileKind: string | null;
  totals: {
    trackedFiles: number;
    trackedBytes: number;
    moduleFiles: number;
    packages: number;
    declaredDeps: number;
  };
  files: FileInfo[];
  duplicateGroups: DuplicateGroup[];
  graph: ModuleGraph;
  unreferencedAssets: AssetFinding[];
  packages: PackageReport[];
  workspaceSkew: WorkspaceSkew[];
  lockfileDuplicates: LockfileDuplicate[];
  overlaps: OverlapFinding[];
  junk: JunkFinding[];
  /** Top-N tracked files by size — report-only context, never auto-actioned. */
  largeFiles: FileInfo[];
  /** Non-fatal scan problems. Surface these to the user verbatim. */
  warnings: string[];
}

export type Confidence = "high" | "medium" | "low";

export type PlanAction =
  | "delete-file"
  | "review-file"
  | "remove-dep"
  | "move-dep"
  | "add-missing-dep"
  | "align-versions"
  | "dedupe-lockfile"
  | "untrack-and-gitignore"
  | "consolidate-overlap"
  | "review-sensitive";

export interface PlanItem {
  /** Stable id: "<action>:<target>" plus ":<packageDir>" for dep actions. */
  id: string;
  action: PlanAction;
  /** File path or dependency name. */
  target: string;
  /** Set for dep actions, null for file actions. */
  packageDir: string | null;
  confidence: Confidence;
  /** One-sentence justification carrying the numbers/evidence. */
  evidence: string;
  /** Bytes reclaimed if applied; 0 when unknown or not applicable. */
  reclaimBytes: number;
  /** True when a --keep pattern matched — kept in the plan for the audit trail, excluded from action counts. */
  rescued: boolean;
  keepPattern: string | null;
}

export interface CleanupPlan {
  version: 1;
  tool: "repo-doctor";
  createdAt: string;
  options: Record<string, unknown>;
  summary: {
    itemsTotal: number;
    itemsRescued: number;
    deleteFiles: number;
    reviewFiles: number;
    removeDeps: number;
    reclaimBytes: number;
    byAction: Record<string, number>;
    warnings: string[];
  };
  items: PlanItem[];
}

export interface GateResult {
  name: string;
  command: string;
  ok: boolean;
  ms: number;
  /** Tail of combined output, capped. */
  output: string;
}

export interface VerifyResult {
  version: 1;
  tool: "repo-doctor";
  createdAt: string;
  ok: boolean;
  gates: GateResult[];
  regressions: {
    /** Unresolved imports present after cleanup that were not in the baseline. */
    newUnresolvedImports: UnresolvedImport[];
    newMissingDeps: { packageDir: string; name: string }[];
  };
  comparison: {
    filesBefore: number;
    filesAfter: number;
    bytesBefore: number;
    bytesAfter: number;
    depsBefore: number;
    depsAfter: number;
  };
  warnings: string[];
}
