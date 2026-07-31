import type {
  CleanupPlan,
  GateResult,
  PackageManager,
  PlannedMutation,
  ProjectReport,
  RepoReport,
  VerifyRegressions,
  VerifyResult,
} from "./types.ts";
import { canonicalJson } from "./artifacts.ts";

export function emptyRegressions(): VerifyRegressions {
  return {
    unauthorizedRemovals: [],
    unauthorizedChanges: [],
    protectedChanges: [],
    missingEntrypoints: [],
    missingReachable: [],
    newOrphans: [],
    newUnresolvedImports: [],
    newMissingDeps: [],
    unplannedManifestChanges: [],
    gateInducedTrackedChanges: [],
    healthErrors: [],
  };
}

export function compareScans(
  before: RepoReport,
  after: RepoReport,
): { regressions: VerifyRegressions; comparison: VerifyResult["comparison"] } {
  const regressions = emptyRegressions();
  const knownUnresolved = new Set(before.graph.unresolved.map((item) => `${item.from}\0${item.specifier}`));
  regressions.newUnresolvedImports = after.graph.unresolved
    .filter((item) => !knownUnresolved.has(`${item.from}\0${item.specifier}`))
    .sort((a, b) => a.from.localeCompare(b.from) || a.specifier.localeCompare(b.specifier));

  const missing = (report: RepoReport): { packageDir: string; name: string; declaredIn: string | null }[] =>
    report.packages.flatMap((pkg) => pkg.missing.map((item) => ({ packageDir: pkg.dir, name: item.name, declaredIn: item.declaredIn })));
  const knownMissing = new Set(missing(before).map((item) => `${item.packageDir}\0${item.name}\0${item.declaredIn ?? "hard"}`));
  regressions.newMissingDeps = missing(after)
    .filter((item) => !knownMissing.has(`${item.packageDir}\0${item.name}\0${item.declaredIn ?? "hard"}`))
    .map(({ packageDir, name }) => ({ packageDir, name }))
    .sort((a, b) => a.packageDir.localeCompare(b.packageDir) || a.name.localeCompare(b.name));

  const knownOrphans = new Set(before.graph.orphans.map((item) => item.path));
  regressions.newOrphans = after.graph.orphans.map((item) => item.path).filter((path) => !knownOrphans.has(path)).sort();
  for (const capability of Object.keys(before.health) as (keyof RepoReport["health"])[]) {
    if (after.health[capability] === "degraded" && before.health[capability] !== "degraded") {
      regressions.healthErrors.push(`${capability}: ${before.health[capability]} -> ${after.health[capability]}`);
    }
  }
  const knownDiagnostics = new Set(before.diagnostics.map(diagnosticIdentity));
  for (const diagnostic of after.diagnostics) {
    if (!knownDiagnostics.has(diagnosticIdentity(diagnostic))) {
      regressions.healthErrors.push(`${diagnostic.code}:${diagnostic.scope.kind}:${diagnostic.scope.path}`);
    }
  }
  return {
    regressions,
    comparison: {
      filesBefore: before.totals.trackedFiles,
      filesAfter: after.totals.trackedFiles,
      bytesBefore: before.totals.trackedBytes,
      bytesAfter: after.totals.trackedBytes,
      depsBefore: before.totals.declaredDeps,
      depsAfter: after.totals.declaredDeps,
    },
  };
}

function diagnosticIdentity(diagnostic: RepoReport["diagnostics"][number]): string {
  return canonicalJson({
    code: diagnostic.code,
    source: diagnostic.source,
    affects: [...diagnostic.affects].sort(),
    scope: diagnostic.scope,
  });
}

const mutationKey = (mutation: PlannedMutation): string => {
  if (mutation.kind === "delete-file" || mutation.kind === "untrack-file") return `${mutation.kind}:${mutation.path}`;
  if (mutation.kind === "modify-lockfile") return `${mutation.kind}:${mutation.path}`;
  return `${mutation.kind}:${mutation.packageDir}:${mutation.name}:${mutation.field}`;
};

function declarationMap(report: RepoReport): Map<string, string> {
  const map = new Map<string, string>();
  for (const pkg of report.packages) {
    for (const dep of pkg.deps) map.set(`${pkg.dir}\0${dep.name}\0${dep.field}`, dep.range);
  }
  return map;
}

function cloneManifest(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function normalizeManifest(value: Record<string, unknown>): Record<string, unknown> {
  const copy = cloneManifest(value);
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const declarations = copy[field];
    if (declarations && typeof declarations === "object" && !Array.isArray(declarations) && Object.keys(declarations).length === 0) delete copy[field];
  }
  return copy;
}

function expectedManifestAfterSubset(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  packageDir: string,
  approved: PlannedMutation[],
): Record<string, unknown> {
  const expected = cloneManifest(before);
  for (const mutation of approved) {
    if ((mutation.kind !== "remove-declaration" && mutation.kind !== "move-declaration" && mutation.kind !== "change-range") || mutation.packageDir !== packageDir) continue;
    const field = expected[mutation.field];
    const current = field && typeof field === "object" && !Array.isArray(field)
      ? (field as Record<string, unknown>)[mutation.name]
      : undefined;
    const afterField = after[mutation.field];
    const afterValue = afterField && typeof afterField === "object" && !Array.isArray(afterField)
      ? (afterField as Record<string, unknown>)[mutation.name]
      : undefined;
    // An approved mutation may be omitted. Apply it to the expected manifest
    // only when the candidate actually changed its source declaration.
    if (current === mutation.beforeRange && afterValue !== mutation.beforeRange) {
      delete (field as Record<string, unknown>)[mutation.name];
      if (mutation.kind === "change-range" && mutation.afterRange !== undefined) {
        const record = (expected[mutation.field] ??= {}) as Record<string, unknown>;
        record[mutation.name] = mutation.afterRange;
      } else if (mutation.kind === "move-declaration" && mutation.toField) {
        const record = (expected[mutation.toField] ??= {}) as Record<string, unknown>;
        record[mutation.name] = mutation.afterRange ?? mutation.beforeRange;
      }
    }
  }
  return normalizeManifest(expected);
}

/** Enforce the reviewed plan against a candidate scan. Applying only a subset
 * of approved mutations is valid; applying anything else is not. */
export function verifyAuthorizedChanges(before: RepoReport, after: RepoReport, plan: CleanupPlan): VerifyRegressions {
  const regressions = compareScans(before, after).regressions;
  const approved = plan.items
    .filter((item) => item.decision.status === "approved")
    .flatMap((item) => item.mutations);
  const approvedKeys = new Set(approved.map(mutationKey));
  const afterFiles = new Map(after.files.map((file) => [file.path, file]));
  const beforeFiles = new Map(before.files.map((file) => [file.path, file]));

  for (const file of before.files) {
    if (afterFiles.has(file.path)) continue;
    const deleteKey = `delete-file:${file.path}`;
    const untrackKey = `untrack-file:${file.path}`;
    if (!approvedKeys.has(deleteKey) && !approvedKeys.has(untrackKey)) regressions.unauthorizedRemovals.push(file.path);
  }
  const manifestPaths = new Set(before.packages.map((pkg) => pkg.dir === "." ? "package.json" : `${pkg.dir}/package.json`));
  const lockPaths = new Set(before.projects.map((project) => project.lockfile.path).filter((path): path is string => path !== null));
  const approvedIgnorePaths = new Set(approved.filter((mutation) => mutation.kind === "untrack-file").map((mutation) => mutation.ignorePath));
  for (const file of before.files) {
    const current = afterFiles.get(file.path);
    if (!current || current.hash === file.hash) continue;
    if (manifestPaths.has(file.path) || approvedIgnorePaths.has(file.path)) continue;
    const lockAllowed = lockPaths.has(file.path) && approved.some((mutation) => mutation.kind === "modify-lockfile" && mutation.path === file.path && mutation.beforeHash === file.hash);
    if (!lockAllowed) regressions.unauthorizedChanges.push(`${file.path} modified`);
  }
  for (const file of after.files) {
    if (!beforeFiles.has(file.path) && !approvedIgnorePaths.has(file.path)) regressions.unauthorizedChanges.push(`${file.path} added`);
  }
  for (const protectedFile of plan.protectedFiles) {
    const current = afterFiles.get(protectedFile.path);
    if (!current || current.hash !== protectedFile.hash) regressions.protectedChanges.push(protectedFile.path);
  }
  for (const entrypoint of before.graph.entrypoints) {
    if (!afterFiles.has(entrypoint.path) && !approvedKeys.has(`delete-file:${entrypoint.path}`)) regressions.missingEntrypoints.push(entrypoint.path);
  }
  const beforeOrphans = new Set(before.graph.orphans.map((item) => item.path));
  for (const path of before.graph.moduleFiles) {
    if (beforeOrphans.has(path)) continue;
    if (!afterFiles.has(path) && !approvedKeys.has(`delete-file:${path}`)) regressions.missingReachable.push(path);
  }

  const beforeDecls = declarationMap(before);
  const afterDecls = declarationMap(after);
  for (const [key, beforeRange] of beforeDecls) {
    const [packageDir, name, field] = key.split("\0");
    const afterRange = afterDecls.get(key);
    if (afterRange === beforeRange) continue;
    const allowed = approved.some((mutation) =>
      (mutation.kind === "remove-declaration" || mutation.kind === "move-declaration" || mutation.kind === "change-range") &&
      mutation.packageDir === packageDir && mutation.name === name && mutation.field === field &&
      mutation.beforeRange === beforeRange &&
      (mutation.kind !== "change-range" || mutation.afterRange === afterRange),
    );
    if (!allowed) regressions.unplannedManifestChanges.push(`${packageDir}/package.json:${field}.${name}`);
  }
  for (const [key] of afterDecls) {
    if (beforeDecls.has(key)) continue;
    const [packageDir, name, field] = key.split("\0");
    const allowed = approved.some((mutation) => mutation.kind === "move-declaration" && mutation.packageDir === packageDir && mutation.name === name && mutation.toField === field);
    if (!allowed) regressions.unplannedManifestChanges.push(`${packageDir}/package.json:${field}.${name} added`);
  }
  const afterPackages = new Map(after.packages.map((pkg) => [pkg.dir, pkg]));
  for (const pkg of before.packages) {
    if (!pkg.manifest) continue;
    const current = afterPackages.get(pkg.dir)?.manifest;
    if (!current) continue;
    const expected = expectedManifestAfterSubset(pkg.manifest, current, pkg.dir, approved);
    if (canonicalJson(expected) !== canonicalJson(normalizeManifest(current))) {
      regressions.unplannedManifestChanges.push(`${pkg.dir}/package.json contains changes outside approved dependency mutations`);
    }
  }

  for (const key of Object.keys(regressions) as (keyof VerifyRegressions)[]) {
    const value = regressions[key];
    if (Array.isArray(value)) (regressions[key] as unknown[]) = [...new Map(value.map((item) => [typeof item === "string" ? item : JSON.stringify(item), item])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) as never;
  }
  return regressions;
}

export interface GateSpec {
  name: string;
  command: string[];
  cwd: string;
}

const INSTALL_COMMAND: Record<PackageManager, string[]> = {
  pnpm: ["pnpm", "install", "--frozen-lockfile"],
  npm: ["npm", "ci"],
  yarn: ["yarn", "install", "--immutable"],
  bun: ["bun", "install", "--frozen-lockfile"],
};
const SCRIPT_NAMES = ["typecheck", "check", "lint", "build", "test", "validate"] as const;

export interface GateManifest {
  dir: string;
  scripts: Record<string, string>;
}

function runCommand(manager: PackageManager, dir: string, script: string): string[] {
  if (manager === "npm") return ["npm", "--prefix", dir, "run", script];
  if (manager === "yarn") return ["yarn", "--cwd", dir, "run", script];
  if (manager === "bun") return ["bun", "--cwd", dir, "run", script];
  return ["pnpm", "--dir", dir, "run", script];
}

/** Parse a custom gate without a shell while preserving quoted paths/arguments. */
export function parseGateCommand(raw: string): string[] {
  const args: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of raw.trim()) {
    if (escaped) {
      token += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") escaped = true;
    else if (quote !== null) {
      if (char === quote) quote = null;
      else token += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (/\s/.test(char)) {
      if (token.length > 0) {
        args.push(token);
        token = "";
      }
    } else token += char;
  }
  if (escaped) token += "\\";
  if (quote !== null) throw new Error("unterminated quote in --gate command");
  if (token.length > 0) args.push(token);
  return args;
}

export function pickProjectGates(
  projects: ProjectReport[],
  manifests: GateManifest[],
  flags: { skipInstall: boolean; custom: string[]; skipScripts?: string[] },
): GateSpec[] {
  const gates: GateSpec[] = [];
  for (const project of projects.filter((item) => item.kind !== "unmanaged")) {
    if (project.manager.status !== "resolved" || project.manager.name === null) {
      if (!flags.skipInstall || flags.custom.length === 0) throw new Error(`automatic gates unavailable for ${project.rootDir}: package manager is ${project.manager.status}`);
      continue;
    }
    if (!project.manager.lockfilePath && flags.custom.length === 0) {
      throw new Error(`automatic gates unavailable for ${project.rootDir}: resolved package manager has no tracked lockfile`);
    }
    if (!flags.skipInstall) {
      if (!project.manager.lockfilePath) throw new Error(`frozen install unavailable for ${project.rootDir}: no tracked lockfile`);
      const command = project.manager.name === "yarn" && project.lockfile.dialect === "yarn-classic"
        ? ["yarn", "install", "--frozen-lockfile"]
        : [...INSTALL_COMMAND[project.manager.name]];
      gates.push({ name: `${project.rootDir}:install`, command, cwd: project.rootDir });
    }
    if (flags.custom.length > 0) continue;
    const owned = manifests.filter((manifest) => project.packageDirs.includes(manifest.dir));
    for (const script of SCRIPT_NAMES) {
      if (flags.skipScripts?.includes(script)) continue;
      const root = owned.find((manifest) => manifest.dir === project.rootDir);
      const selected = root?.scripts[script] ? [root] : owned.filter((manifest) => manifest.scripts[script]);
      for (const manifest of selected) gates.push({ name: `${manifest.dir}:${script}`, command: runCommand(project.manager.name, ".", script), cwd: manifest.dir });
    }
  }
  for (const [index, raw] of flags.custom.entries()) {
    const command = parseGateCommand(raw);
    if (command.length > 0) gates.push({ name: `custom-${index + 1}`, command, cwd: "." });
  }
  return gates;
}

/** Backward-compatible unit seam with safe frozen behavior and no npm fallback. */
export function pickGates(
  rootManifest: Record<string, unknown> | null,
  manager: PackageManager | null,
  flags: { skipInstall: boolean; skipTypecheck: boolean; skipBuild: boolean; skipTest: boolean; custom: string[] },
): Omit<GateSpec, "cwd">[] {
  if (manager === null) return [];
  const scriptsRaw = rootManifest?.scripts;
  const scripts = scriptsRaw && typeof scriptsRaw === "object" ? scriptsRaw as Record<string, unknown> : {};
  const project: ProjectReport = {
    rootDir: ".", kind: "standalone", manager: { status: "resolved", name: manager, version: null, source: "single-lockfile", lockfilePath: manager === "npm" ? "package-lock.json" : manager === "pnpm" ? "pnpm-lock.yaml" : manager === "yarn" ? "yarn.lock" : "bun.lock", conflicts: [] },
    workspacePatterns: [], packageDirs: ["."], packageNames: [], workspaceSkew: [], lockfile: { path: "lock", dialect: "test", parseStatus: "parsed", diagnostics: [] }, diagnostics: [],
  };
  return pickProjectGates(project ? [project] : [], [{ dir: ".", scripts: Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string")) }], {
    skipInstall: flags.skipInstall,
    custom: flags.custom,
    skipScripts: [flags.skipTypecheck ? "typecheck" : "", flags.skipBuild ? "build" : "", flags.skipTest ? "test" : ""],
  }).map(({ cwd: _cwd, ...gate }) => gate);
}

export interface VerifyScanOptions { ignore: string[]; entries: string[]; warnings: string[] }

export function resolveVerifyScanOptions(baseline: RepoReport, flagIgnores: string[], flagEntries: string[]): VerifyScanOptions {
  for (const value of flagIgnores) if (!baseline.scanOptions.ignore.includes(value)) throw new Error(`verify cannot add --ignore ${value}; re-run scan and plan with that option`);
  for (const value of flagEntries) if (!baseline.scanOptions.entries.includes(value)) throw new Error(`verify cannot add --entry ${value}; re-run scan and plan with that option`);
  return { ignore: [...baseline.scanOptions.ignore], entries: [...baseline.scanOptions.entries], warnings: [] };
}

export function evaluateVerify(args: {
  mode: "static-only" | "full";
  gates: GateResult[];
  regressions: VerifyRegressions;
  comparison: VerifyResult["comparison"];
  warnings: string[];
  inputs: VerifyResult["inputs"];
  candidateSnapshot: VerifyResult["candidateSnapshot"];
  finalSnapshot: VerifyResult["finalSnapshot"];
  toolVersion: string;
  healthChanges?: VerifyResult["healthChanges"];
}): VerifyResult {
  const regressionCount = Object.values(args.regressions).reduce((sum, value) => sum + value.length, 0);
  const authorizationFailures = [
    ...args.regressions.unauthorizedRemovals,
    ...args.regressions.unauthorizedChanges,
    ...args.regressions.protectedChanges,
    ...args.regressions.unplannedManifestChanges,
  ];
  return {
    version: 2,
    tool: "repo-doctor",
    toolVersion: args.toolVersion,
    createdAt: new Date().toISOString(),
    mode: args.mode,
    ok: args.gates.every((gate) => gate.ok) && regressionCount === 0,
    inputs: args.inputs,
    candidateSnapshot: args.candidateSnapshot,
    finalSnapshot: args.finalSnapshot,
    gates: args.gates,
    regressions: args.regressions,
    healthChanges: args.healthChanges ?? [],
    authorizationFailures,
    comparison: args.comparison,
    warnings: args.warnings,
  };
}
