/**
 * PLAN — turn a RepoReport into an ordered, evidence-backed CleanupPlan.
 *
 * Pure and deterministic: the same report and options produce an identical
 * plan minus `createdAt`. Every finding-to-action mapping rule lives here;
 * the CLI wrapper only parses flags. Confidence encodes how safe an item is
 * to execute without a human — see references/false-positives.md before
 * acting on medium or low items.
 *
 * File findings run through ordered passes that share ONE claims set — one
 * path, one instruction: sensitive junk first, then other junk, then orphans,
 * then duplicate groups, then unreferenced assets. The first pass to claim a
 * path owns its instruction; later passes skip claimed paths entirely, so a
 * single file can never collect contradictory items.
 */

import type {
  CleanupPlan,
  Confidence,
  DepField,
  DepUsage,
  PlanAction,
  PlanItem,
  PlanDisposition,
  PlannedMutation,
  RepoReport,
} from "./types.ts";
import { canonicalJson, sha256 } from "./artifacts.ts";

export interface PlanOptions {
  /** Regex sources; items whose target OR id matches are rescued — kept in the plan, excluded from action counts. */
  keep: string[];
  /** Minimum confidence for an item to appear in the plan at all. */
  minConfidence: Confidence;
  approve?: string[];
  allowDelete?: string[];
  reportSha256?: string;
}

/** Output group order — mirrors the PlanAction union declaration. */
const ACTION_ORDER: PlanAction[] = [
  "delete-file",
  "review-file",
  "remove-dep",
  "move-dep",
  "add-missing-dep",
  "align-versions",
  "dedupe-lockfile",
  "untrack-and-gitignore",
  "consolidate-overlap",
  "review-sensitive",
];

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

/** Removing an unused dep is safest for dev tooling, riskiest for runtime deps. */
const UNUSED_CONFIDENCE: Record<DepField, Confidence> = {
  dependencies: "medium",
  devDependencies: "high",
  peerDependencies: "low",
  optionalDependencies: "low",
};

/** dedupe-lockfile items are capped so huge repos stay readable; the rest becomes a warning. */
const MAX_LOCKFILE_ITEMS = 20;

/** Path segments that mark a module file as test/tooling rather than shipped code. */
const TEST_SEGMENTS = new Set(["__tests__", "tests", "test", "e2e", "cypress", "playwright"]);

/** Warning emitted once when orphan analysis ran without any usable root. */
const NO_ENTRYPOINT_WARNING =
  "no module entrypoints discovered — orphan findings are unreliable; re-scan with --entry";

function isTestLikePath(path: string): boolean {
  const segments = path.split("/");
  const base = segments[segments.length - 1];
  return /\.(test|spec)\./.test(base) || segments.some((s) => TEST_SEGMENTS.has(s));
}

/** LICENSE-family and ignore files are duplicated across packages on purpose. */
function isDeliberateDuplicateBasename(path: string): boolean {
  const segments = path.split("/");
  const base = segments[segments.length - 1].toLowerCase();
  if (base === ".gitignore" || base === ".npmignore" || base === "patents") return true;
  return base.startsWith("license") || base.startsWith("notice") || base.startsWith("copying");
}

function unusedEvidence(d: DepUsage): string {
  switch (d.field) {
    case "devDependencies":
      return `declared in devDependencies (${d.range}) with no imports, no text mentions, and no implicit-use rule`;
    case "dependencies":
      return `declared in dependencies (${d.range}) with no usage evidence — runtime loading can hide usage, verify before removing`;
    default:
      return `declared in ${d.field} (${d.range}) with no usage evidence — often satisfied by a plugin host, remove with care`;
  }
}

/**
 * Compute the cleanup plan from a scan report.
 *
 * reclaimBytes is set only where the proposed action itself frees the bytes
 * (delete-file, untrack-and-gitignore) — review items carry their size in the
 * evidence string instead, so the summary never overpromises.
 */
export function buildPlan(report: RepoReport, opts: PlanOptions): CleanupPlan {
  const keepRes = opts.keep.map((source) => {
    try {
      return new RegExp(source);
    } catch (err) {
      throw new Error(`invalid --keep pattern ${JSON.stringify(source)}: ${(err as Error).message}`);
    }
  });

  const warnings: string[] = [...report.warnings];
  const byId = new Map<string, PlanItem>();
  const add = (
    action: PlanAction,
    target: string,
    packageDir: string | null,
    confidence: Confidence,
    evidence: string,
    reclaimBytes: number,
  ): void => {
    const id = packageDir == null ? `${action}:${target}` : `${action}:${target}:${packageDir}`;
    const existing = byId.get(id);
    // Collision rule is fail-safe: the least confident declaration/context
    // wins. A peer/optional declaration can never be upgraded by a dev entry.
    if (existing && CONFIDENCE_RANK[existing.confidence] <= CONFIDENCE_RANK[confidence]) return;
    const file = report.files.find((candidate) => candidate.path === target);
    const depDeclarations = packageDir === null
      ? []
      : report.packages.find((pkg) => pkg.dir === packageDir)?.deps.filter((dep) => dep.name === target) ?? [];
    const mutations: PlannedMutation[] = [];
    if (action === "delete-file" && file) mutations.push({ kind: "delete-file", path: target, beforeHash: file.hash });
    if (action === "untrack-and-gitignore" && file) {
      const ignoreFile = report.files.find((candidate) => candidate.path === ".gitignore");
      mutations.push({
        kind: "untrack-file",
        path: target,
        beforeHash: file.hash,
        ignorePath: ".gitignore",
        ignorePattern: target,
        ignoreBeforeHash: ignoreFile?.hash ?? null,
      });
    }
    if (action === "remove-dep" && packageDir !== null) {
      for (const dep of depDeclarations) mutations.push({ kind: "remove-declaration", packageDir, name: target, field: dep.field, beforeRange: dep.range });
    }
    if (action === "move-dep" && packageDir !== null && depDeclarations.length > 0) {
      const runtime = depDeclarations.find((dep) => dep.field === "dependencies");
      const dev = depDeclarations.find((dep) => dep.field === "devDependencies");
      const keepRuntime = evidence.includes("non-test reachable");
      const remove = keepRuntime ? dev : runtime;
      const keep = keepRuntime ? runtime : dev;
      if (remove && keep) mutations.push({ kind: "move-declaration", packageDir, name: target, field: remove.field, beforeRange: remove.range, toField: keep.field, afterRange: keep.range });
    }
    const baseDisposition: PlanDisposition =
      action === "review-sensitive" ? "blocked"
        : mutations.length === 0 ? "review-only"
          : confidence === "high" ? "proposed"
            : confidence === "medium" ? "manual"
              : "review-only";
    byId.set(id, {
      id,
      action,
      target,
      packageDir,
      confidence,
      evidence,
      evidenceItems: [evidence],
      reclaimBytes,
      rescued: false,
      keepPattern: null,
      disposition: baseDisposition,
      prerequisites: [],
      relatedTargets: [],
      decision: {
        status: baseDisposition === "blocked" ? "blocked" : "pending",
        source: baseDisposition === "blocked" ? "planner-policy" : null,
        value: baseDisposition === "blocked" ? "sensitive-or-incomplete" : null,
      },
      mutations,
    });
  };

  const graph = report.graph;
  const moduleFileSet = new Set(graph.moduleFiles);
  const entrypointSet = new Set(graph.entrypoints.map((e) => e.path));
  const orphanSet = new Set(graph.orphans.map((o) => o.path));
  const assetSet = new Set(report.unreferencedAssets.map((a) => a.path));
  const symlinkSet = new Set(report.files.filter((f) => f.symlink).map((f) => f.path));
  const backupSet = new Set(report.junk.filter((j) => j.category === "backup-copy").map((j) => j.path));

  /** Parsed as a module and reachable (not an orphan). Entrypoints rank separately. */
  const isReachableModuleFile = (path: string): boolean =>
    moduleFileSet.has(path) && !orphanSet.has(path);
  /** Live in the module graph: a reachable module file, or an entrypoint. */
  const isReachableModule = (path: string): boolean =>
    isReachableModuleFile(path) || entrypointSet.has(path);

  // One path = one instruction. Every file-item pass below consults and
  // updates this set; the first pass to claim a path owns its instruction.
  const claimed = new Set<string>();

  const sortedJunk = [...report.junk].sort((a, b) => (a.path < b.path ? -1 : 1));

  // P0. Sensitive files: reported for review, never routed to any delete action.
  for (const j of sortedJunk) {
    if (j.category !== "sensitive" || claimed.has(j.path)) continue;
    add("review-sensitive", j.path, null, "high",
      "may contain secrets — never auto-delete; rotate credentials, untrack, and gitignore", 0);
    claimed.add(j.path);
  }

  // P1. Other committed junk, routed by category — with a reachability veto:
  // when the module graph proves a junk-named path is live code, a filename
  // pattern must never order its removal.
  const alsoOrphan = (path: string): string =>
    orphanSet.has(path) ? "; it is also unreachable in the module graph" : "";
  for (const j of sortedJunk) {
    if (j.category === "sensitive" || claimed.has(j.path)) continue;
    if (isReachableModule(j.path)) {
      add("review-file", j.path, null, "medium",
        `flagged as ${j.category} (${j.pattern}, ${j.bytes} bytes) but the module graph proves it reachable — review instead of removing`, 0);
      claimed.add(j.path);
      continue;
    }
    switch (j.category) {
      case "build-artifact":
        add("untrack-and-gitignore", j.path, null, "high",
          `committed build artifact (${j.pattern}, ${j.bytes} bytes) — belongs in .gitignore, not in git${alsoOrphan(j.path)}`, j.bytes);
        break;
      case "log":
        add("untrack-and-gitignore", j.path, null, "high",
          `committed log file (${j.pattern}, ${j.bytes} bytes) — belongs in .gitignore, not in git`, j.bytes);
        break;
      case "cache":
        add("untrack-and-gitignore", j.path, null, "high",
          `committed cache (${j.pattern}, ${j.bytes} bytes) — belongs in .gitignore, not in git`, j.bytes);
        break;
      case "os-or-editor": {
        const segments = j.path.split("/");
        if (segments.includes(".idea") || segments.includes(".vscode")) {
          add("review-file", j.path, null, "medium",
            `editor project config (${j.pattern}, ${j.bytes} bytes) — sometimes committed on purpose, review before untracking`, 0);
        } else {
          add("untrack-and-gitignore", j.path, null, "high",
            `OS or editor dropping (${j.pattern}, ${j.bytes} bytes) — belongs in .gitignore, not in git`, j.bytes);
        }
        break;
      }
      case "backup-copy":
        // A backup-named orphan merges into the orphan item in the next pass —
        // leave it unclaimed so that pass can pick it up.
        if (orphanSet.has(j.path)) continue;
        add("delete-file", j.path, null, "medium",
          `filename marks it as a backup copy (${j.pattern}, ${j.bytes} bytes) — confirm the original supersedes it`, j.bytes);
        break;
      case "generated":
        add("untrack-and-gitignore", j.path, null, "medium",
          `generated file (${j.pattern}, ${j.bytes} bytes) — usually rebuilt from source, belongs in .gitignore`, j.bytes);
        break;
      case "binary-or-archive":
        add("review-file", j.path, null, "medium",
          `binary or archive (${j.pattern}, ${j.bytes} bytes) — confirm it must live in git`, 0);
        break;
    }
    claimed.add(j.path);
  }

  // P2. Orphan modules: unreachable from every entrypoint. When the graph has
  // no module entrypoint at all, "unreachable" is meaningless — cap everything
  // at low and say so.
  const moduleEntrypoints = graph.entrypoints.filter((e) => moduleFileSet.has(e.path)).length;
  const zeroEntrypoints = moduleEntrypoints === 0;
  const sortedOrphans = [...graph.orphans].sort((a, b) => (a.path < b.path ? -1 : 1));
  if (zeroEntrypoints && sortedOrphans.length > 0) warnings.push(NO_ENTRYPOINT_WARNING);
  const owningPackageDir = (path: string): string =>
    [...report.packages]
      .filter((pkg) => pkg.dir === "." || path.startsWith(`${pkg.dir}/`))
      .sort((a, b) => b.dir.length - a.dir.length)[0]?.dir ?? ".";
  for (const orphan of sortedOrphans) {
    if (claimed.has(orphan.path)) continue;
    const referencedBy = [...orphan.pathReferencedBy].sort();
    if (referencedBy.length > 0 || orphan.hasShebang) {
      // Rescue tier: outside-the-graph evidence says this "orphan" is used.
      const reasons: string[] = [];
      if (referencedBy.length > 0) reasons.push(`its path is referenced by ${referencedBy[0]}`);
      if (orphan.hasShebang) reasons.push("it starts with a shebang (likely a manually invoked script)");
      add("review-file", orphan.path, null, zeroEntrypoints ? "low" : "medium",
        `unreachable in the import graph but ${reasons.join(" and ")} — review before deleting`, 0);
      claimed.add(orphan.path);
      continue;
    }
    let confidence: Confidence = "high";
    let evidence: string;
    if (zeroEntrypoints) {
      evidence = "flagged unreachable, but no module entrypoints were discovered so reachability is unknown";
    } else {
      evidence =
        graph.entrypoints.length === 1
          ? "unreachable from the only entrypoint"
          : `unreachable from all ${graph.entrypoints.length} entrypoints`;
    }
    if (orphan.importers.length > 0) {
      evidence += ` (imported only by ${orphan.importers.length} fellow orphan${orphan.importers.length === 1 ? "" : "s"})`;
    }
    if (backupSet.has(orphan.path)) {
      // A dead file that is ALSO named like a backup stays high confidence even
      // when dynamic imports would normally soften the verdict. The junk pass
      // above skips these paths, so the two signals merge into this one item.
      evidence += "; the filename also marks it as a backup copy";
    } else if (graph.dynamicImporters.some((path) => owningPackageDir(path) === owningPackageDir(orphan.path))) {
      confidence = "medium";
      evidence += "; its package has dynamic imports — verify none loads this file";
    } else if (graph.unresolved.some((item) => owningPackageDir(item.from) === owningPackageDir(orphan.path))) {
      confidence = "medium";
      evidence += "; its package has unresolved imports — verify none targets this file";
    }
    if (zeroEntrypoints) confidence = "low";
    add("delete-file", orphan.path, null, confidence, evidence, orphan.bytes);
    claimed.add(orphan.path);
  }

  // P3. Duplicate groups: pick ONE survivor by liveness rank; symlink members
  // are skipped entirely. Deletion is only high-confidence when the copy is
  // provably referenced nowhere — never on lexicographic order.
  const duplicateRank = (path: string): number =>
    isReachableModuleFile(path) ? 0 : entrypointSet.has(path) ? 1 : assetSet.has(path) ? 3 : 2;
  for (const group of report.duplicateGroups) {
    const members = [...group.paths].sort().filter((p) => !symlinkSet.has(p));
    if (members.length < 2) continue;
    let survivor = members[0];
    for (const m of members) if (duplicateRank(m) < duplicateRank(survivor)) survivor = m;
    for (const path of members) {
      if (path === survivor || claimed.has(path)) continue;
      if (isDeliberateDuplicateBasename(path)) {
        add("review-file", path, null, "low",
          `byte-identical to ${survivor} (${group.bytes} bytes) but this basename is a deliberate per-package duplicate — keep unless consolidating packages`, 0);
      } else if (assetSet.has(path)) {
        add("delete-file", path, null, "high",
          `byte-identical to ${survivor} (${group.bytes} bytes) and referenced nowhere`, group.bytes);
      } else if (isReachableModuleFile(path)) {
        add("review-file", path, null, "medium",
          `byte-identical to ${survivor} but imported by reachable code — consolidate importers first`, 0);
      } else if (entrypointSet.has(path)) {
        add("review-file", path, null, "medium",
          `byte-identical to ${survivor} (${group.bytes} bytes) but it is an entrypoint — review instead of deleting`, 0);
      } else {
        // Reference status unknown — never high.
        add("delete-file", path, null, "medium",
          `byte-identical to ${survivor} (${group.bytes} bytes); reference status unknown — grep for the path before deleting`, group.bytes);
      }
      claimed.add(path);
    }
  }

  // P4. Unreferenced assets — always a human look; references hide in CMS content and built URLs.
  for (const asset of [...report.unreferencedAssets].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (claimed.has(asset.path)) continue;
    add("review-file", asset.path, null, "low", `${asset.reason} (${asset.bytes} bytes)`, 0);
    claimed.add(asset.path);
  }

  // 5. Per-package dependency findings.
  for (const pkg of [...report.packages].sort((a, b) => (a.dir < b.dir ? -1 : 1))) {
    const dualSet = new Set(pkg.dualDeclared);
    const unusedSet = new Set(pkg.unused);
    for (const name of [...pkg.unused].sort()) {
      if (dualSet.has(name)) {
        add("remove-dep", name, pkg.dir, "medium",
          "declared in multiple dependency fields with no usage evidence — least-safe runtime declaration controls; review exact removals", 0);
        continue;
      }
      const declared = pkg.deps
        .filter((d) => d.name === name)
        .sort((a, b) => (a.field < b.field ? -1 : 1));
      if (declared.length === 0) {
        add("remove-dep", name, pkg.dir, "medium", "declared but no usage evidence found", 0);
        continue;
      }
      for (const d of declared) add("remove-dep", name, pkg.dir, UNUSED_CONFIDENCE[d.field], unusedEvidence(d), 0);
    }
    for (const name of [...pkg.dualDeclared].sort()) {
      if (unusedSet.has(name)) continue; // handled above as a single remove-dep
      const usedBy = new Set(pkg.deps.filter((d) => d.name === name).flatMap((d) => d.usedBy));
      const liveImport = [...usedBy].some((f) => !orphanSet.has(f) && !isTestLikePath(f));
      add(
        "move-dep",
        name,
        pkg.dir,
        "medium",
        liveImport
          ? "declared in both dependencies and devDependencies — imported by non-test reachable code, keep the dependencies entry"
          : "declared in both dependencies and devDependencies — only test/tooling usage found, keep the devDependencies entry",
        0,
      );
    }
    for (const name of [...(pkg.orphanOnly ?? [])].sort()) {
      const importers = pkg.deps.filter((dep) => dep.name === name).flatMap((dep) => dep.usedBy);
      add("remove-dep", name, pkg.dir, "low",
        `used only by current orphan modules (${importers.slice(0, 3).join(", ")}) — remove approved files, then re-scan before changing this declaration`, 0);
      const item = byId.get(`remove-dep:${name}:${pkg.dir}`);
      if (item) {
        item.disposition = "deferred";
        item.mutations = [];
        item.prerequisites = importers.map((path) => `delete-file:${path}`).filter((id) => byId.has(id));
        item.decision = { status: "blocked", source: "planner-policy", value: "fresh-scan-required" };
      }
    }
    for (const name of [...(pkg.uncertain ?? [])].sort()) {
      add("remove-dep", name, pkg.dir, "low", "usage is uncertain because this package owns non-literal dynamic loading; destructive dependency advice is blocked", 0);
      const item = byId.get(`remove-dep:${name}:${pkg.dir}`);
      if (item) {
        item.disposition = "blocked";
        item.mutations = [];
        item.decision = { status: "blocked", source: "planner-policy", value: "dynamic-analysis-incomplete" };
      }
    }
    for (const missing of [...pkg.missing].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const importers = [...missing.importers].sort();
      const count = `${importers.length} file${importers.length === 1 ? "" : "s"}`;
      const allOrphanImporters = importers.length > 0 && importers.every((f) => orphanSet.has(f));
      if (allOrphanImporters) {
        add("add-missing-dep", missing.name, pkg.dir, "low",
          `only imported by files this plan deletes (${count}, e.g. ${importers[0]}) — delete those first and re-scan`, 0);
      } else if (missing.declaredIn == null) {
        const example = importers.length > 0 ? ` (e.g. ${importers[0]})` : "";
        add("add-missing-dep", missing.name, pkg.dir, "high", `imported by ${count}${example} but declared in no manifest`, 0);
      } else {
        add("add-missing-dep", missing.name, pkg.dir, "low",
          `imported by ${count} — works via hoisting from ${missing.declaredIn} — declare explicitly`, 0);
      }
      const missingItem = byId.get(`add-missing-dep:${missing.name}:${pkg.dir}`);
      if (missingItem) {
        missingItem.disposition = allOrphanImporters ? "deferred" : "manual";
        missingItem.decision = allOrphanImporters
          ? { status: "blocked", source: "planner-policy", value: "fresh-scan-required" }
          : { status: "pending", source: null, value: null };
        missingItem.prerequisites = allOrphanImporters
          ? importers.map((path) => `delete-file:${path}`).filter((id) => byId.has(id))
          : [];
      }
    }
  }

  // 6. Workspace version skew.
  for (const skew of [...report.workspaceSkew].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const dirs = Object.keys(skew.ranges).sort();
    const pairs = dirs.map((dir) => `${dir} → ${skew.ranges[dir]}`).join(", ");
    const distinct = new Set(dirs.map((dir) => skew.ranges[dir])).size;
    add("align-versions", skew.name, skew.projectRoot ?? null, "medium", `${distinct} distinct ranges across the workspace: ${pairs}`, 0);
  }

  // 7. Lockfile multi-version duplicates, worst offenders first.
  const lockScopes = report.projects.some((project) => project.lockfileDuplicates !== undefined)
    ? report.projects.map((project) => ({ target: project.lockfile.path, duplicates: project.lockfileDuplicates ?? [] }))
    : [{ target: report.lockfileKind, duplicates: report.lockfileDuplicates }];
  for (const scope of lockScopes) {
    const lockDups = [...scope.duplicates].sort((a, b) => b.versions.length - a.versions.length || (a.name < b.name ? -1 : 1));
    if (lockDups.length === 0) continue;
    const lockTarget = scope.target ?? "lockfile";
    const shown = lockDups.slice(0, MAX_LOCKFILE_ITEMS);
    add("dedupe-lockfile", lockTarget, null, "low",
      `${lockDups.length} dependency names resolve to multiple versions; review as one project-level lockfile operation (${shown.map((entry) => entry.name).join(", ")}${lockDups.length > shown.length ? ", …" : ""})`, 0);
    const item = byId.get(`dedupe-lockfile:${lockTarget}`);
    if (item) item.relatedTargets = lockDups.map((entry) => entry.name);
  }

  // 8. Overlapping same-purpose package families.
  const overlaps = [...report.overlaps].sort(
    (a, b) =>
      (a.packageDir < b.packageDir ? -1 : a.packageDir > b.packageDir ? 1 : 0) ||
      (a.family < b.family ? -1 : 1),
  );
  for (const overlap of overlaps) {
    const packages = [...overlap.packages].sort();
    add("consolidate-overlap", overlap.family, overlap.packageDir, "low",
      `${packages.length} ${overlap.family} in one manifest (${packages.join(", ")}) — ${overlap.hint}`, 0);
  }

  // Incomplete diagnostics block only their affected scope. Repo-scoped
  // dependency/graph failures block all related destructive items.
  for (const item of byId.values()) {
    const blocking = report.diagnostics.filter((diagnostic) => {
      if (diagnostic.severity !== "error") return false;
      if (item.packageDir !== null && !diagnostic.affects.includes("dependencies")) return false;
      if (item.packageDir === null && !diagnostic.affects.includes("graph") && !diagnostic.affects.includes("inventory")) return false;
      if (diagnostic.scope.kind === "repo") return true;
      if (diagnostic.scope.kind === "file") {
        if (diagnostic.scope.path === item.target) return true;
        return item.packageDir !== null && (item.packageDir === "." || diagnostic.scope.path.startsWith(`${item.packageDir}/`));
      }
      if (item.packageDir === null) return false;
      return item.packageDir === diagnostic.scope.path || item.packageDir.startsWith(`${diagnostic.scope.path}/`);
    });
    const project = item.packageDir === null ? null : report.projects.find((candidate) => candidate.packageDirs.includes(item.packageDir!));
    if (project?.kind === "unmanaged" || project?.manager.status === "ambiguous" || blocking.length > 0) {
      item.disposition = "blocked";
      item.decision = { status: "blocked", source: "planner-policy", value: project?.kind === "unmanaged" ? "unmanaged-project" : blocking[0]?.code ?? "ambiguous-project" };
      item.mutations = [];
      item.evidenceItems.push(...blocking.map((diagnostic) => diagnostic.message));
    }
  }

  const sensitive = new Set(report.junk.filter((item) => item.category === "sensitive").map((item) => item.path));
  for (const path of opts.allowDelete ?? []) {
    if (sensitive.has(path)) throw new Error(`--allow-delete cannot authorize sensitive path: ${path}`);
    const file = report.files.find((candidate) => candidate.path === path);
    if (!file) throw new Error(`unknown --allow-delete path: ${path}`);
    if (!entrypointSet.has(path) && !isReachableModuleFile(path)) {
      throw new Error(`--allow-delete is only for an entrypoint or baseline-reachable module: ${path}`);
    }
    const id = `delete-file:${path}`;
    if (!byId.has(id)) add("delete-file", path, null, "high", "exact deletion explicitly reviewed with --allow-delete", file.bytes);
    const item = byId.get(id)!;
    item.disposition = "proposed";
    item.decision = { status: "approved", source: "allow-delete", value: path };
    item.mutations = [{ kind: "delete-file", path, beforeHash: file.hash }];
  }

  // Rescue pass: --keep patterns match against target and id; rescued items
  // stay in the plan as an audit trail but never count as actions.
  const all = [...byId.values()];
  for (const item of all) {
    const matched = keepRes.find((re) =>
      re.test(item.target) || re.test(item.id) || item.relatedTargets.some((target) => re.test(target)),
    );
    if (matched) {
      item.rescued = true;
      item.keepPattern = matched.source;
      item.disposition = "review-only";
      item.decision = { status: "kept", source: "keep-pattern", value: matched.source };
      item.mutations = [];
    }
  }

  const approved = new Set(opts.approve ?? []);
  for (const id of approved) {
    const item = byId.get(id);
    if (!item) throw new Error(`unknown --approve item id: ${id}`);
    if (item.rescued) continue; // --keep wins
    if (item.mutations.length === 0 || item.disposition === "blocked" || item.disposition === "deferred" || item.disposition === "review-only") {
      throw new Error(`item cannot be approved because it has no concrete safe mutation: ${id}`);
    }
    item.decision = { status: "approved", source: "approve-id", value: id };
  }

  // Confidence filtering applies only to eligible recommendations. Review-only,
  // deferred, blocked, rescued, and diagnostic-bearing items stay visible.
  const minRank = CONFIDENCE_RANK[opts.minConfidence];
  const items = all.filter((i) =>
    i.rescued || i.decision.status === "approved" || i.disposition === "review-only" || i.disposition === "deferred" || i.disposition === "blocked" || CONFIDENCE_RANK[i.confidence] >= minRank,
  );
  const filtered = all.length - items.length;
  if (filtered > 0) {
    warnings.push(
      `${filtered} item${filtered === 1 ? "" : "s"} below --min-confidence ${opts.minConfidence} filtered out of the plan`,
    );
  }

  items.sort(
    (a, b) =>
      ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action) ||
      CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
      (a.target < b.target ? -1 : a.target > b.target ? 1 : 0) ||
      ((a.packageDir ?? "") < (b.packageDir ?? "") ? -1 : (a.packageDir ?? "") > (b.packageDir ?? "") ? 1 : 0),
  );

  const actionable = items.filter((i) => !i.rescued && (i.disposition === "proposed" || i.disposition === "manual") && i.mutations.length > 0);
  const byAction: Record<string, number> = {};
  for (const action of ACTION_ORDER) {
    const count = actionable.filter((i) => i.action === action).length;
    if (count > 0) byAction[action] = count;
  }

  const byDisposition = { proposed: 0, manual: 0, "review-only": 0, deferred: 0, blocked: 0 } satisfies Record<PlanDisposition, number>;
  for (const item of items) byDisposition[item.disposition] += 1;
  const approvedFileMutations = new Set(items.filter((item) => item.decision.status === "approved").flatMap((item) => item.mutations).filter((mutation) => mutation.kind === "delete-file" || mutation.kind === "untrack-file").map((mutation) => mutation.path));
  const protectedReasons = new Map<string, Set<string>>();
  const protect = (path: string, reason: string): void => {
    if (approvedFileMutations.has(path)) return;
    protectedReasons.set(path, new Set([...(protectedReasons.get(path) ?? []), reason]));
  };
  for (const item of items) {
    if (item.packageDir === null && report.files.some((file) => file.path === item.target) && item.decision.status !== "approved") protect(item.target, `${item.disposition}:${item.id}`);
  }
  for (const entrypoint of report.graph.entrypoints) protect(entrypoint.path, `entrypoint:${entrypoint.reason}`);
  for (const path of sensitive) protect(path, "sensitive");
  const protectedFiles = [...protectedReasons.entries()].map(([path, reasons]) => ({ path, hash: report.files.find((file) => file.path === path)?.hash ?? "missing", reasons: [...reasons].sort() })).sort((a, b) => a.path.localeCompare(b.path));

  return {
    version: 2,
    tool: "repo-doctor",
    toolVersion: report.toolVersion,
    createdAt: new Date().toISOString(),
    source: {
      reportSha256: opts.reportSha256 ?? sha256(canonicalJson({ source: report.source, scanOptionsDigest: report.scanOptionsDigest, toolVersion: report.toolVersion })),
      repositoryId: report.source.repository.id,
      baselineHead: report.source.repository.head,
      inventoryDigest: report.source.inventoryDigest,
      indexDigest: report.source.indexDigest,
      scanOptionsDigest: report.scanOptionsDigest,
      toolVersion: report.toolVersion,
    },
    options: { keep: [...opts.keep], approve: [...(opts.approve ?? [])], allowDelete: [...(opts.allowDelete ?? [])], minConfidence: opts.minConfidence },
    diagnostics: [...report.diagnostics],
    protectedFiles,
    summary: {
      itemsTotal: items.length,
      itemsRescued: items.filter((item) => item.rescued).length,
      deleteFiles: byAction["delete-file"] ?? 0,
      reviewFiles: byAction["review-file"] ?? 0,
      removeDeps: byAction["remove-dep"] ?? 0,
      reclaimBytes: actionable.reduce((sum, i) => sum + i.reclaimBytes, 0),
      byAction,
      byDisposition,
      warnings,
    },
    items,
  };
}
