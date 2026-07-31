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
  RepoReport,
} from "./types.ts";

export interface PlanOptions {
  /** Regex sources; items whose target OR id matches are rescued — kept in the plan, excluded from action counts. */
  keep: string[];
  /** Minimum confidence for an item to appear in the plan at all. */
  minConfidence: Confidence;
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

  const warnings: string[] = [];
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
    // Collision rule: one item per (action, target, packageDir); the strongest
    // confidence wins, and the first writer wins ties (generation order is fixed).
    if (existing && CONFIDENCE_RANK[existing.confidence] >= CONFIDENCE_RANK[confidence]) return;
    byId.set(id, {
      id,
      action,
      target,
      packageDir,
      confidence,
      evidence,
      reclaimBytes,
      rescued: false,
      keepPattern: null,
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
  const hasDynamic = graph.dynamicImporters.length > 0;
  const hasUnresolved = graph.unresolved.length > 0;
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
    } else if (hasDynamic) {
      confidence = "medium";
      evidence += "; repo has dynamic imports — verify none loads this file";
    } else if (hasUnresolved) {
      confidence = "medium";
      evidence += "; repo has unresolved imports — verify none targets this file";
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
        // Unused AND dual-declared: one instruction — drop both entries. A
        // move-dep here would contradict the removal.
        add("remove-dep", name, pkg.dir, "high",
          "declared in both dependencies and devDependencies with no usage evidence — remove both entries", 0);
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
        "high",
        liveImport
          ? "declared in both dependencies and devDependencies — imported by non-test reachable code, keep the dependencies entry"
          : "declared in both dependencies and devDependencies — only test/tooling usage found, keep the devDependencies entry",
        0,
      );
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
    }
  }

  // 6. Workspace version skew.
  for (const skew of [...report.workspaceSkew].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const dirs = Object.keys(skew.ranges).sort();
    const pairs = dirs.map((dir) => `${dir} → ${skew.ranges[dir]}`).join(", ");
    const distinct = new Set(dirs.map((dir) => skew.ranges[dir])).size;
    add("align-versions", skew.name, null, "medium", `${distinct} distinct ranges across the workspace: ${pairs}`, 0);
  }

  // 7. Lockfile multi-version duplicates, worst offenders first.
  const lockDups = [...report.lockfileDuplicates].sort(
    (a, b) => b.versions.length - a.versions.length || (a.name < b.name ? -1 : 1),
  );
  for (const dupEntry of lockDups.slice(0, MAX_LOCKFILE_ITEMS)) {
    const versions = [...dupEntry.versions].sort();
    add("dedupe-lockfile", dupEntry.name, null, "low",
      `${versions.length} resolved versions in the lockfile: ${versions.join(", ")}`, 0);
  }
  if (lockDups.length > MAX_LOCKFILE_ITEMS) {
    const pm = report.packageManager ?? "npm";
    warnings.push(`${lockDups.length - MAX_LOCKFILE_ITEMS} more multi-version deps in the lockfile — run ${pm} dedupe`);
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

  // Rescue pass: --keep patterns match against target and id; rescued items
  // stay in the plan as an audit trail but never count as actions.
  const all = [...byId.values()];
  for (const item of all) {
    const matched = keepRes.find((re) => re.test(item.target) || re.test(item.id));
    if (matched) {
      item.rescued = true;
      item.keepPattern = matched.source;
    }
  }

  // Confidence filter: below-threshold items disappear entirely, but the count is surfaced.
  const minRank = CONFIDENCE_RANK[opts.minConfidence];
  const items = all.filter((i) => CONFIDENCE_RANK[i.confidence] >= minRank);
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

  const actionable = items.filter((i) => !i.rescued);
  const byAction: Record<string, number> = {};
  for (const action of ACTION_ORDER) {
    const count = actionable.filter((i) => i.action === action).length;
    if (count > 0) byAction[action] = count;
  }

  return {
    version: 1,
    tool: "repo-doctor",
    createdAt: new Date().toISOString(),
    options: { keep: [...opts.keep], minConfidence: opts.minConfidence },
    summary: {
      itemsTotal: items.length,
      itemsRescued: items.length - actionable.length,
      deleteFiles: byAction["delete-file"] ?? 0,
      reviewFiles: byAction["review-file"] ?? 0,
      removeDeps: byAction["remove-dep"] ?? 0,
      reclaimBytes: actionable.reduce((sum, i) => sum + i.reclaimBytes, 0),
      byAction,
      warnings,
    },
    items,
  };
}
