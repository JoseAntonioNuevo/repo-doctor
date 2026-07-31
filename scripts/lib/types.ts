/** Shared, versioned artifact contracts for repo-doctor 0.2.0. */

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";
export type ProjectKind = "workspace" | "standalone" | "unmanaged";
export type Capability = "inventory" | "graph" | "dependencies" | "workspace" | "lockfile";
export type HealthStatus = "complete" | "degraded" | "not-applicable";

export type DepField =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies"
  | "optionalDependencies";

export interface Diagnostic {
  code: string;
  severity: "warning" | "error";
  source: "inventory" | "graph" | "dependencies" | "workspace" | "lockfile" | "verify";
  message: string;
  affects: Capability[];
  scope: {
    kind: "repo" | "project" | "package" | "file";
    path: string;
  };
}

export interface AnalysisHealth {
  inventory: HealthStatus;
  graph: HealthStatus;
  dependencies: HealthStatus;
  workspace: HealthStatus;
  lockfile: HealthStatus;
}

export interface RepositoryIdentity {
  id: string;
  kind: "git-history" | "local-unborn";
  root: string;
  head: string | null;
  rootCommits: string[];
}

export interface RepositorySnapshot {
  repository: RepositoryIdentity;
  inventoryDigest: string;
  indexDigest: string;
  trackedWorktreeClean: boolean;
  gitStatus?: string[];
}

export interface ScanOptionsV2 {
  ignore: string[];
  entries: string[];
  largeCount: number;
  minDupBytes: number;
}

export interface PackageManagerResolution {
  status: "resolved" | "none" | "ambiguous" | "unsupported";
  name: PackageManager | null;
  version: string | null;
  source: "packageManager" | "single-lockfile" | null;
  lockfilePath: string | null;
  conflicts: string[];
}

export interface LockfileStatus {
  path: string | null;
  dialect: string | null;
  parseStatus: "parsed" | "unsupported" | "invalid" | "not-applicable";
  diagnostics: Diagnostic[];
}

export interface ProjectReport {
  rootDir: string;
  kind: ProjectKind;
  manager: PackageManagerResolution;
  workspacePatterns: string[];
  packageDirs: string[];
  packageNames: string[];
  workspaceSkew: WorkspaceSkew[];
  lockfile: LockfileStatus;
  lockfileDuplicates?: LockfileDuplicate[];
  diagnostics: Diagnostic[];
}

/** One tracked file in the repository. */
export interface FileInfo {
  path: string;
  bytes: number;
  /** sha256 of tracked content (or the tracked symlink target). */
  hash: string;
  /** Git object id and mode from the index. */
  objectId?: string;
  mode?: string;
  ext: string;
  symlink: boolean;
  /** True when content came from the index because the worktree copy was unavailable. */
  fromIndex?: boolean;
}

export interface DuplicateGroup {
  hash: string;
  bytes: number;
  paths: string[];
  wastedBytes: number;
}

export interface EntryPoint {
  path: string;
  reason: string;
}

export interface OrphanModule {
  path: string;
  bytes: number;
  importers: string[];
  pathReferencedBy: string[];
  hasShebang: boolean;
}

export interface UnresolvedImport {
  from: string;
  specifier: string;
}

export type ImportSource = "static" | "dynamic-literal" | "reference" | "vite-glob";
export type ImportContext = "runtime" | "test" | "config" | "tooling" | "type-only" | "unknown";
export type ImportTarget = "file" | "workspace-package" | "external-package" | "builtin" | "unresolved";

export interface ResolvedImportEdge {
  from: string;
  specifier: string;
  source: ImportSource;
  context: ImportContext;
  target: ImportTarget;
  path: string | null;
  packageName: string | null;
}

export interface ModuleGraph {
  moduleFiles: string[];
  entrypoints: EntryPoint[];
  orphans: OrphanModule[];
  unresolved: UnresolvedImport[];
  dynamicImporters: string[];
  resolvedEdges: ResolvedImportEdge[];
  health: { status: "complete" | "incomplete"; diagnostics: Diagnostic[] };
}

export interface AssetFinding {
  path: string;
  bytes: number;
  reason: string;
}

export interface DependencyEvidence {
  kind: "import" | "script" | "config" | "manifest" | "implicit" | "dynamic";
  path: string;
  detail: string;
  context: ImportContext;
}

export interface DepUsage {
  name: string;
  field: DepField;
  range: string;
  usedBy: string[];
  textHits: string[];
  implicitReason: string | null;
  evidence?: DependencyEvidence[];
  contexts?: ImportContext[];
}

export interface PackageManifest {
  dir: string;
  name: string;
  raw: Record<string, unknown>;
  fields: Record<DepField, Record<string, string>>;
  projectRoot?: string;
  projectKind?: ProjectKind;
}

export interface MissingDep {
  name: string;
  importers: string[];
  declaredIn: string | null;
  kind?: "external" | "workspace";
  workspaceTargetDir?: string | null;
  suggestedField?: DepField | null;
  suggestedRange?: string | null;
}

export interface PackageReport {
  dir: string;
  name: string;
  /** Full tracked manifest snapshot, used to authorize exact semantic edits. */
  manifest?: Record<string, unknown>;
  projectRoot?: string;
  projectKind?: ProjectKind;
  deps: DepUsage[];
  unused: string[];
  /** Deps whose only importers are current orphan modules. */
  orphanOnly?: string[];
  /** Deps whose evidence is incomplete/dynamic and cannot be safely removed. */
  uncertain?: string[];
  missing: MissingDep[];
  dualDeclared: string[];
}

export interface WorkspaceSkew {
  name: string;
  ranges: Record<string, string>;
  projectRoot?: string;
}

export interface LockfileDuplicate {
  name: string;
  versions: string[];
}

export interface OverlapFinding {
  family: string;
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
  pattern: string;
}

export interface RepoReport {
  version: 2;
  tool: "repo-doctor";
  toolVersion: string;
  createdAt: string;
  cwd: string;
  source: RepositorySnapshot;
  scanOptions: ScanOptionsV2;
  scanOptionsDigest: string;
  health: AnalysisHealth;
  diagnostics: Diagnostic[];
  projects: ProjectReport[];
  /** Root-project compatibility summary. */
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
  largeFiles: FileInfo[];
  warnings: string[];
}

export type Confidence = "high" | "medium" | "low";
export type PlanDisposition = "proposed" | "manual" | "review-only" | "deferred" | "blocked";
export type ReviewStatus = "approved" | "kept" | "pending" | "blocked";

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

export type PlannedMutation =
  | { kind: "delete-file"; path: string; beforeHash: string }
  | {
      kind: "untrack-file";
      path: string;
      beforeHash: string;
      ignorePath: string;
      ignorePattern: string;
      ignoreBeforeHash: string | null;
    }
  | {
      kind: "remove-declaration" | "move-declaration" | "change-range";
      packageDir: string;
      name: string;
      field: DepField;
      beforeRange: string;
      toField?: DepField;
      afterRange?: string;
    }
  | { kind: "modify-lockfile"; path: string; beforeHash: string };

export interface ReviewDecision {
  status: ReviewStatus;
  source: "approve-id" | "keep-pattern" | "planner-policy" | "allow-delete" | null;
  value: string | null;
}

export interface PlanItem {
  id: string;
  action: PlanAction;
  target: string;
  packageDir: string | null;
  confidence: Confidence;
  disposition: PlanDisposition;
  evidence: string;
  evidenceItems: string[];
  reclaimBytes: number;
  rescued: boolean;
  keepPattern: string | null;
  prerequisites: string[];
  relatedTargets: string[];
  decision: ReviewDecision;
  mutations: PlannedMutation[];
}

export interface ProtectedFile {
  path: string;
  hash: string;
  reasons: string[];
}

export interface CleanupPlan {
  version: 2;
  tool: "repo-doctor";
  toolVersion: string;
  createdAt: string;
  source: {
    reportSha256: string;
    repositoryId: string;
    baselineHead: string | null;
    inventoryDigest: string;
    indexDigest: string;
    scanOptionsDigest: string;
    toolVersion: string;
  };
  options: { keep: string[]; approve: string[]; allowDelete: string[]; minConfidence: Confidence };
  diagnostics: Diagnostic[];
  protectedFiles: ProtectedFile[];
  summary: {
    itemsTotal: number;
    itemsRescued: number;
    deleteFiles: number;
    reviewFiles: number;
    removeDeps: number;
    reclaimBytes: number;
    byAction: Record<string, number>;
    byDisposition: Record<PlanDisposition, number>;
    warnings: string[];
  };
  items: PlanItem[];
}

export interface GateResult {
  name: string;
  command: string;
  ok: boolean;
  ms: number;
  output: string;
  truncated?: boolean;
  timedOut?: boolean;
}

export interface VerifyRegressions {
  unauthorizedRemovals: string[];
  unauthorizedChanges: string[];
  protectedChanges: string[];
  missingEntrypoints: string[];
  missingReachable: string[];
  newOrphans: string[];
  newUnresolvedImports: UnresolvedImport[];
  newMissingDeps: { packageDir: string; name: string }[];
  unplannedManifestChanges: string[];
  gateInducedTrackedChanges: string[];
  healthErrors: string[];
}

export interface VerifyResult {
  version: 2;
  tool: "repo-doctor";
  toolVersion: string;
  createdAt: string;
  mode: "static-only" | "full";
  ok: boolean;
  inputs: { reportSha256: string; planSha256: string };
  candidateSnapshot: RepositorySnapshot;
  finalSnapshot: RepositorySnapshot;
  gates: GateResult[];
  regressions: VerifyRegressions;
  healthChanges: { capability: Capability; before: HealthStatus; after: HealthStatus }[];
  authorizationFailures: string[];
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
