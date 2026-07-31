#!/usr/bin/env -S node

// scripts/plan.ts
import { resolve as resolve2 } from "node:path";
import { realpathSync as realpathSync4 } from "node:fs";
import { parseArgs } from "node:util";

// scripts/lib/artifacts.ts
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
var MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
var ArtifactError = class extends Error {
};
function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function canonicalJson(value) {
  const visit = (input) => {
    if (Array.isArray(input)) return input.map(visit);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, visit(child)])
      );
    }
    return input;
  };
  return JSON.stringify(visit(value));
}
function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
function existingAncestor(path) {
  let current = path;
  while (!pathEntryExists(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}
function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
function rejectSymlinkComponents(root, candidate, allowOutside) {
  const start = !allowOutside && isWithin(root, candidate) ? root : parse(candidate).root;
  const rel = relative(start, candidate);
  let cursor = start;
  if (lstatSync(cursor).isSymbolicLink()) throw new ArtifactError(`artifact path contains a symlink: ${cursor}`);
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    if (!pathEntryExists(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) throw new ArtifactError(`artifact path contains a symlink: ${cursor}`);
  }
}
function resolveSafePath(path, options) {
  const root = realpathSync(resolve(options.cwd));
  const candidate = resolve(root, path);
  if (!options.allowOutside && !isWithin(root, candidate)) {
    throw new ArtifactError(`artifact path escapes target repository: ${candidate}`);
  }
  const ancestor = existingAncestor(candidate);
  const ancestorReal = realpathSync(ancestor);
  if (!options.allowOutside && !isWithin(root, ancestorReal)) {
    throw new ArtifactError(`artifact path resolves outside target repository: ${candidate}`);
  }
  rejectSymlinkComponents(root, candidate, options.allowOutside ?? false);
  if (options.rejectTracked && isWithin(root, candidate)) {
    const repoRelative = relative(root, candidate).replace(/\\/g, "/");
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", "--", repoRelative], {
        cwd: root,
        stdio: "ignore"
      });
      throw new ArtifactError(`refusing to overwrite tracked artifact path: ${repoRelative}`);
    } catch (error) {
      if (error instanceof ArtifactError) throw error;
    }
  }
  return candidate;
}
function readJsonArtifact(path, options) {
  const safe = resolveSafePath(path, options);
  const stat = lstatSync(safe);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ArtifactError(`artifact input must be a regular non-symlink file: ${safe}`);
  }
  if (stat.size > MAX_ARTIFACT_BYTES) {
    throw new ArtifactError(`artifact exceeds ${MAX_ARTIFACT_BYTES} byte limit: ${safe}`);
  }
  const bytes = readFileSync(safe);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new ArtifactError(`artifact is not valid JSON: ${safe} \u2014 ${error.message}`);
  }
  return { value, text: bytes.toString("utf8"), digest: sha256(bytes), path: safe };
}
function ensureSafeDirectories(root, parent, allowOutside) {
  if (!allowOutside && !isWithin(root, parent)) {
    throw new ArtifactError(`artifact parent escapes target repository: ${parent}`);
  }
  const missing = [];
  let cursor = parent;
  while (!existsSync(cursor)) {
    missing.push(cursor);
    cursor = dirname(cursor);
  }
  if (lstatSync(cursor).isSymbolicLink()) throw new ArtifactError(`artifact parent is a symlink: ${cursor}`);
  for (const dir of missing.reverse()) {
    mkdirSync(dir, { mode: 448 });
    if (lstatSync(dir).isSymbolicLink()) throw new ArtifactError(`artifact parent became a symlink: ${dir}`);
  }
}
function writeArtifactAtomic(path, content, options) {
  const root = realpathSync(resolve(options.cwd));
  const safe = resolveSafePath(path, { ...options, rejectTracked: options.rejectTracked ?? true });
  const parent = dirname(safe);
  ensureSafeDirectories(root, parent, options.allowOutside ?? false);
  const parentBefore = realpathSync(parent);
  if (existsSync(safe)) {
    const stat = lstatSync(safe);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new ArtifactError(`artifact destination must be a regular non-symlink file: ${safe}`);
    }
  }
  const temp = `${safe}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
  let fd = null;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 384);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (realpathSync(parent) !== parentBefore || lstatSync(parent).isSymbolicLink()) {
      throw new ArtifactError(`artifact parent changed during write: ${parent}`);
    }
    renameSync(temp, safe);
    try {
      const parentFd = openSync(parent, constants.O_RDONLY);
      fsyncSync(parentFd);
      closeSync(parentFd);
    } catch {
    }
    return safe;
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}
function assertDistinctArtifactPaths(paths) {
  const normalized = paths.map((path) => resolve(path));
  if (new Set(normalized).size !== normalized.length) {
    throw new ArtifactError("artifact input and output paths must be distinct");
  }
}

// scripts/lib/planner.ts
var ACTION_ORDER = [
  "delete-file",
  "review-file",
  "remove-dep",
  "move-dep",
  "add-missing-dep",
  "align-versions",
  "dedupe-lockfile",
  "untrack-and-gitignore",
  "consolidate-overlap",
  "review-sensitive"
];
var CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };
var UNUSED_CONFIDENCE = {
  dependencies: "medium",
  devDependencies: "high",
  peerDependencies: "low",
  optionalDependencies: "low"
};
var MAX_LOCKFILE_ITEMS = 20;
var TEST_SEGMENTS = /* @__PURE__ */ new Set(["__tests__", "tests", "test", "e2e", "cypress", "playwright"]);
var NO_ENTRYPOINT_WARNING = "no module entrypoints discovered \u2014 orphan findings are unreliable; re-scan with --entry";
function isTestLikePath(path) {
  const segments = path.split("/");
  const base = segments[segments.length - 1];
  return /\.(test|spec)\./.test(base) || segments.some((s) => TEST_SEGMENTS.has(s));
}
function isDeliberateDuplicateBasename(path) {
  const segments = path.split("/");
  const base = segments[segments.length - 1].toLowerCase();
  if (base === ".gitignore" || base === ".npmignore" || base === "patents") return true;
  return base.startsWith("license") || base.startsWith("notice") || base.startsWith("copying");
}
function unusedEvidence(d) {
  switch (d.field) {
    case "devDependencies":
      return `declared in devDependencies (${d.range}) with no imports, no text mentions, and no implicit-use rule`;
    case "dependencies":
      return `declared in dependencies (${d.range}) with no usage evidence \u2014 runtime loading can hide usage, verify before removing`;
    default:
      return `declared in ${d.field} (${d.range}) with no usage evidence \u2014 often satisfied by a plugin host, remove with care`;
  }
}
function buildPlan(report, opts) {
  const keepRes = opts.keep.map((source) => {
    try {
      return new RegExp(source);
    } catch (err) {
      throw new Error(`invalid --keep pattern ${JSON.stringify(source)}: ${err.message}`);
    }
  });
  const warnings = [...report.warnings];
  const byId = /* @__PURE__ */ new Map();
  const add = (action, target, packageDir, confidence, evidence, reclaimBytes) => {
    const id = packageDir == null ? `${action}:${target}` : `${action}:${target}:${packageDir}`;
    const existing = byId.get(id);
    if (existing && CONFIDENCE_RANK[existing.confidence] <= CONFIDENCE_RANK[confidence]) return;
    const file = report.files.find((candidate) => candidate.path === target);
    const depDeclarations = packageDir === null ? [] : report.packages.find((pkg) => pkg.dir === packageDir)?.deps.filter((dep) => dep.name === target) ?? [];
    const mutations = [];
    if (action === "delete-file" && file) mutations.push({ kind: "delete-file", path: target, beforeHash: file.hash });
    if (action === "untrack-and-gitignore" && file) {
      const ignoreFile = report.files.find((candidate) => candidate.path === ".gitignore");
      mutations.push({
        kind: "untrack-file",
        path: target,
        beforeHash: file.hash,
        ignorePath: ".gitignore",
        ignorePattern: target,
        ignoreBeforeHash: ignoreFile?.hash ?? null
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
    const baseDisposition = action === "review-sensitive" ? "blocked" : mutations.length === 0 ? "review-only" : confidence === "high" ? "proposed" : confidence === "medium" ? "manual" : "review-only";
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
        value: baseDisposition === "blocked" ? "sensitive-or-incomplete" : null
      },
      mutations
    });
  };
  const graph = report.graph;
  const moduleFileSet = new Set(graph.moduleFiles);
  const entrypointSet = new Set(graph.entrypoints.map((e) => e.path));
  const orphanSet = new Set(graph.orphans.map((o) => o.path));
  const assetSet = new Set(report.unreferencedAssets.map((a) => a.path));
  const symlinkSet = new Set(report.files.filter((f) => f.symlink).map((f) => f.path));
  const backupSet = new Set(report.junk.filter((j) => j.category === "backup-copy").map((j) => j.path));
  const isReachableModuleFile = (path) => moduleFileSet.has(path) && !orphanSet.has(path);
  const isReachableModule = (path) => isReachableModuleFile(path) || entrypointSet.has(path);
  const claimed = /* @__PURE__ */ new Set();
  const sortedJunk = [...report.junk].sort((a, b) => a.path < b.path ? -1 : 1);
  for (const j of sortedJunk) {
    if (j.category !== "sensitive" || claimed.has(j.path)) continue;
    add(
      "review-sensitive",
      j.path,
      null,
      "high",
      "may contain secrets \u2014 never auto-delete; rotate credentials, untrack, and gitignore",
      0
    );
    claimed.add(j.path);
  }
  const alsoOrphan = (path) => orphanSet.has(path) ? "; it is also unreachable in the module graph" : "";
  for (const j of sortedJunk) {
    if (j.category === "sensitive" || claimed.has(j.path)) continue;
    if (isReachableModule(j.path)) {
      add(
        "review-file",
        j.path,
        null,
        "medium",
        `flagged as ${j.category} (${j.pattern}, ${j.bytes} bytes) but the module graph proves it reachable \u2014 review instead of removing`,
        0
      );
      claimed.add(j.path);
      continue;
    }
    switch (j.category) {
      case "build-artifact":
        add(
          "untrack-and-gitignore",
          j.path,
          null,
          "high",
          `committed build artifact (${j.pattern}, ${j.bytes} bytes) \u2014 belongs in .gitignore, not in git${alsoOrphan(j.path)}`,
          j.bytes
        );
        break;
      case "log":
        add(
          "untrack-and-gitignore",
          j.path,
          null,
          "high",
          `committed log file (${j.pattern}, ${j.bytes} bytes) \u2014 belongs in .gitignore, not in git`,
          j.bytes
        );
        break;
      case "cache":
        add(
          "untrack-and-gitignore",
          j.path,
          null,
          "high",
          `committed cache (${j.pattern}, ${j.bytes} bytes) \u2014 belongs in .gitignore, not in git`,
          j.bytes
        );
        break;
      case "os-or-editor": {
        const segments = j.path.split("/");
        if (segments.includes(".idea") || segments.includes(".vscode")) {
          add(
            "review-file",
            j.path,
            null,
            "medium",
            `editor project config (${j.pattern}, ${j.bytes} bytes) \u2014 sometimes committed on purpose, review before untracking`,
            0
          );
        } else {
          add(
            "untrack-and-gitignore",
            j.path,
            null,
            "high",
            `OS or editor dropping (${j.pattern}, ${j.bytes} bytes) \u2014 belongs in .gitignore, not in git`,
            j.bytes
          );
        }
        break;
      }
      case "backup-copy":
        if (orphanSet.has(j.path)) continue;
        add(
          "delete-file",
          j.path,
          null,
          "medium",
          `filename marks it as a backup copy (${j.pattern}, ${j.bytes} bytes) \u2014 confirm the original supersedes it`,
          j.bytes
        );
        break;
      case "generated":
        add(
          "untrack-and-gitignore",
          j.path,
          null,
          "medium",
          `generated file (${j.pattern}, ${j.bytes} bytes) \u2014 usually rebuilt from source, belongs in .gitignore`,
          j.bytes
        );
        break;
      case "binary-or-archive":
        add(
          "review-file",
          j.path,
          null,
          "medium",
          `binary or archive (${j.pattern}, ${j.bytes} bytes) \u2014 confirm it must live in git`,
          0
        );
        break;
    }
    claimed.add(j.path);
  }
  const moduleEntrypoints = graph.entrypoints.filter((e) => moduleFileSet.has(e.path)).length;
  const zeroEntrypoints = moduleEntrypoints === 0;
  const sortedOrphans = [...graph.orphans].sort((a, b) => a.path < b.path ? -1 : 1);
  if (zeroEntrypoints && sortedOrphans.length > 0) warnings.push(NO_ENTRYPOINT_WARNING);
  const owningPackageDir = (path) => [...report.packages].filter((pkg) => pkg.dir === "." || path.startsWith(`${pkg.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0]?.dir ?? ".";
  for (const orphan of sortedOrphans) {
    if (claimed.has(orphan.path)) continue;
    const referencedBy = [...orphan.pathReferencedBy].sort();
    if (referencedBy.length > 0 || orphan.hasShebang) {
      const reasons = [];
      if (referencedBy.length > 0) reasons.push(`its path is referenced by ${referencedBy[0]}`);
      if (orphan.hasShebang) reasons.push("it starts with a shebang (likely a manually invoked script)");
      add(
        "review-file",
        orphan.path,
        null,
        zeroEntrypoints ? "low" : "medium",
        `unreachable in the import graph but ${reasons.join(" and ")} \u2014 review before deleting`,
        0
      );
      claimed.add(orphan.path);
      continue;
    }
    let confidence = "high";
    let evidence;
    if (zeroEntrypoints) {
      evidence = "flagged unreachable, but no module entrypoints were discovered so reachability is unknown";
    } else {
      evidence = graph.entrypoints.length === 1 ? "unreachable from the only entrypoint" : `unreachable from all ${graph.entrypoints.length} entrypoints`;
    }
    if (orphan.importers.length > 0) {
      evidence += ` (imported only by ${orphan.importers.length} fellow orphan${orphan.importers.length === 1 ? "" : "s"})`;
    }
    if (backupSet.has(orphan.path)) {
      evidence += "; the filename also marks it as a backup copy";
    } else if (graph.dynamicImporters.some((path) => owningPackageDir(path) === owningPackageDir(orphan.path))) {
      confidence = "medium";
      evidence += "; its package has dynamic imports \u2014 verify none loads this file";
    } else if (graph.unresolved.some((item) => owningPackageDir(item.from) === owningPackageDir(orphan.path))) {
      confidence = "medium";
      evidence += "; its package has unresolved imports \u2014 verify none targets this file";
    }
    if (zeroEntrypoints) confidence = "low";
    add("delete-file", orphan.path, null, confidence, evidence, orphan.bytes);
    claimed.add(orphan.path);
  }
  const duplicateRank = (path) => isReachableModuleFile(path) ? 0 : entrypointSet.has(path) ? 1 : assetSet.has(path) ? 3 : 2;
  for (const group of report.duplicateGroups) {
    const members = [...group.paths].sort().filter((p) => !symlinkSet.has(p));
    if (members.length < 2) continue;
    let survivor = members[0];
    for (const m of members) if (duplicateRank(m) < duplicateRank(survivor)) survivor = m;
    for (const path of members) {
      if (path === survivor || claimed.has(path)) continue;
      if (isDeliberateDuplicateBasename(path)) {
        add(
          "review-file",
          path,
          null,
          "low",
          `byte-identical to ${survivor} (${group.bytes} bytes) but this basename is a deliberate per-package duplicate \u2014 keep unless consolidating packages`,
          0
        );
      } else if (assetSet.has(path)) {
        add(
          "delete-file",
          path,
          null,
          "high",
          `byte-identical to ${survivor} (${group.bytes} bytes) and referenced nowhere`,
          group.bytes
        );
      } else if (isReachableModuleFile(path)) {
        add(
          "review-file",
          path,
          null,
          "medium",
          `byte-identical to ${survivor} but imported by reachable code \u2014 consolidate importers first`,
          0
        );
      } else if (entrypointSet.has(path)) {
        add(
          "review-file",
          path,
          null,
          "medium",
          `byte-identical to ${survivor} (${group.bytes} bytes) but it is an entrypoint \u2014 review instead of deleting`,
          0
        );
      } else {
        add(
          "delete-file",
          path,
          null,
          "medium",
          `byte-identical to ${survivor} (${group.bytes} bytes); reference status unknown \u2014 grep for the path before deleting`,
          group.bytes
        );
      }
      claimed.add(path);
    }
  }
  for (const asset of [...report.unreferencedAssets].sort((a, b) => a.path < b.path ? -1 : 1)) {
    if (claimed.has(asset.path)) continue;
    add("review-file", asset.path, null, "low", `${asset.reason} (${asset.bytes} bytes)`, 0);
    claimed.add(asset.path);
  }
  for (const pkg of [...report.packages].sort((a, b) => a.dir < b.dir ? -1 : 1)) {
    const dualSet = new Set(pkg.dualDeclared);
    const unusedSet = new Set(pkg.unused);
    for (const name of [...pkg.unused].sort()) {
      if (dualSet.has(name)) {
        add(
          "remove-dep",
          name,
          pkg.dir,
          "medium",
          "declared in multiple dependency fields with no usage evidence \u2014 least-safe runtime declaration controls; review exact removals",
          0
        );
        continue;
      }
      const declared = pkg.deps.filter((d) => d.name === name).sort((a, b) => a.field < b.field ? -1 : 1);
      if (declared.length === 0) {
        add("remove-dep", name, pkg.dir, "medium", "declared but no usage evidence found", 0);
        continue;
      }
      for (const d of declared) add("remove-dep", name, pkg.dir, UNUSED_CONFIDENCE[d.field], unusedEvidence(d), 0);
    }
    for (const name of [...pkg.dualDeclared].sort()) {
      if (unusedSet.has(name)) continue;
      const usedBy = new Set(pkg.deps.filter((d) => d.name === name).flatMap((d) => d.usedBy));
      const liveImport = [...usedBy].some((f) => !orphanSet.has(f) && !isTestLikePath(f));
      add(
        "move-dep",
        name,
        pkg.dir,
        "medium",
        liveImport ? "declared in both dependencies and devDependencies \u2014 imported by non-test reachable code, keep the dependencies entry" : "declared in both dependencies and devDependencies \u2014 only test/tooling usage found, keep the devDependencies entry",
        0
      );
    }
    for (const name of [...pkg.orphanOnly ?? []].sort()) {
      const importers = pkg.deps.filter((dep) => dep.name === name).flatMap((dep) => dep.usedBy);
      add(
        "remove-dep",
        name,
        pkg.dir,
        "low",
        `used only by current orphan modules (${importers.slice(0, 3).join(", ")}) \u2014 remove approved files, then re-scan before changing this declaration`,
        0
      );
      const item = byId.get(`remove-dep:${name}:${pkg.dir}`);
      if (item) {
        item.disposition = "deferred";
        item.mutations = [];
        item.prerequisites = importers.map((path) => `delete-file:${path}`).filter((id) => byId.has(id));
        item.decision = { status: "blocked", source: "planner-policy", value: "fresh-scan-required" };
      }
    }
    for (const name of [...pkg.uncertain ?? []].sort()) {
      add("remove-dep", name, pkg.dir, "low", "usage is uncertain because this package owns non-literal dynamic loading; destructive dependency advice is blocked", 0);
      const item = byId.get(`remove-dep:${name}:${pkg.dir}`);
      if (item) {
        item.disposition = "blocked";
        item.mutations = [];
        item.decision = { status: "blocked", source: "planner-policy", value: "dynamic-analysis-incomplete" };
      }
    }
    for (const missing of [...pkg.missing].sort((a, b) => a.name < b.name ? -1 : 1)) {
      const importers = [...missing.importers].sort();
      const count = `${importers.length} file${importers.length === 1 ? "" : "s"}`;
      const allOrphanImporters = importers.length > 0 && importers.every((f) => orphanSet.has(f));
      if (allOrphanImporters) {
        add(
          "add-missing-dep",
          missing.name,
          pkg.dir,
          "low",
          `only imported by files this plan deletes (${count}, e.g. ${importers[0]}) \u2014 delete those first and re-scan`,
          0
        );
      } else if (missing.declaredIn == null) {
        const example = importers.length > 0 ? ` (e.g. ${importers[0]})` : "";
        add("add-missing-dep", missing.name, pkg.dir, "high", `imported by ${count}${example} but declared in no manifest`, 0);
      } else {
        add(
          "add-missing-dep",
          missing.name,
          pkg.dir,
          "low",
          `imported by ${count} \u2014 works via hoisting from ${missing.declaredIn} \u2014 declare explicitly`,
          0
        );
      }
      const missingItem = byId.get(`add-missing-dep:${missing.name}:${pkg.dir}`);
      if (missingItem) {
        missingItem.disposition = allOrphanImporters ? "deferred" : "manual";
        missingItem.decision = allOrphanImporters ? { status: "blocked", source: "planner-policy", value: "fresh-scan-required" } : { status: "pending", source: null, value: null };
        missingItem.prerequisites = allOrphanImporters ? importers.map((path) => `delete-file:${path}`).filter((id) => byId.has(id)) : [];
      }
    }
  }
  for (const skew of [...report.workspaceSkew].sort((a, b) => a.name < b.name ? -1 : 1)) {
    const dirs = Object.keys(skew.ranges).sort();
    const pairs = dirs.map((dir) => `${dir} \u2192 ${skew.ranges[dir]}`).join(", ");
    const distinct = new Set(dirs.map((dir) => skew.ranges[dir])).size;
    add("align-versions", skew.name, skew.projectRoot ?? null, "medium", `${distinct} distinct ranges across the workspace: ${pairs}`, 0);
  }
  const lockScopes = report.projects.some((project) => project.lockfileDuplicates !== void 0) ? report.projects.map((project) => ({ target: project.lockfile.path, duplicates: project.lockfileDuplicates ?? [] })) : [{ target: report.lockfileKind, duplicates: report.lockfileDuplicates }];
  for (const scope of lockScopes) {
    const lockDups = [...scope.duplicates].sort((a, b) => b.versions.length - a.versions.length || (a.name < b.name ? -1 : 1));
    if (lockDups.length === 0) continue;
    const lockTarget = scope.target ?? "lockfile";
    const shown = lockDups.slice(0, MAX_LOCKFILE_ITEMS);
    add(
      "dedupe-lockfile",
      lockTarget,
      null,
      "low",
      `${lockDups.length} dependency names resolve to multiple versions; review as one project-level lockfile operation (${shown.map((entry) => entry.name).join(", ")}${lockDups.length > shown.length ? ", \u2026" : ""})`,
      0
    );
    const item = byId.get(`dedupe-lockfile:${lockTarget}`);
    if (item) item.relatedTargets = lockDups.map((entry) => entry.name);
  }
  const overlaps = [...report.overlaps].sort(
    (a, b) => (a.packageDir < b.packageDir ? -1 : a.packageDir > b.packageDir ? 1 : 0) || (a.family < b.family ? -1 : 1)
  );
  for (const overlap of overlaps) {
    const packages = [...overlap.packages].sort();
    add(
      "consolidate-overlap",
      overlap.family,
      overlap.packageDir,
      "low",
      `${packages.length} ${overlap.family} in one manifest (${packages.join(", ")}) \u2014 ${overlap.hint}`,
      0
    );
  }
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
    const project = item.packageDir === null ? null : report.projects.find((candidate) => candidate.packageDirs.includes(item.packageDir));
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
    const item = byId.get(id);
    item.disposition = "proposed";
    item.decision = { status: "approved", source: "allow-delete", value: path };
    item.mutations = [{ kind: "delete-file", path, beforeHash: file.hash }];
  }
  const all = [...byId.values()];
  for (const item of all) {
    const matched = keepRes.find(
      (re) => re.test(item.target) || re.test(item.id) || item.relatedTargets.some((target) => re.test(target))
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
    if (item.rescued) continue;
    if (item.mutations.length === 0 || item.disposition === "blocked" || item.disposition === "deferred" || item.disposition === "review-only") {
      throw new Error(`item cannot be approved because it has no concrete safe mutation: ${id}`);
    }
    item.decision = { status: "approved", source: "approve-id", value: id };
  }
  const minRank = CONFIDENCE_RANK[opts.minConfidence];
  const items = all.filter(
    (i) => i.rescued || i.decision.status === "approved" || i.disposition === "review-only" || i.disposition === "deferred" || i.disposition === "blocked" || CONFIDENCE_RANK[i.confidence] >= minRank
  );
  const filtered = all.length - items.length;
  if (filtered > 0) {
    warnings.push(
      `${filtered} item${filtered === 1 ? "" : "s"} below --min-confidence ${opts.minConfidence} filtered out of the plan`
    );
  }
  items.sort(
    (a, b) => ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action) || CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0) || ((a.packageDir ?? "") < (b.packageDir ?? "") ? -1 : (a.packageDir ?? "") > (b.packageDir ?? "") ? 1 : 0)
  );
  const actionable = items.filter((i) => !i.rescued && (i.disposition === "proposed" || i.disposition === "manual") && i.mutations.length > 0);
  const byAction = {};
  for (const action of ACTION_ORDER) {
    const count = actionable.filter((i) => i.action === action).length;
    if (count > 0) byAction[action] = count;
  }
  const byDisposition = { proposed: 0, manual: 0, "review-only": 0, deferred: 0, blocked: 0 };
  for (const item of items) byDisposition[item.disposition] += 1;
  const approvedFileMutations = new Set(items.filter((item) => item.decision.status === "approved").flatMap((item) => item.mutations).filter((mutation) => mutation.kind === "delete-file" || mutation.kind === "untrack-file").map((mutation) => mutation.path));
  const protectedReasons = /* @__PURE__ */ new Map();
  const protect = (path, reason) => {
    if (approvedFileMutations.has(path)) return;
    protectedReasons.set(path, /* @__PURE__ */ new Set([...protectedReasons.get(path) ?? [], reason]));
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
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    source: {
      reportSha256: opts.reportSha256 ?? sha256(canonicalJson({ source: report.source, scanOptionsDigest: report.scanOptionsDigest, toolVersion: report.toolVersion })),
      repositoryId: report.source.repository.id,
      baselineHead: report.source.repository.head,
      inventoryDigest: report.source.inventoryDigest,
      indexDigest: report.source.indexDigest,
      scanOptionsDigest: report.scanOptionsDigest,
      toolVersion: report.toolVersion
    },
    options: { keep: [...opts.keep], approve: [...opts.approve ?? []], allowDelete: [...opts.allowDelete ?? []], minConfidence: opts.minConfidence },
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
      warnings
    },
    items
  };
}

// scripts/lib/render.ts
import { realpathSync as realpathSync2 } from "node:fs";
function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
var SECTIONS = [
  { action: "delete-file", title: "Delete files" },
  { action: "review-file", title: "Review files" },
  { action: "remove-dep", title: "Remove dependencies" },
  { action: "move-dep", title: "Move dependencies" },
  { action: "add-missing-dep", title: "Add missing dependencies" },
  { action: "align-versions", title: "Align workspace versions" },
  { action: "dedupe-lockfile", title: "Dedupe the lockfile" },
  { action: "untrack-and-gitignore", title: "Untrack and gitignore" },
  { action: "consolidate-overlap", title: "Consolidate overlapping packages" },
  { action: "review-sensitive", title: "Sensitive files \u2014 review, never auto-delete" }
];
function targetCell(item) {
  return item.packageDir == null ? code(item.target) : `${code(item.target)} (${code(item.packageDir)})`;
}
function escapeMarkdownCell(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "&#124;").replace(/\r?\n|\r/g, "<br>").replace(/`/g, "&#96;");
}
function code(value) {
  return `<code>${escapeMarkdownCell(value)}</code>`;
}
function renderPlanMarkdown(plan, report, maxRows = 400) {
  const s = plan.summary;
  const actionable = plan.items.filter((i) => !i.rescued && (i.disposition === "proposed" || i.disposition === "manual"));
  const rescued = plan.items.filter((i) => i.rescued);
  const filesRemoved = (s.byAction["delete-file"] ?? 0) + (s.byAction["untrack-and-gitignore"] ?? 0);
  const depsDelta = (s.byAction["add-missing-dep"] ?? 0) - (s.byAction["remove-dep"] ?? 0);
  const t = report.totals;
  const lines = [];
  lines.push("# Repo cleanup plan");
  lines.push("");
  lines.push(`Generated ${escapeMarkdownCell(plan.createdAt)} from a scan of ${code(report.cwd)} by repo-doctor ${escapeMarkdownCell(plan.toolVersion)}.`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Before | After (estimate) |");
  lines.push("|---|---:|---:|");
  lines.push(`| Tracked files | ${t.trackedFiles} | **${t.trackedFiles - filesRemoved}** |`);
  lines.push(
    `| Tracked size | ${formatBytes(t.trackedBytes)} | ${formatBytes(Math.max(0, t.trackedBytes - s.reclaimBytes))} |`
  );
  lines.push(`| Declared deps | ${t.declaredDeps} | ${Math.max(0, t.declaredDeps + depsDelta)} |`);
  lines.push("");
  lines.push(
    `Up to **${formatBytes(s.reclaimBytes)}** reclaimable across ${actionable.length} actionable item${actionable.length === 1 ? "" : "s"}${rescued.length > 0 ? ` (${rescued.length} rescued by --keep)` : ""}.`
  );
  lines.push("");
  if (s.warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const w of s.warnings) lines.push(`- \u26A0\uFE0F ${escapeMarkdownCell(w)}`);
    lines.push("");
  }
  if (plan.diagnostics.length > 0) {
    lines.push("## Analysis diagnostics");
    lines.push("");
    lines.push("| Code | Severity | Source | Scope | Message |");
    lines.push("|---|---|---|---|---|");
    for (const diagnostic of plan.diagnostics.slice(0, maxRows)) {
      const scope = diagnostic.scope.path.length > 0 ? `${diagnostic.scope.kind}:${diagnostic.scope.path}` : diagnostic.scope.kind;
      lines.push(
        `| ${code(diagnostic.code)} | ${escapeMarkdownCell(diagnostic.severity)} | ${escapeMarkdownCell(diagnostic.source)} | ${escapeMarkdownCell(scope)} | ${escapeMarkdownCell(diagnostic.message)} |`
      );
    }
    if (plan.diagnostics.length > maxRows) lines.push(`| \u2026 +${plan.diagnostics.length - maxRows} more | | | | |`);
    lines.push("");
  }
  for (const { action, title } of SECTIONS) {
    const rows = plan.items.filter((i) => !i.rescued && i.action === action);
    if (rows.length === 0) continue;
    lines.push(`## ${title} (${rows.length})`);
    lines.push("");
    if (action === "review-sensitive") {
      lines.push("> Rotate any exposed credentials FIRST. These files are reported only \u2014");
      lines.push("> untrack and gitignore them by hand, never delete them automatically.");
      lines.push("");
    }
    lines.push("| ID | Target | Disposition | Decision | Confidence | Evidence | Bytes |");
    lines.push("|---|---|---|---|---|---|---:|");
    for (const item of rows.slice(0, maxRows)) {
      lines.push(
        `| ${code(item.id)} | ${targetCell(item)} | ${item.disposition} | ${item.decision.status} | ${item.confidence} | ${escapeMarkdownCell(item.evidence)} | ${item.reclaimBytes > 0 ? formatBytes(item.reclaimBytes) : "\u2014"} |`
      );
    }
    if (rows.length > maxRows) lines.push(`| \u2026 +${rows.length - maxRows} more | | | | | | |`);
    lines.push("");
  }
  if (rescued.length > 0) {
    lines.push(`## Rescued by --keep (${rescued.length})`);
    lines.push("");
    lines.push("| Target | Action | Pattern | Evidence |");
    lines.push("|---|---|---|---|");
    for (const item of rescued.slice(0, maxRows)) {
      lines.push(`| ${targetCell(item)} | ${escapeMarkdownCell(item.action)} | ${code(item.keepPattern ?? "")} | ${escapeMarkdownCell(item.evidence)} |`);
    }
    if (rescued.length > maxRows) lines.push(`| \u2026 +${rescued.length - maxRows} more | | | |`);
    lines.push("");
  }
  const pm = report.packageManager ?? "<resolved-package-manager>";
  lines.push("## Next steps");
  lines.push("");
  const skillRoot = resolveSkillRoot();
  lines.push(`1. Set the installed tool root: \`REPO_DOCTOR_ROOT=${shellQuote(skillRoot)}\`.`);
  lines.push("2. Re-run plan with exact `--approve <item-id>` flags for every concrete mutation you reviewed; draft items remain pending.");
  lines.push("3. Delete files with `git rm <path>` and untrack junk with `git rm --cached <path>` so changes remain reviewable.");
  lines.push(`4. Make dependency edits with the resolved project manager (${code(pm)}); never invent an external version range.`);
  lines.push("5. Run static verification, which executes no target code:");
  lines.push(`   \`node "$REPO_DOCTOR_ROOT/bin/repo-doctor-verify.mjs" --cwd ${shellQuote(report.cwd)}\``);
  lines.push("6. For explicitly trusted gates, add `--run-gates --trust-repo`. Re-scan after file cleanup before applying deferred dependency findings.");
  lines.push("");
  return lines.join("\n");
}
function resolveSkillRoot() {
  const executable = process.argv[1] ?? "<repo-doctor-root>/bin/repo-doctor-plan.mjs";
  let detected = executable;
  try {
    detected = realpathSync2(executable);
  } catch {
  }
  const normalized = detected.replace(/\\/g, "/");
  return /\/bin\/repo-doctor-plan\.mjs$/.test(normalized) ? normalized.replace(/\/bin\/repo-doctor-plan\.mjs$/, "") : "<repo-doctor-root>";
}
function shellQuote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// scripts/lib/repository.ts
import { createHash as createHash2 } from "node:crypto";
import { execFileSync as execFileSync2 } from "node:child_process";
import { realpathSync as realpathSync3 } from "node:fs";
function git(cwd, args, allowFailure = false) {
  try {
    return execFileSync2("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    if (allowFailure) return "";
    throw new Error(`git ${args.join(" ")} failed: ${error.message}`);
  }
}
function repositoryIdentity(cwd) {
  const root = realpathSync3(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
  const head = git(root, ["rev-parse", "--verify", "HEAD"], true).trim() || null;
  const rootCommits = head ? git(root, ["rev-list", "--max-parents=0", "HEAD"]).trim().split(/\s+/).filter(Boolean).sort() : [];
  const kind = head ? "git-history" : "local-unborn";
  const identityMaterial = head ? { kind, rootCommits } : { kind, commonDir: git(root, ["rev-parse", "--git-common-dir"]).trim() };
  return {
    id: sha256(canonicalJson(identityMaterial)),
    kind,
    root,
    head,
    rootCommits
  };
}
function indexDigest(cwd) {
  const raw = execFileSync2("git", ["ls-files", "-s", "-z", "--cached"], {
    cwd,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024
  });
  return `sha256:${createHash2("sha256").update(raw).digest("hex")}`;
}
function trackedWorktreeClean(cwd) {
  return git(cwd, ["status", "--porcelain=v1", "--untracked-files=no"]).trim() === "";
}

// scripts/lib/schema.ts
var SchemaError = class extends Error {
};
function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SchemaError(`${label} must be an object`);
  return value;
}
function array(value, label) {
  if (!Array.isArray(value)) throw new SchemaError(`${label} must be an array`);
  return value;
}
function string(value, label) {
  if (typeof value !== "string") throw new SchemaError(`${label} must be a string`);
  return value;
}
function versioned(value, label) {
  const root = record(value, label);
  if (root.tool !== "repo-doctor" || root.version !== 2) throw new SchemaError(`${label} must be a repo-doctor version-2 artifact`);
  string(root.toolVersion, `${label}.toolVersion`);
  return root;
}
function assertRepoReportV2(value) {
  const root = versioned(value, "report");
  record(root.source, "report.source");
  record(root.source.repository, "report.source.repository");
  record(root.scanOptions, "report.scanOptions");
  for (const key of ["ignore", "entries"]) array(root.scanOptions[key], `report.scanOptions.${key}`);
  for (const key of ["largeCount", "minDupBytes"]) {
    const value2 = root.scanOptions[key];
    if (typeof value2 !== "number" || !Number.isSafeInteger(value2) || value2 < 0) throw new SchemaError(`report.scanOptions.${key} must be a non-negative safe integer`);
  }
  for (const key of ["health", "graph", "totals"]) record(root[key], `report.${key}`);
  array(root.diagnostics, "report.diagnostics");
  array(root.projects, "report.projects");
  array(root.files, "report.files");
  array(root.packages, "report.packages");
  array(root.warnings, "report.warnings");
  string(root.scanOptionsDigest, "report.scanOptionsDigest");
  string(root.source.inventoryDigest, "report.source.inventoryDigest");
  string(root.source.indexDigest, "report.source.indexDigest");
}

// scripts/plan.ts
var HELP = `plan \u2014 evidence-backed cleanup plan from a scan report

Usage: node repo-doctor-plan.mjs [options]

Options:
  --cwd <dir>             Target repo root (default: current directory)
  --report <file>          Scan report (default: .repo-doctor/report.json)
  --out-plan <file>        Plan JSON output (default: .repo-doctor/plan.json)
  --out-md <file>          Human-readable plan (default: .repo-doctor/plan.md)
  --keep <regex>           Rescue items whose target or id matches
                           (repeatable) \u2014 kept in the plan for the audit
                           trail, excluded from action counts
  --approve <item-id>      Approve one exact mutation-capable plan item
                           (repeatable; --keep wins)
  --allow-delete <path>    Explicitly authorize one non-sensitive protected path
                           (repeatable, exact repo-relative path)
  --min-confidence <level> low|medium|high \u2014 drop items below this confidence
                           (default: low = keep everything)
  --allow-output-outside-cwd
                           Permit plan outputs outside the target root
  --help                   Show this help

Exit codes: 0 plan written, 2 environment/usage error.`;
function fail(msg) {
  console.error(`
plan: ${msg}`);
  process.exit(2);
}
function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
function parseCliValues() {
  try {
    return parseValues();
  } catch (err) {
    return fail(err.message);
  }
}
function parseValues() {
  return parseArgs({
    options: {
      report: { type: "string", default: ".repo-doctor/report.json" },
      cwd: { type: "string", default: "." },
      "out-plan": { type: "string", default: ".repo-doctor/plan.json" },
      "out-md": { type: "string", default: ".repo-doctor/plan.md" },
      keep: { type: "string", multiple: true, default: [] },
      approve: { type: "string", multiple: true, default: [] },
      "allow-delete": { type: "string", multiple: true, default: [] },
      "min-confidence": { type: "string", default: "low" },
      "allow-output-outside-cwd": { type: "boolean", default: false },
      help: { type: "boolean", default: false }
    }
  }).values;
}
function main() {
  const values = parseCliValues();
  if (values.help) {
    console.log(HELP);
    return;
  }
  const cwd = realpathSync4(resolve2(values.cwd));
  const reportPath = resolveSafePath(values.report, { cwd });
  let loaded;
  try {
    loaded = readJsonArtifact(reportPath, { cwd });
  } catch (err) {
    return fail(err.message);
  }
  const parsed = loaded.value;
  if (parsed === null || typeof parsed !== "object" || parsed.tool !== "repo-doctor" || parsed.version !== 2) {
    const version = parsed && typeof parsed === "object" ? parsed.version : null;
    fail(version === 1 ? `legacy v1 report rejected: ${reportPath} \u2014 re-run scan with repo-doctor 0.2.0` : `unrecognized report format in ${reportPath}`);
  }
  const report = parsed;
  try {
    assertRepoReportV2(report);
  } catch (error) {
    return fail(`malformed v2 report: ${error.message}`);
  }
  const identity = repositoryIdentity(cwd);
  if (identity.id !== report.source.repository.id || identity.head !== report.source.repository.head) {
    fail("scan report is stale or belongs to a different repository/HEAD \u2014 re-run scan");
  }
  if (indexDigest(cwd) !== report.source.indexDigest || !trackedWorktreeClean(cwd) || !report.source.trackedWorktreeClean) {
    fail("a mutation-capable plan requires the same clean tracked baseline recorded by scan \u2014 clean the worktree and re-run scan");
  }
  const minConfidence = values["min-confidence"];
  if (!["low", "medium", "high"].includes(minConfidence)) {
    fail("--min-confidence must be low, medium, or high");
  }
  const keep = (values.keep ?? []).map((p) => {
    try {
      new RegExp(p);
      return p;
    } catch {
      return fail(`invalid --keep regex: ${p}`);
    }
  });
  const plan = buildPlan(report, {
    keep,
    minConfidence,
    approve: values.approve ?? [],
    allowDelete: values["allow-delete"] ?? [],
    reportSha256: loaded.digest
  });
  const planPath = resolveSafePath(values["out-plan"], { cwd, allowOutside: values["allow-output-outside-cwd"], rejectTracked: true });
  const mdPath = resolveSafePath(values["out-md"], { cwd, allowOutside: values["allow-output-outside-cwd"], rejectTracked: true });
  assertDistinctArtifactPaths([reportPath, planPath, mdPath]);
  writeArtifactAtomic(planPath, `${JSON.stringify(plan, null, 2)}
`, { cwd, allowOutside: values["allow-output-outside-cwd"], rejectTracked: true });
  writeArtifactAtomic(mdPath, `${renderPlanMarkdown(plan, report)}
`, { cwd, allowOutside: values["allow-output-outside-cwd"], rejectTracked: true });
  const s = plan.summary;
  const by = (a) => s.byAction[a] ?? 0;
  console.error(`plan written: ${planPath} (+ ${mdPath})`);
  console.error(`items: ${s.itemsTotal} total, ${s.itemsRescued} rescued by --keep`);
  console.error(
    `files: ${s.deleteFiles} delete, ${s.reviewFiles} review, ${by("untrack-and-gitignore")} untrack, ${by("review-sensitive")} sensitive \u2014 ${fmtBytes(s.reclaimBytes)} reclaimable`
  );
  console.error(
    `deps: ${s.removeDeps} remove, ${by("move-dep")} move, ${by("add-missing-dep")} add-missing, ${by("align-versions")} align-versions`
  );
  console.error(
    `lockfile: ${by("dedupe-lockfile")} dedupe \u2014 overlaps: ${by("consolidate-overlap")} consolidate`
  );
  for (const w of s.warnings) console.error(`\u26A0\uFE0F  ${w}`);
  console.error(
    "\nnext: review the plan against references/false-positives.md \u2014 do NOT delete blindly."
  );
}
try {
  main();
} catch (err) {
  fail(err.stack ?? String(err));
}
