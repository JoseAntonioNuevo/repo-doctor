#!/usr/bin/env -S node

// scripts/verify.ts
import { existsSync as existsSync5, lstatSync as lstatSync2, readFileSync as readFileSync4, readlinkSync, realpathSync as realpathSync4 } from "node:fs";
import { execFileSync as execFileSync4 } from "node:child_process";
import { join as join6, resolve as resolve4 } from "node:path";
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
  const normalized2 = paths.map((path) => resolve(path));
  if (new Set(normalized2).size !== normalized2.length) {
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
    const blocking = report.diagnostics.filter((diagnostic2) => {
      if (diagnostic2.severity !== "error") return false;
      if (item.packageDir !== null && !diagnostic2.affects.includes("dependencies")) return false;
      if (item.packageDir === null && !diagnostic2.affects.includes("graph") && !diagnostic2.affects.includes("inventory")) return false;
      if (diagnostic2.scope.kind === "repo") return true;
      if (diagnostic2.scope.kind === "file") {
        if (diagnostic2.scope.path === item.target) return true;
        return item.packageDir !== null && (item.packageDir === "." || diagnostic2.scope.path.startsWith(`${item.packageDir}/`));
      }
      if (item.packageDir === null) return false;
      return item.packageDir === diagnostic2.scope.path || item.packageDir.startsWith(`${diagnostic2.scope.path}/`);
    });
    const project = item.packageDir === null ? null : report.projects.find((candidate) => candidate.packageDirs.includes(item.packageDir));
    if (project?.kind === "unmanaged" || project?.manager.status === "ambiguous" || blocking.length > 0) {
      item.disposition = "blocked";
      item.decision = { status: "blocked", source: "planner-policy", value: project?.kind === "unmanaged" ? "unmanaged-project" : blocking[0]?.code ?? "ambiguous-project" };
      item.mutations = [];
      item.evidenceItems.push(...blocking.map((diagnostic2) => diagnostic2.message));
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

// scripts/lib/exec.ts
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
var OUTPUT_CAP = 64 * 1024;
function appendTail(current, chunk) {
  const joined = Buffer.concat([current, chunk]);
  if (joined.byteLength <= OUTPUT_CAP) return { value: joined, truncated: false };
  return { value: joined.subarray(joined.byteLength - OUTPUT_CAP), truncated: true };
}
function minimalEnvironment(passEnv, inherited, extra) {
  if (inherited) return { env: { ...process.env, CI: "true", ...extra }, home: null };
  const home = mkdtempSync(join(tmpdir(), "repo-doctor-home-"));
  const names = process.platform === "win32" ? ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"] : ["PATH", "LANG", "LC_ALL", "TMPDIR"];
  const env = { CI: "true", HOME: home, USERPROFILE: home };
  for (const name of [...names, ...passEnv]) if (process.env[name] !== void 0) env[name] = process.env[name];
  Object.assign(env, extra);
  return { env, home };
}
function run(cmd, args, opts) {
  if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs <= 0) {
    return Promise.reject(new Error("timeoutMs must be a positive safe integer"));
  }
  const bin = process.platform === "win32" && ["npx", "npm", "pnpm", "yarn", "bun"].includes(cmd) ? `${cmd}.cmd` : cmd;
  const environment = opts.environment === "minimal" ? minimalEnvironment(opts.passEnv ?? [], opts.inheritEnv ?? false, opts.env ?? {}) : { env: { ...process.env, CI: "true", ...opts.env }, home: null };
  return new Promise((resolve5) => {
    const started = Date.now();
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: environment.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let escalation = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      if (environment.home) rmSync(environment.home, { recursive: true, force: true });
      resolve5({
        code,
        timedOut,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        stdoutTruncated,
        stderrTruncated,
        wallMs: Date.now() - started
      });
    };
    child.stdout?.on("data", (data) => {
      const next = appendTail(stdout, Buffer.from(data));
      stdout = next.value;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr?.on("data", (data) => {
      const next = appendTail(stderr, Buffer.from(data));
      stderr = next.value;
      stderrTruncated ||= next.truncated;
    });
    const killTree = (force) => {
      if (child.pid === void 0) return;
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", ...force ? ["/F"] : []], { stdio: "ignore", windowsHide: true });
      } else {
        try {
          process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
        } catch {
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(false);
      escalation = setTimeout(() => killTree(true), 5e3);
      escalation.unref();
    }, opts.timeoutMs);
    child.once("error", (error) => {
      const next = appendTail(stderr, Buffer.from(`
${error.message}`));
      stderr = next.value;
      stderrTruncated ||= next.truncated;
      finish(null);
    });
    child.once("close", finish);
  });
}
async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

// scripts/lib/repository.ts
import { createHash as createHash2 } from "node:crypto";
import { execFileSync as execFileSync2 } from "node:child_process";
import { realpathSync as realpathSync2 } from "node:fs";
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
function gitSucceeds(cwd, args) {
  try {
    execFileSync2("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function repositoryIdentity(cwd) {
  const root = realpathSync2(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
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
function inventoryDigest(files) {
  return sha256(
    canonicalJson(
      files.map((file) => ({
        path: file.path,
        bytes: file.bytes,
        hash: file.hash,
        mode: file.mode ?? null,
        objectId: file.objectId ?? null,
        symlink: file.symlink
      }))
    )
  );
}
function trackedWorktreeClean(cwd) {
  return git(cwd, ["status", "--porcelain=v1", "--untracked-files=no"]).trim() === "";
}
function repositorySnapshot(cwd, files) {
  const status = git(cwd, ["status", "--porcelain=v1"]).split("\n").map((line) => line.trimEnd()).filter(Boolean).sort();
  return {
    repository: repositoryIdentity(cwd),
    inventoryDigest: inventoryDigest(files),
    indexDigest: indexDigest(cwd),
    trackedWorktreeClean: trackedWorktreeClean(cwd),
    gitStatus: status
  };
}
function assertBaselineHistory(cwd, baselineHead) {
  if (baselineHead === null) return;
  if (!gitSucceeds(cwd, ["cat-file", "-e", `${baselineHead}^{commit}`])) {
    throw new Error(`baseline commit is not present in this repository: ${baselineHead}`);
  }
  try {
    execFileSync2("git", ["merge-base", "--is-ancestor", baselineHead, "HEAD"], { cwd, stdio: "ignore" });
  } catch {
    throw new Error(`baseline commit is not an ancestor of current HEAD: ${baselineHead}`);
  }
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
function assertCleanupPlanV2(value) {
  const root = versioned(value, "plan");
  const source = record(root.source, "plan.source");
  for (const key of ["reportSha256", "repositoryId", "inventoryDigest", "indexDigest", "scanOptionsDigest", "toolVersion"]) string(source[key], `plan.source.${key}`);
  const options = record(root.options, "plan.options");
  for (const key of ["keep", "approve", "allowDelete"]) array(options[key], `plan.options.${key}`);
  const confidence = string(options.minConfidence, "plan.options.minConfidence");
  if (!("low" === confidence || "medium" === confidence || "high" === confidence)) throw new SchemaError("plan.options.minConfidence must be low, medium, or high");
  array(root.diagnostics, "plan.diagnostics");
  array(root.protectedFiles, "plan.protectedFiles");
  array(root.items, "plan.items");
  record(root.summary, "plan.summary");
}

// scripts/lib/verify-core.ts
function emptyRegressions() {
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
    healthErrors: []
  };
}
function compareScans(before, after) {
  const regressions = emptyRegressions();
  const knownUnresolved = new Set(before.graph.unresolved.map((item) => `${item.from}\0${item.specifier}`));
  regressions.newUnresolvedImports = after.graph.unresolved.filter((item) => !knownUnresolved.has(`${item.from}\0${item.specifier}`)).sort((a, b) => a.from.localeCompare(b.from) || a.specifier.localeCompare(b.specifier));
  const missing = (report) => report.packages.flatMap((pkg) => pkg.missing.map((item) => ({ packageDir: pkg.dir, name: item.name, declaredIn: item.declaredIn })));
  const knownMissing = new Set(missing(before).map((item) => `${item.packageDir}\0${item.name}\0${item.declaredIn ?? "hard"}`));
  regressions.newMissingDeps = missing(after).filter((item) => !knownMissing.has(`${item.packageDir}\0${item.name}\0${item.declaredIn ?? "hard"}`)).map(({ packageDir, name }) => ({ packageDir, name })).sort((a, b) => a.packageDir.localeCompare(b.packageDir) || a.name.localeCompare(b.name));
  const knownOrphans = new Set(before.graph.orphans.map((item) => item.path));
  regressions.newOrphans = after.graph.orphans.map((item) => item.path).filter((path) => !knownOrphans.has(path)).sort();
  for (const capability of Object.keys(before.health)) {
    if (after.health[capability] === "degraded" && before.health[capability] !== "degraded") {
      regressions.healthErrors.push(`${capability}: ${before.health[capability]} -> ${after.health[capability]}`);
    }
  }
  const knownDiagnostics = new Set(before.diagnostics.map(diagnosticIdentity));
  for (const diagnostic2 of after.diagnostics) {
    if (!knownDiagnostics.has(diagnosticIdentity(diagnostic2))) {
      regressions.healthErrors.push(`${diagnostic2.code}:${diagnostic2.scope.kind}:${diagnostic2.scope.path}`);
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
      depsAfter: after.totals.declaredDeps
    }
  };
}
function diagnosticIdentity(diagnostic2) {
  return canonicalJson({
    code: diagnostic2.code,
    source: diagnostic2.source,
    affects: [...diagnostic2.affects].sort(),
    scope: diagnostic2.scope
  });
}
var mutationKey = (mutation) => {
  if (mutation.kind === "delete-file" || mutation.kind === "untrack-file") return `${mutation.kind}:${mutation.path}`;
  if (mutation.kind === "modify-lockfile") return `${mutation.kind}:${mutation.path}`;
  return `${mutation.kind}:${mutation.packageDir}:${mutation.name}:${mutation.field}`;
};
function declarationMap(report) {
  const map = /* @__PURE__ */ new Map();
  for (const pkg of report.packages) {
    for (const dep of pkg.deps) map.set(`${pkg.dir}\0${dep.name}\0${dep.field}`, dep.range);
  }
  return map;
}
function cloneManifest(value) {
  return JSON.parse(JSON.stringify(value));
}
function normalizeManifest(value) {
  const copy = cloneManifest(value);
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const declarations = copy[field];
    if (declarations && typeof declarations === "object" && !Array.isArray(declarations) && Object.keys(declarations).length === 0) delete copy[field];
  }
  return copy;
}
function expectedManifestAfterSubset(before, after, packageDir, approved) {
  const expected = cloneManifest(before);
  for (const mutation of approved) {
    if (mutation.kind !== "remove-declaration" && mutation.kind !== "move-declaration" && mutation.kind !== "change-range" || mutation.packageDir !== packageDir) continue;
    const field = expected[mutation.field];
    const current = field && typeof field === "object" && !Array.isArray(field) ? field[mutation.name] : void 0;
    const afterField = after[mutation.field];
    const afterValue = afterField && typeof afterField === "object" && !Array.isArray(afterField) ? afterField[mutation.name] : void 0;
    if (current === mutation.beforeRange && afterValue !== mutation.beforeRange) {
      delete field[mutation.name];
      if (mutation.kind === "change-range" && mutation.afterRange !== void 0) {
        const record2 = expected[mutation.field] ??= {};
        record2[mutation.name] = mutation.afterRange;
      } else if (mutation.kind === "move-declaration" && mutation.toField) {
        const record2 = expected[mutation.toField] ??= {};
        record2[mutation.name] = mutation.afterRange ?? mutation.beforeRange;
      }
    }
  }
  return normalizeManifest(expected);
}
function verifyAuthorizedChanges(before, after, plan) {
  const regressions = compareScans(before, after).regressions;
  const approved = plan.items.filter((item) => item.decision.status === "approved").flatMap((item) => item.mutations);
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
  const lockPaths = new Set(before.projects.map((project) => project.lockfile.path).filter((path) => path !== null));
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
    const allowed = approved.some(
      (mutation) => (mutation.kind === "remove-declaration" || mutation.kind === "move-declaration" || mutation.kind === "change-range") && mutation.packageDir === packageDir && mutation.name === name && mutation.field === field && mutation.beforeRange === beforeRange && (mutation.kind !== "change-range" || mutation.afterRange === afterRange)
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
  for (const key of Object.keys(regressions)) {
    const value = regressions[key];
    if (Array.isArray(value)) regressions[key] = [...new Map(value.map((item) => [typeof item === "string" ? item : JSON.stringify(item), item])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return regressions;
}
var INSTALL_COMMAND = {
  pnpm: ["pnpm", "install", "--frozen-lockfile"],
  npm: ["npm", "ci"],
  yarn: ["yarn", "install", "--immutable"],
  bun: ["bun", "install", "--frozen-lockfile"]
};
var SCRIPT_NAMES = ["typecheck", "check", "lint", "build", "test", "validate"];
function runCommand(manager, dir, script) {
  if (manager === "npm") return ["npm", "--prefix", dir, "run", script];
  if (manager === "yarn") return ["yarn", "--cwd", dir, "run", script];
  if (manager === "bun") return ["bun", "--cwd", dir, "run", script];
  return ["pnpm", "--dir", dir, "run", script];
}
function parseGateCommand(raw) {
  const args = [];
  let token = "";
  let quote = null;
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
function pickProjectGates(projects, manifests, flags) {
  const gates = [];
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
      const command = project.manager.name === "yarn" && project.lockfile.dialect === "yarn-classic" ? ["yarn", "install", "--frozen-lockfile"] : [...INSTALL_COMMAND[project.manager.name]];
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
function resolveVerifyScanOptions(baseline, flagIgnores, flagEntries) {
  for (const value of flagIgnores) if (!baseline.scanOptions.ignore.includes(value)) throw new Error(`verify cannot add --ignore ${value}; re-run scan and plan with that option`);
  for (const value of flagEntries) if (!baseline.scanOptions.entries.includes(value)) throw new Error(`verify cannot add --entry ${value}; re-run scan and plan with that option`);
  return { ignore: [...baseline.scanOptions.ignore], entries: [...baseline.scanOptions.entries], warnings: [] };
}
function evaluateVerify(args) {
  const regressionCount2 = Object.values(args.regressions).reduce((sum, value) => sum + value.length, 0);
  const authorizationFailures = [
    ...args.regressions.unauthorizedRemovals,
    ...args.regressions.unauthorizedChanges,
    ...args.regressions.protectedChanges,
    ...args.regressions.unplannedManifestChanges
  ];
  return {
    version: 2,
    tool: "repo-doctor",
    toolVersion: args.toolVersion,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    mode: args.mode,
    ok: args.gates.every((gate) => gate.ok) && regressionCount2 === 0,
    inputs: args.inputs,
    candidateSnapshot: args.candidateSnapshot,
    finalSnapshot: args.finalSnapshot,
    gates: args.gates,
    regressions: args.regressions,
    healthChanges: args.healthChanges ?? [],
    authorizationFailures,
    comparison: args.comparison,
    warnings: args.warnings
  };
}

// scripts/scan.ts
import { existsSync as existsSync4, readFileSync as readFileSync3, realpathSync as realpathSync3 } from "node:fs";
import { execFileSync as execFileSync3 } from "node:child_process";
import { basename, join as join5, posix as posix4, relative as relative3, resolve as resolve3 } from "node:path";

// scripts/lib/catalogs.ts
var BIN_TO_PACKAGE = {
  astro: "astro",
  changeset: "@changesets/cli",
  commitlint: "@commitlint/cli",
  concurrently: "concurrently",
  "cross-env": "cross-env",
  cypress: "cypress",
  "drizzle-kit": "drizzle-kit",
  esbuild: "esbuild",
  eslint: "eslint",
  husky: "husky",
  jest: "jest",
  "lint-staged": "lint-staged",
  next: "next",
  nodemon: "nodemon",
  nx: "nx",
  playwright: "playwright",
  prettier: "prettier",
  prisma: "prisma",
  rimraf: "rimraf",
  rollup: "rollup",
  storybook: "storybook",
  "svelte-kit": "@sveltejs/kit",
  tailwindcss: "tailwindcss",
  "ts-node": "ts-node",
  tsc: "typescript",
  tsup: "tsup",
  tsx: "tsx",
  turbo: "turbo",
  vercel: "vercel",
  vite: "vite",
  vitest: "vitest",
  webpack: "webpack",
  wrangler: "wrangler"
};
var OVERLAP_FAMILIES = [
  {
    family: "utility belts",
    packages: ["lodash", "lodash-es", "underscore", "ramda"],
    hint: "pick one utility belt; most underscore/ramda call sites have direct lodash equivalents \u2014 lodash-es tree-shakes best in bundlers."
  },
  {
    family: "date libraries",
    packages: ["moment", "dayjs", "date-fns", "luxon"],
    hint: "pick one date library; date-fns and dayjs are the lightest \u2014 migrate call sites incrementally."
  },
  {
    family: "HTTP clients",
    packages: ["axios", "got", "superagent", "node-fetch", "isomorphic-fetch", "ky", "request"],
    hint: "standardize on built-in fetch (Node 18+) or a single client; these overlap almost entirely and request is deprecated."
  },
  {
    family: "class names",
    packages: ["classnames", "clsx"],
    hint: "classnames and clsx are API-compatible \u2014 keep clsx (smaller) and swap the import."
  },
  {
    family: "unique ids",
    packages: ["uuid", "nanoid", "shortid", "cuid", "ulid"],
    hint: "keep one id generator; crypto.randomUUID() already covers plain uuid call sites without any dependency."
  },
  {
    family: "test runners",
    packages: ["jest", "vitest", "mocha", "ava", "jasmine"],
    hint: "one test runner per repo \u2014 a second one doubles config, CI time, and flake surface."
  },
  {
    family: "terminal colors",
    packages: ["chalk", "kleur", "picocolors", "colors", "ansi-colors"],
    hint: "keep one color library; picocolors is the smallest drop-in for chalk-style call sites."
  },
  {
    family: "CLI arg parsers",
    packages: ["commander", "yargs", "minimist", "meow", "arg"],
    hint: "keep one argument parser; node:util parseArgs handles simple CLIs with no dependency at all."
  },
  {
    family: "env loaders",
    packages: ["dotenv", "dotenv-flow", "dotenv-safe"],
    hint: "plain dotenv covers most setups \u2014 the -flow/-safe variants fork its precedence rules and confuse each other."
  },
  {
    family: "deletion utils",
    packages: ["rimraf", "del"],
    hint: "rimraf and del both wrap recursive deletion; node:fs rm(path, { recursive: true, force: true }) usually replaces both."
  },
  {
    family: "state management",
    packages: ["redux", "zustand", "mobx", "jotai", "recoil"],
    hint: "multiple state managers fragment an app's data flow \u2014 consolidate on one store and migrate feature by feature."
  },
  {
    family: "schema validation",
    packages: ["joi", "yup", "zod", "ajv", "superstruct"],
    hint: "pick one schema validator; zod covers most joi/yup/superstruct patterns with better TypeScript inference."
  }
];

// scripts/lib/deps.ts
import { builtinModules } from "node:module";
var DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies"
];
var BUILTINS = new Set(builtinModules);
var TEXT_HIT_CAP = 5;
function isBuiltinModule(spec) {
  return spec.startsWith("node:") || BUILTINS.has(spec);
}
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function loadManifests(cwd, trackedFiles, readFile2) {
  const manifests = [];
  const warnings = [];
  const candidates = trackedFiles.filter(
    (p) => (p === "package.json" || p.endsWith("/package.json")) && !p.split("/").includes("node_modules")
  ).sort();
  for (const path of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(readFile2(path));
    } catch (err) {
      warnings.push(`Skipped unparseable ${path}: ${err.message}`);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      warnings.push(`Skipped ${path}: not a JSON object`);
      continue;
    }
    const raw = parsed;
    const dir = path === "package.json" ? "." : path.slice(0, -"/package.json".length);
    const fields = {};
    for (const field of DEP_FIELDS) {
      const value = raw[field];
      const ranges = {};
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        for (const [name2, range] of Object.entries(value)) {
          if (typeof range === "string") ranges[name2] = range;
        }
      }
      fields[field] = ranges;
    }
    const name = typeof raw["name"] === "string" && raw["name"] !== "" ? raw["name"] : dir;
    manifests.push({ dir, name, raw, fields });
  }
  manifests.sort((a, b) => cmp(a.dir, b.dir));
  return { manifests, warnings };
}
function specifierToPackage(spec) {
  if (spec === "" || spec.startsWith(".") || spec.startsWith("/")) return null;
  if (isBuiltinModule(spec)) return null;
  const segments = spec.split("/");
  const name = spec.startsWith("@") ? segments.length >= 2 && segments[1] !== "" ? `${segments[0]}/${segments[1]}` : null : segments[0];
  if (name === null || name.includes(":")) return null;
  return name;
}
function analyzeDeps(input) {
  const manifests = [...input.manifests].sort((a, b) => cmp(a.dir, b.dir));
  const textFiles = [...input.textFiles].sort((a, b) => cmp(a.path, b.path));
  const importsByManifest = /* @__PURE__ */ new Map();
  const jsxDirs = /* @__PURE__ */ new Set();
  const authoritative = input.resolvedEdges !== void 0;
  const edgeImports = /* @__PURE__ */ new Map();
  const workspaceImports = /* @__PURE__ */ new Map();
  for (const edge of input.resolvedEdges ?? []) {
    if (edge.target !== "external-package" && edge.target !== "workspace-package" || edge.packageName === null) continue;
    edgeImports.set(edge.from, [...edgeImports.get(edge.from) ?? [], { name: edge.packageName, context: edge.context }]);
    if (edge.target === "workspace-package") {
      const owner = owningManifest(manifests, edge.from);
      if (owner) workspaceImports.set(owner.dir, /* @__PURE__ */ new Set([...workspaceImports.get(owner.dir) ?? [], edge.packageName]));
    }
  }
  const importEntries = authoritative ? [...edgeImports.entries()].map(([file, values]) => [file, values.map((value) => value.name)]) : [...input.importsByFile.entries()];
  for (const [file, specs] of importEntries) {
    const owner = owningManifest(manifests, file);
    if (owner === null) continue;
    if (file.endsWith(".jsx") || file.endsWith(".tsx")) jsxDirs.add(owner.dir);
    let byPackage = importsByManifest.get(owner.dir);
    if (byPackage === void 0) {
      byPackage = /* @__PURE__ */ new Map();
      importsByManifest.set(owner.dir, byPackage);
    }
    for (const spec of specs) {
      const pkg = authoritative ? spec : specifierToPackage(spec);
      if (pkg === null) continue;
      let files = byPackage.get(pkg);
      if (files === void 0) {
        files = /* @__PURE__ */ new Set();
        byPackage.set(pkg, files);
      }
      files.add(file);
    }
  }
  const modulePaths = new Set(input.importsByFile.keys());
  const textHitCache = /* @__PURE__ */ new Map();
  const textHitsFor = (manifest, name) => {
    const cacheKey = `${manifest.dir}\0${name}`;
    const cached = textHitCache.get(cacheKey);
    if (cached !== void 0) return cached;
    const re = wordRegex(name);
    const hits = [];
    for (const file of textFiles) {
      if (modulePaths.has(file.path)) continue;
      if (owningManifest(manifests, file.path)?.dir !== manifest.dir) continue;
      if (re.test(file.content)) {
        hits.push(file.path);
        if (hits.length === TEXT_HIT_CAP) break;
      }
    }
    textHitCache.set(cacheKey, hits);
    return hits;
  };
  const binsByPackage = /* @__PURE__ */ new Map();
  for (const [bin, pkg] of Object.entries(BIN_TO_PACKAGE)) {
    binsByPackage.set(pkg, [...binsByPackage.get(pkg) ?? [], bin]);
  }
  const byDir = new Map(manifests.map((m) => [m.dir, m]));
  const packages = [];
  for (const manifest of manifests) {
    const ownedText = textFiles.filter((file) => owningManifest(manifests, file.path)?.dir === manifest.dir);
    const embeddedConfig = (key) => {
      if (!Object.hasOwn(manifest.raw, key)) return [];
      return [{ path: `${manifest.dir === "." ? "" : `${manifest.dir}/`}package.json#${key}`, content: JSON.stringify(manifest.raw[key]) }];
    };
    const scriptsText = scriptsOf(manifest);
    const eslintConfigs = [...ownedText.filter((f) => isConfig(f.path, ".eslintrc", "eslint.config.")), ...embeddedConfig("eslintConfig")];
    const babelConfigs = [...ownedText.filter((f) => isConfig(f.path, ".babelrc", "babel.config.")), ...embeddedConfig("babel")];
    const prettierConfigs = [...ownedText.filter((f) => isConfig(f.path, ".prettierrc", "prettier.config.")), ...embeddedConfig("prettier")];
    const postcssConfigs = [...ownedText.filter((f) => isConfig(f.path, ".postcssrc", "postcss.config.")), ...embeddedConfig("postcss")];
    const jestConfigs = [...ownedText.filter((f) => isConfig(f.path, ".jestrc", "jest.config.")), ...embeddedConfig("jest")];
    const imported = importsByManifest.get(manifest.dir) ?? /* @__PURE__ */ new Map();
    const declared = /* @__PURE__ */ new Set();
    for (const field of DEP_FIELDS) {
      for (const name of Object.keys(manifest.fields[field])) declared.add(name);
    }
    const directlyUsed = /* @__PURE__ */ new Set();
    for (const name of declared) {
      if ((imported.get(name)?.size ?? 0) > 0 || textHitsFor(manifest, name).length > 0) {
        directlyUsed.add(name);
      }
    }
    const implicitReasonFor = (name, range) => {
      if (name === "react" && jsxDirs.has(manifest.dir)) return "JSX runtime";
      const typesBase = typesBaseOf(name);
      if (typesBase !== null) {
        if (typesBase === "node") return "types for the Node.js runtime";
        if (isBuiltinModule(typesBase)) return `types for Node.js builtin "${typesBase}"`;
        if (imported.has(typesBase) || directlyUsed.has(typesBase)) {
          return `types for used package ${typesBase}`;
        }
      }
      for (const bin of binsByPackage.get(name) ?? []) {
        if (wordRegex(bin).test(scriptsText)) return `bin "${bin}" appears in package.json scripts`;
      }
      const genericBins = [name, name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name];
      const scriptBin = genericBins.find((bin) => wordRegex(bin).test(scriptsText));
      if (scriptBin) return `script binary "${scriptBin}" is invoked by package.json scripts`;
      const eslintToken = shorthandToken(name, "eslint-config");
      if (eslintToken !== null) {
        const config = eslintConfigs.find((f) => wordRegex(eslintToken).test(f.content));
        if (config !== void 0) return `eslint config ${config.path} references "${eslintToken}"`;
      }
      const babelToken = shorthandToken(name, "babel-preset");
      if (babelToken !== null) {
        const config = babelConfigs.find((f) => wordRegex(babelToken).test(f.content));
        if (config !== void 0) return `babel config ${config.path} references "${babelToken}"`;
      }
      const eslintPlugin = shorthandToken(name, "eslint-plugin");
      if (eslintPlugin !== null) {
        const config = eslintConfigs.find((f) => wordRegex(eslintPlugin).test(f.content));
        if (config) return `eslint config ${config.path} references plugin "${eslintPlugin}"`;
      }
      const babelPlugin = shorthandToken(name, "babel-plugin");
      if (babelPlugin !== null) {
        const config = babelConfigs.find((f) => wordRegex(babelPlugin).test(f.content));
        if (config) return `babel config ${config.path} references plugin "${babelPlugin}"`;
      }
      if ((name.startsWith("prettier-plugin-") || /^@[^/]+\/prettier-plugin-/.test(name)) && prettierConfigs.length > 0) {
        return `prettier plugin and config ${prettierConfigs[0].path} are package-scoped`;
      }
      if ((name.startsWith("postcss-") || name.endsWith("-postcss")) && postcssConfigs.some((f) => wordRegex(name.replace(/^postcss-/, "")).test(f.content))) {
        return `postcss config ${postcssConfigs[0].path} references this plugin`;
      }
      if ((name.startsWith("jest-") || name.includes("jest")) && jestConfigs.some((f) => wordRegex(name).test(f.content))) {
        return `jest config ${jestConfigs[0].path} references this package`;
      }
      return null;
    };
    const deps = [];
    for (const field of DEP_FIELDS) {
      for (const [name, range] of Object.entries(manifest.fields[field])) {
        deps.push({
          name,
          field,
          range,
          usedBy: [...imported.get(name) ?? []].sort(),
          textHits: [...textHitsFor(manifest, name)],
          implicitReason: implicitReasonFor(name, range),
          evidence: [
            ...[...imported.get(name) ?? []].map((path) => ({ kind: "import", path, detail: `resolved import of ${name}`, context: edgeImports.get(path)?.find((edge) => edge.name === name)?.context ?? "unknown" })),
            ...textHitsFor(manifest, name).map((path) => ({ kind: "config", path, detail: `package-scoped mention of ${name}`, context: "config" })),
            ...implicitReasonFor(name, range) ? [{ kind: "implicit", path: manifest.dir === "." ? "package.json" : `${manifest.dir}/package.json`, detail: implicitReasonFor(name, range), context: "config" }] : []
          ],
          contexts: [...new Set([...imported.get(name) ?? []].map((path) => edgeImports.get(path)?.find((edge) => edge.name === name)?.context ?? "unknown"))]
        });
      }
    }
    deps.sort((a, b) => cmp(a.name, b.name) || DEP_FIELDS.indexOf(a.field) - DEP_FIELDS.indexOf(b.field));
    const used = /* @__PURE__ */ new Set();
    for (const d of deps) {
      if (d.usedBy.length > 0 || d.textHits.length > 0 || d.implicitReason !== null) used.add(d.name);
    }
    const dynamicOwned = [...input.dynamicImporters ?? []].some((path) => owningManifest(manifests, path)?.dir === manifest.dir);
    const uncertain = dynamicOwned ? [...declared].filter((name) => !used.has(name)).sort() : [];
    const unused = [...declared].filter((name) => !used.has(name) && !uncertain.includes(name)).sort();
    const orphanOnly = [...declared].filter((name) => {
      const evidence = deps.filter((dep) => dep.name === name);
      const files = evidence.flatMap((dep) => dep.usedBy);
      return files.length > 0 && files.every((path) => input.orphanFiles?.has(path)) && evidence.every((dep) => dep.textHits.length === 0 && dep.implicitReason === null);
    }).sort();
    const dualDeclared = Object.keys(manifest.fields.dependencies).filter((name) => name in manifest.fields.devDependencies).sort();
    const missing = [];
    for (const [pkg, importers] of imported) {
      if (declared.has(pkg)) continue;
      const workspaceTarget = manifests.find(
        (candidate) => candidate.name === pkg && candidate.dir !== manifest.dir && (candidate.projectRoot ?? candidate.dir) === (manifest.projectRoot ?? manifest.dir)
      );
      const workspaceImport = authoritative ? workspaceImports.get(manifest.dir)?.has(pkg) ?? false : workspaceTarget !== void 0 || input.workspacePkgNames.has(pkg);
      missing.push({
        name: pkg,
        importers: [...importers].sort(),
        declaredIn: nearestDeclaringAncestor(byDir, manifest.dir, manifest.projectRoot ?? ".", pkg),
        kind: workspaceImport ? "workspace" : "external",
        workspaceTargetDir: workspaceTarget?.dir ?? null,
        suggestedField: null,
        suggestedRange: workspaceImport ? "workspace:*" : null
      });
    }
    missing.sort((a, b) => cmp(a.name, b.name));
    packages.push({
      dir: manifest.dir,
      name: manifest.name,
      manifest: manifest.raw,
      projectRoot: manifest.projectRoot ?? ".",
      projectKind: manifest.projectKind ?? "unmanaged",
      deps,
      unused,
      orphanOnly,
      uncertain,
      missing,
      dualDeclared
    });
  }
  return { packages, workspaceSkew: findWorkspaceSkew(manifests) };
}
function owningManifest(manifests, file) {
  const prefixLen = (dir) => dir === "." ? 0 : dir.length;
  let best = null;
  for (const m of manifests) {
    if (m.dir !== "." && !file.startsWith(`${m.dir}/`)) continue;
    if (best === null || prefixLen(m.dir) > prefixLen(best.dir)) best = m;
  }
  return best;
}
function scriptsOf(manifest) {
  const scripts = manifest.raw["scripts"];
  if (typeof scripts !== "object" || scripts === null) return "";
  return Object.values(scripts).filter((v) => typeof v === "string").join("\n");
}
function isConfig(path, dotPrefix, filePrefix) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.startsWith(dotPrefix) || base.startsWith(filePrefix);
}
function typesBaseOf(name) {
  if (!name.startsWith("@types/")) return null;
  const base = name.slice("@types/".length);
  const mangled = base.indexOf("__");
  if (mangled === -1) return base;
  return `@${base.slice(0, mangled)}/${base.slice(mangled + 2)}`;
}
function shorthandToken(name, kind) {
  if (name.startsWith(`${kind}-`)) return name.slice(kind.length + 1);
  const scoped = /^(@[^/]+)\/(.+)$/.exec(name);
  if (scoped !== null && scoped[2] === kind) return scoped[1];
  if (scoped !== null && scoped[2].startsWith(`${kind}-`)) return `${scoped[1]}/${scoped[2].slice(kind.length + 1)}`;
  return null;
}
function nearestDeclaringAncestor(byDir, fromDir, projectRoot, pkg) {
  let dir = fromDir;
  while (dir !== ".") {
    const cut = dir.lastIndexOf("/");
    dir = cut === -1 ? "." : dir.slice(0, cut);
    const ancestor = byDir.get(dir);
    if (ancestor !== void 0 && (ancestor.projectRoot ?? ".") === projectRoot && DEP_FIELDS.some((field) => pkg in ancestor.fields[field])) {
      return ancestor.dir;
    }
    if (dir === projectRoot) break;
  }
  return null;
}
function findWorkspaceSkew(manifests) {
  const rangesByName = /* @__PURE__ */ new Map();
  for (const manifest of manifests) {
    const seen = /* @__PURE__ */ new Set();
    for (const field of DEP_FIELDS) {
      for (const [name, range] of Object.entries(manifest.fields[field])) {
        if (seen.has(name)) continue;
        seen.add(name);
        const projectRoot = manifest.projectRoot ?? ".";
        const key = `${projectRoot}\0${name}`;
        const entry = rangesByName.get(key) ?? { projectRoot, name, ranges: {} };
        entry.ranges[manifest.dir] = range;
        rangesByName.set(key, entry);
      }
    }
  }
  return [...rangesByName.values()].filter((entry) => new Set(Object.values(entry.ranges)).size >= 2).map((entry) => ({ name: entry.name, ranges: entry.ranges, projectRoot: entry.projectRoot })).sort((a, b) => cmp(a.projectRoot ?? ".", b.projectRoot ?? ".") || cmp(a.name, b.name));
}
function wordRegex(token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lead = /^\w/.test(token) ? "\\b" : "(?<![\\w@])";
  const tail = /\w$/.test(token) ? "\\b(?!-\\w)" : "(?![\\w@])";
  return new RegExp(`${lead}${escaped}${tail}`);
}

// scripts/lib/graph.ts
import { posix as posix2 } from "node:path";

// scripts/lib/imports.ts
var MODULE_EXTS = /* @__PURE__ */ new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"]);
function isModuleFile(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return MODULE_EXTS.has(base.slice(dot + 1).toLowerCase());
}
var FROM_CLAUSE_RE = /(?<![\w$.])(?:import|export)\b[^"'`;()]*?\bfrom\s*(["'])([^"'\n]+)\1/g;
var TYPE_FROM_CLAUSE_RE = /(?<![\w$.])(?:import|export)\s+type\b[^"'`;()]*?\bfrom\s*(["'])([^"'\n]+)\1/g;
var SIDE_EFFECT_RE = /(?<![\w$.])import\s*(["'])([^"'\n]+)\1/g;
var CALL_HEAD_RE = /(?<![\w$.])(?:import|require(?:\s*\.\s*resolve)?)\s*\(\s*/g;
var QUOTED_ARG_RE = /^(["'])([^"'\n]*)\1\s*[,)]/;
var TEMPLATE_ARG_RE = /^`([^`$\n]*)`\s*[,)]/;
var REFERENCE_RE = /^\s*\/\/\/\s*<reference\s+path\s*=\s*(["'])([^"'\n]+)\1/;
var PLACEHOLDER_RE = /\x00S(\d+)\x00/g;
function scrubSource(source) {
  const out = [];
  const values = [];
  const referencePaths = [];
  let i = 0;
  const placeholder = (body) => {
    values.push(body);
    return `\0S${values.length - 1}\0`;
  };
  const scanString = (quote) => {
    let body = "";
    let j = i + 1;
    while (j < source.length) {
      const ch = source[j];
      if (ch === "\\") {
        body += source.slice(j, j + 2);
        j += 2;
      } else if (ch === quote) {
        out.push(quote + placeholder(body) + quote);
        i = j + 1;
        return;
      } else if (ch === "\n") {
        break;
      } else {
        body += ch;
        j += 1;
      }
    }
    out.push(" ");
    i = j;
  };
  const scanTemplate = () => {
    out.push("`");
    i += 1;
    let chunk = "";
    const flush = () => {
      if (chunk.length > 0) out.push(placeholder(chunk));
      chunk = "";
    };
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\") {
        chunk += source.slice(i, i + 2);
        i += 2;
      } else if (ch === "`") {
        flush();
        out.push("`");
        i += 1;
        return;
      } else if (ch === "$" && source[i + 1] === "{") {
        flush();
        out.push("${");
        i += 2;
        scanCode(true);
        if (source[i] === "}") {
          out.push("}");
          i += 1;
        }
      } else {
        chunk += ch;
        i += 1;
      }
    }
    flush();
  };
  const scanCode = (insideInterpolation) => {
    let braceDepth = 0;
    while (i < source.length) {
      const ch = source[i];
      const next = source[i + 1];
      if (ch === "/" && next === "/") {
        const lineStart = source.lastIndexOf("\n", i - 1) + 1;
        let lineEnd = source.indexOf("\n", i);
        if (lineEnd === -1) lineEnd = source.length;
        const ref = REFERENCE_RE.exec(source.slice(lineStart, lineEnd));
        if (ref) referencePaths.push(ref[2]);
        out.push(" ");
        i = lineEnd;
      } else if (ch === "/" && next === "*") {
        out.push(" ");
        i += 2;
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
          if (source[i] === "\n") out.push("\n");
          i += 1;
        }
        if (i < source.length) i += 2;
      } else if (ch === "'" || ch === '"') {
        scanString(ch);
      } else if (ch === "`") {
        scanTemplate();
      } else if (insideInterpolation && ch === "{") {
        braceDepth += 1;
        out.push(ch);
        i += 1;
      } else if (insideInterpolation && ch === "}") {
        if (braceDepth === 0) return;
        braceDepth -= 1;
        out.push(ch);
        i += 1;
      } else {
        out.push(ch);
        i += 1;
      }
    }
  };
  scanCode(false);
  return { code: out.join(""), values, referencePaths };
}
function extractImports(source) {
  const { code, values, referencePaths } = scrubSource(source);
  const specifiers = new Set(referencePaths);
  const dynamicSpecifiers = /* @__PURE__ */ new Set();
  const typeOnlySpecifiers = /* @__PURE__ */ new Set();
  const viteGlobs = /* @__PURE__ */ new Set();
  let hasDynamicNonLiteral = false;
  const recover = (text) => text.replace(PLACEHOLDER_RE, (_m, n) => values[Number(n)] ?? "");
  const firstTopLevelArgument = (text) => {
    let squareDepth = 0;
    let braceDepth = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "[") squareDepth += 1;
      else if (text[index] === "]") squareDepth = Math.max(0, squareDepth - 1);
      else if (text[index] === "{") braceDepth += 1;
      else if (text[index] === "}") braceDepth = Math.max(0, braceDepth - 1);
      else if (text[index] === "," && squareDepth === 0 && braceDepth === 0) return text.slice(0, index).trim();
    }
    return text.trim();
  };
  for (const re of [FROM_CLAUSE_RE, SIDE_EFFECT_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      const spec = recover(m[2]);
      if (spec.length > 0) specifiers.add(spec);
    }
  }
  TYPE_FROM_CLAUSE_RE.lastIndex = 0;
  for (let m = TYPE_FROM_CLAUSE_RE.exec(code); m !== null; m = TYPE_FROM_CLAUSE_RE.exec(code)) {
    const spec = recover(m[2]);
    if (spec.length > 0) typeOnlySpecifiers.add(spec);
  }
  CALL_HEAD_RE.lastIndex = 0;
  for (let m = CALL_HEAD_RE.exec(code); m !== null; m = CALL_HEAD_RE.exec(code)) {
    const arg = code.slice(m.index + m[0].length);
    const quoted = QUOTED_ARG_RE.exec(arg);
    const template = quoted ? null : TEMPLATE_ARG_RE.exec(arg);
    const raw = quoted?.[2] ?? template?.[1];
    if (raw != null) {
      const spec = recover(raw);
      if (spec.length > 0) {
        specifiers.add(spec);
        if (m[0].trimStart().startsWith("import")) dynamicSpecifiers.add(spec);
      }
    } else {
      hasDynamicNonLiteral = true;
    }
  }
  const viteRe = /\bimport\s*\.\s*meta\s*\.\s*glob\s*\(([^)]*)\)/g;
  for (let m = viteRe.exec(code); m !== null; m = viteRe.exec(code)) {
    const arg = firstTopLevelArgument(m[1]);
    const placeholders = [...arg.matchAll(PLACEHOLDER_RE)].map((hit) => recover(hit[0]));
    const literalOnly = /^(["'`]\x00S\d+\x00["'`]|\[\s*(?:["'`]\x00S\d+\x00["'`]\s*,?\s*)*\])$/.test(arg);
    if (!literalOnly || placeholders.length === 0) {
      hasDynamicNonLiteral = true;
      continue;
    }
    for (const pattern of placeholders) viteGlobs.add(pattern);
  }
  return {
    specifiers: [...specifiers].sort(),
    hasDynamicNonLiteral,
    dynamicSpecifiers: [...dynamicSpecifiers].sort(),
    typeOnlySpecifiers: [...typeOnlySpecifiers].sort(),
    referenceSpecifiers: [...new Set(referencePaths)].sort(),
    viteGlobs: [...viteGlobs].sort()
  };
}

// scripts/lib/resolve.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { builtinModules as builtinModules2 } from "node:module";
import { dirname as dirname2, isAbsolute as isAbsolute2, join as join2, posix, relative as relative2, resolve as resolve2 } from "node:path";
var BUILTINS2 = new Set(builtinModules2);
var EXTS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "astro", "d.ts"];
function stripJsonComments(text) {
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
function readJsonc(absPath) {
  if (!existsSync2(absPath)) return null;
  const text = stripJsonComments(readFileSync2(absPath, "utf8")).replace(/,\s*([}\]])/g, "$1");
  const parsed = JSON.parse(text);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
}
function compilerOptionsOf(config) {
  const co = config["compilerOptions"];
  return typeof co === "object" && co !== null ? co : {};
}
function toRepoRel(cwd, absPath) {
  const rel = relative2(cwd, absPath).replace(/\\/g, "/");
  return rel === "" ? "." : rel;
}
function loadTsPaths(cwd, tsconfigPath = "tsconfig.json", issues = []) {
  try {
    const abs = isAbsolute2(tsconfigPath) ? tsconfigPath : join2(cwd, tsconfigPath);
    const load = (path, visiting) => {
      const normalizedPath = resolve2(path);
      if (visiting.has(normalizedPath)) {
        issues.push({ code: "graph.tsconfig-cycle", message: `Configuration extends cycle includes ${toRepoRel(cwd, normalizedPath)}.` });
        return null;
      }
      let raw;
      try {
        raw = readJsonc(normalizedPath);
      } catch (error) {
        issues.push({ code: "graph.tsconfig-unreadable", message: `${toRepoRel(cwd, normalizedPath)} could not be parsed: ${error.message}` });
        return null;
      }
      if (raw === null) {
        issues.push({ code: "graph.tsconfig-unreadable", message: `${toRepoRel(cwd, normalizedPath)} could not be read.` });
        return null;
      }
      const next = new Set(visiting).add(normalizedPath);
      const ownDir = dirname2(normalizedPath);
      const merged = {};
      const extensions = Array.isArray(raw.extends) ? raw.extends : [raw.extends];
      for (const extension of extensions) {
        if (typeof extension !== "string") continue;
        if (!extension.startsWith("./") && !extension.startsWith("../")) {
          issues.push({ code: "graph.tsconfig-unsupported-extends", message: `${toRepoRel(cwd, normalizedPath)} extends non-relative config ${extension}; tracked-only resolution cannot evaluate it.` });
          continue;
        }
        let parentAbs = resolve2(ownDir, extension);
        if (!existsSync2(parentAbs) && !parentAbs.endsWith(".json")) parentAbs += ".json";
        const parent = load(parentAbs, next);
        if (parent === null) return null;
        Object.assign(merged, parent);
      }
      for (const [key, value] of Object.entries(compilerOptionsOf(raw))) {
        merged[key] = { value, dir: ownDir };
      }
      for (const option of ["rootDirs", "moduleSuffixes"]) {
        if (Object.hasOwn(compilerOptionsOf(raw), option)) {
          issues.push({ code: "graph.tsconfig-unsupported-option", message: `${toRepoRel(cwd, normalizedPath)} uses compilerOptions.${option}, which Repo Doctor does not model.` });
        }
      }
      return merged;
    };
    const picks = load(abs, /* @__PURE__ */ new Set());
    if (picks === null) return null;
    const pick = (key) => picks[key] ?? null;
    const basePick = pick("baseUrl");
    const baseAbs = basePick !== null && typeof basePick.value === "string" ? resolve2(basePick.dir, basePick.value) : null;
    const paths = {};
    const pathsPick = pick("paths");
    if (pathsPick !== null && typeof pathsPick.value === "object" && pathsPick.value !== null) {
      const targetBase = baseAbs ?? pathsPick.dir;
      const record2 = pathsPick.value;
      for (const pattern of Object.keys(record2).sort()) {
        const targets = record2[pattern];
        if (!Array.isArray(targets)) continue;
        const rel = targets.filter((t) => typeof t === "string").map((t) => toRepoRel(cwd, resolve2(targetBase, t)));
        if (rel.length > 0) paths[pattern] = rel;
      }
    }
    return { baseUrl: baseAbs === null ? null : toRepoRel(cwd, baseAbs), paths };
  } catch (error) {
    issues.push({ code: "graph.tsconfig-unreadable", message: `${tsconfigPath} could not be resolved: ${error.message}` });
    return null;
  }
}
function normalized(p) {
  return posix.normalize(p).replace(/\/+$/, "");
}
function tryFileCandidates(base, fileSet) {
  if (fileSet.has(base)) return base;
  for (const ext of EXTS) if (fileSet.has(`${base}.${ext}`)) return `${base}.${ext}`;
  if (base.endsWith(".js")) {
    const stem = base.slice(0, -3);
    for (const ext of ["ts", "tsx"]) if (fileSet.has(`${stem}.${ext}`)) return `${stem}.${ext}`;
  }
  const indexBase = base === "." ? "" : `${base}/`;
  for (const ext of EXTS) if (fileSet.has(`${indexBase}index.${ext}`)) return `${indexBase}index.${ext}`;
  return null;
}
function matchTsPath(spec, paths) {
  if (Object.hasOwn(paths, spec)) return { targets: paths[spec], star: "" };
  let best = null;
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
        star: spec.slice(prefix.length, spec.length - suffix.length)
      };
    }
  }
  return best === null ? null : { targets: best.targets, star: best.star };
}
function firstStringLeaf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = firstStringLeaf(item);
      if (hit) return hit;
    }
  } else if (value !== null && typeof value === "object") {
    const record2 = value;
    for (const key of ["import", "require", "node", "default", ...Object.keys(record2).sort()]) {
      const hit = firstStringLeaf(record2[key]);
      if (hit) return hit;
    }
  }
  return null;
}
function matchPackageMap(spec, map) {
  if (map === null || typeof map !== "object" || Array.isArray(map)) return null;
  const record2 = map;
  if (Object.hasOwn(record2, spec)) return firstStringLeaf(record2[spec]);
  let best = null;
  for (const [pattern, value] of Object.entries(record2)) {
    const star = pattern.indexOf("*");
    if (star === -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
    const leaf = firstStringLeaf(value);
    if (!leaf) continue;
    const replacement = spec.slice(prefix.length, spec.length - suffix.length);
    if (best === null || prefix.length > best.prefix) best = { prefix: prefix.length, target: leaf.replace("*", replacement) };
  }
  return best?.target ?? null;
}
function packageOwner(fromFile, packages) {
  return [...packages].filter((pkg) => pkg.dir === "." || fromFile.startsWith(`${pkg.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0] ?? null;
}
function workspacePackageFor(fromFile, spec, packages) {
  const owner = packageOwner(fromFile, packages);
  if (!owner) return packages.find((pkg) => spec === pkg.name || spec.startsWith(`${pkg.name}/`)) ?? null;
  return packages.find(
    (pkg) => (pkg.projectRoot ?? ".") === (owner.projectRoot ?? ".") && (spec === pkg.name || spec.startsWith(`${pkg.name}/`))
  ) ?? null;
}
function resolveSpecifier(fromFile, spec, fileSet, tsPaths, workspacePkgs) {
  if (spec.startsWith("node:") || BUILTINS2.has(spec)) return { kind: "builtin" };
  if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
    const base = normalized(posix.join(posix.dirname(fromFile), spec));
    if (base === ".." || base.startsWith("../")) return { kind: "unresolved" };
    const hit = tryFileCandidates(base, fileSet);
    return hit === null ? { kind: "unresolved" } : { kind: "internal", path: hit };
  }
  if (spec.startsWith("/")) {
    const hit = tryFileCandidates(normalized(spec.replace(/^\/+/, "")), fileSet);
    return hit === null ? { kind: "unresolved" } : { kind: "internal", path: hit };
  }
  if (spec.startsWith("#")) {
    const owner = packageOwner(fromFile, workspacePkgs);
    const mapped = owner ? matchPackageMap(spec, owner.imports) : null;
    if (owner && mapped) {
      const base = normalized(posix.join(owner.dir, mapped.replace(/^\.\//, "")));
      const hit = base.startsWith("../") ? null : tryFileCandidates(base, fileSet);
      return hit ? { kind: "internal", path: hit } : { kind: "unresolved" };
    }
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
    if (tsPaths.baseUrl !== null) {
      const base = normalized(posix.join(tsPaths.baseUrl, spec));
      if (!base.startsWith("../")) {
        const hit = tryFileCandidates(base, fileSet);
        if (hit !== null) return { kind: "internal", path: hit };
      }
    }
  }
  if (spec.startsWith("#")) return { kind: "unresolved" };
  const scopedPackage = workspacePackageFor(fromFile, spec, workspacePkgs);
  for (const pkg of scopedPackage ? [scopedPackage] : []) {
    if (spec === pkg.name) {
      if (pkg.entry !== null) return { kind: "internal", path: pkg.entry };
      for (const ext of EXTS) {
        const index = `${pkg.dir}/index.${ext}`;
        if (fileSet.has(index)) return { kind: "internal", path: index };
      }
      return { kind: "package", name: pkg.name };
    }
    if (spec.startsWith(`${pkg.name}/`)) {
      const subpath = `./${spec.slice(pkg.name.length + 1)}`;
      const exported = matchPackageMap(subpath, pkg.exports);
      if (exported) {
        const exportedBase = normalized(posix.join(pkg.dir, exported.replace(/^\.\//, "")));
        const exportedHit = exportedBase.startsWith("../") ? null : tryFileCandidates(exportedBase, fileSet);
        if (exportedHit) return { kind: "internal", path: exportedHit };
      }
      const base = normalized(posix.join(pkg.dir, spec.slice(pkg.name.length + 1)));
      const hit = base.startsWith("../") ? null : tryFileCandidates(base, fileSet);
      return hit === null ? { kind: "package", name: pkg.name } : { kind: "internal", path: hit };
    }
  }
  const segments = spec.split("/");
  if (spec.startsWith("@")) {
    if (segments.length < 2 || segments[0] === "@" || segments[1] === "") {
      return { kind: "unresolved" };
    }
    return { kind: "package", name: `${segments[0]}/${segments[1]}` };
  }
  return { kind: "package", name: segments[0] };
}

// scripts/lib/graph.ts
var SFC_RE = /\.(?:vue|svelte|astro)$/i;
function isGraphModuleFile(path) {
  return isModuleFile(path) || SFC_RE.test(path);
}
function contextOf(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const segments = path.split("/");
  if (/\.(test|spec)\./.test(base) || segments.some((segment) => TEST_SEGMENTS2.has(segment))) return "test";
  if (/\.(config|rc)\.[cm]?[jt]s$/.test(base) || /^\.?\w+rc\./.test(base)) return "config";
  if (OPS_PREFIXES.some((prefix) => path.startsWith(prefix))) return "tooling";
  if (path.endsWith(".d.ts")) return "type-only";
  return "runtime";
}
function globRegex(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        out += ".*";
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${out}$`);
}
function vitePatternCandidates(raw, tsPaths) {
  const pattern = raw.replace(/^!/, "");
  if (pattern.startsWith(".") || pattern.startsWith("/")) return [pattern];
  if (tsPaths !== null) {
    for (const [alias, targets] of Object.entries(tsPaths.paths)) {
      const star = alias.indexOf("*");
      const prefix = star === -1 ? alias : alias.slice(0, star);
      const suffix = star === -1 ? "" : alias.slice(star + 1);
      if (!pattern.startsWith(prefix) || !pattern.endsWith(suffix)) continue;
      const value = star === -1 ? "" : pattern.slice(prefix.length, pattern.length - suffix.length);
      return targets.map((target) => target.replace("*", value));
    }
    if (tsPaths.baseUrl !== null) return [posix2.join(tsPaths.baseUrl, pattern)];
  }
  return [pattern];
}
function expandViteGlobs(from, patterns, files, tsPaths) {
  const selected = /* @__PURE__ */ new Set();
  for (const raw of patterns.filter((pattern) => !pattern.startsWith("!"))) {
    for (const candidate of vitePatternCandidates(raw, tsPaths)) {
      const rooted = candidate.startsWith("/") ? candidate.slice(1) : candidate.startsWith(".") ? posix2.normalize(posix2.join(posix2.dirname(from), candidate)) : candidate;
      const regex = globRegex(rooted.replace(/^\.\//, ""));
      for (const file of files) {
        if (!regex.test(file)) continue;
        selected.add(file);
      }
    }
  }
  for (const raw of patterns.filter((pattern) => pattern.startsWith("!"))) {
    for (const candidate of vitePatternCandidates(raw, tsPaths)) {
      const rooted = candidate.startsWith("/") ? candidate.slice(1) : candidate.startsWith(".") ? posix2.normalize(posix2.join(posix2.dirname(from), candidate)) : candidate;
      const regex = globRegex(rooted.replace(/^\.\//, ""));
      for (const file of files) {
        if (regex.test(file)) selected.delete(file);
      }
    }
  }
  return [...selected].sort();
}
function buildModuleGraph(input) {
  const fileSet = /* @__PURE__ */ new Set();
  const bytesOf = /* @__PURE__ */ new Map();
  for (const f of input.files) {
    fileSet.add(f.path);
    bytesOf.set(f.path, f.bytes);
  }
  const moduleFiles = input.files.map((f) => f.path).filter(isGraphModuleFile).sort();
  const htmlFiles = input.files.filter((f) => f.ext === "html" || f.ext === "htm").map((f) => f.path).sort();
  const readFailures = /* @__PURE__ */ new Set();
  const readSource = (path) => {
    try {
      return input.readFile(path);
    } catch {
      readFailures.add(path);
      return "";
    }
  };
  const tsDirs = [...input.tsPathsByDir.keys()].filter((d) => d !== ".").sort((a, b) => b.length - a.length || cmp2(a, b));
  const tsPathsFor = (path) => {
    for (const dir of tsDirs) {
      if (path.startsWith(`${dir}/`)) return input.tsPathsByDir.get(dir) ?? null;
    }
    return input.tsPathsByDir.get(".") ?? null;
  };
  const edges = /* @__PURE__ */ new Map();
  const importsByFile = /* @__PURE__ */ new Map();
  const unresolvedByFile = /* @__PURE__ */ new Map();
  const dynamicImporters = [];
  const resolvedEdges = [];
  const graphDiagnostics = [];
  const shebangFiles = /* @__PURE__ */ new Set();
  for (const path of moduleFiles) {
    const source = readSource(path);
    if (source.startsWith("#!")) shebangFiles.add(path);
    const { specifiers, hasDynamicNonLiteral, dynamicSpecifiers, typeOnlySpecifiers, referenceSpecifiers, viteGlobs } = extractImports(source);
    importsByFile.set(path, specifiers);
    if (hasDynamicNonLiteral) {
      dynamicImporters.push(path);
      graphDiagnostics.push({
        code: "graph.dynamic-nonliteral",
        severity: "warning",
        source: "graph",
        message: `${path} contains a non-literal dynamic load; dependency and orphan certainty is reduced for this file.`,
        affects: ["graph", "dependencies"],
        scope: { kind: "file", path }
      });
    }
    const internal = /* @__PURE__ */ new Set();
    const unresolved2 = [];
    const tsPaths = tsPathsFor(path);
    for (const spec of specifiers) {
      const res = resolveSpecifier(path, spec, fileSet, tsPaths, input.workspacePkgs);
      const workspace = workspacePackageFor(path, spec, input.workspacePkgs);
      const sourceKind = referenceSpecifiers.includes(spec) ? "reference" : dynamicSpecifiers.includes(spec) ? "dynamic-literal" : "static";
      const importContext = typeOnlySpecifiers.includes(spec) ? "type-only" : contextOf(path);
      if (res.kind === "internal") {
        internal.add(res.path);
        resolvedEdges.push({
          from: path,
          specifier: spec,
          source: sourceKind,
          context: importContext,
          target: workspace ? "workspace-package" : "file",
          path: res.path,
          packageName: workspace?.name ?? null
        });
      } else if (res.kind === "unresolved") {
        unresolved2.push(spec);
        resolvedEdges.push({ from: path, specifier: spec, source: sourceKind, context: importContext, target: "unresolved", path: null, packageName: null });
      } else if (res.kind === "package") {
        resolvedEdges.push({
          from: path,
          specifier: spec,
          source: sourceKind,
          context: importContext,
          target: workspace ? "workspace-package" : "external-package",
          path: null,
          packageName: res.name
        });
      } else {
        resolvedEdges.push({ from: path, specifier: spec, source: sourceKind, context: importContext, target: "builtin", path: null, packageName: null });
      }
    }
    for (const target of expandViteGlobs(path, viteGlobs, moduleFiles, tsPaths)) {
      internal.add(target);
      resolvedEdges.push({
        from: path,
        specifier: target,
        source: "vite-glob",
        context: contextOf(path),
        target: "file",
        path: target,
        packageName: null
      });
    }
    edges.set(path, [...internal].sort());
    unresolvedByFile.set(path, unresolved2);
  }
  for (const path of readFailures) {
    graphDiagnostics.push({
      code: "graph.source-unreadable",
      severity: "error",
      source: "graph",
      message: `${path} could not be read from the worktree or Git index; graph analysis is blocked for this file.`,
      affects: ["graph", "dependencies"],
      scope: { kind: "file", path }
    });
  }
  for (const path of htmlFiles) edges.set(path, htmlEdges(path, readSource(path), fileSet));
  const entrypoints = collectEntrypoints(input, moduleFiles, htmlFiles, fileSet);
  const reachable = /* @__PURE__ */ new Set();
  const queue = [];
  for (const e of entrypoints) {
    if (!reachable.has(e.path)) {
      reachable.add(e.path);
      queue.push(e.path);
    }
  }
  for (let i = 0; i < queue.length; i += 1) {
    for (const target of edges.get(queue[i]) ?? []) {
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  const orphanSet = new Set(moduleFiles.filter((p) => !reachable.has(p)));
  const importersOf = /* @__PURE__ */ new Map();
  for (const orphan of orphanSet) {
    for (const target of edges.get(orphan) ?? []) {
      if (target === orphan || !orphanSet.has(target)) continue;
      let set = importersOf.get(target);
      if (!set) importersOf.set(target, set = /* @__PURE__ */ new Set());
      set.add(orphan);
    }
  }
  const orphans = [...orphanSet].sort().map((path) => ({
    path,
    bytes: bytesOf.get(path) ?? 0,
    importers: [...importersOf.get(path) ?? []].sort(),
    // The graph has no text corpus — scan.ts fills this from tracked text files.
    pathReferencedBy: [],
    hasShebang: shebangFiles.has(path)
  }));
  const unresolved = [];
  for (const path of moduleFiles) {
    if (!reachable.has(path)) continue;
    for (const spec of unresolvedByFile.get(path) ?? []) {
      unresolved.push({ from: path, specifier: spec });
    }
  }
  unresolved.sort(
    (a, b) => cmp2(a.from, b.from) || cmp2(a.specifier, b.specifier)
  );
  return {
    graph: {
      moduleFiles,
      entrypoints,
      orphans,
      unresolved,
      dynamicImporters,
      resolvedEdges: resolvedEdges.sort((a, b) => cmp2(a.from, b.from) || cmp2(a.specifier, b.specifier)),
      health: { status: graphDiagnostics.length > 0 ? "incomplete" : "complete", diagnostics: graphDiagnostics }
    },
    importsByFile
  };
}
var ROUTE_PREFIXES = ["app/", "pages/", "routes/", "src/app/", "src/pages/", "src/routes/"];
var MIDDLEWARE_RE = /^(?:src\/)?(?:middleware|instrumentation)\.[^/]+$/;
var CONVENTIONAL_ROOT_RE = /^(?:(?:index|server)|src\/(?:index|main|server))\.[^/]+$/;
var CONFIG_RE = /\.config\.[cm]?[jt]s$/;
var RC_RE = /^\.?\w+rc\.[cm]?[jt]s$/;
var TEST_BASENAME_RE = /\.(?:test|spec)\./;
var TEST_SEGMENTS2 = /* @__PURE__ */ new Set(["__tests__", "tests", "test", "e2e", "cypress", "playwright"]);
var STORY_BASENAME_RE = /\.stories\./;
var OPS_PREFIXES = ["scripts/", "tools/", "bin/"];
var OPS_SEGMENTS = /* @__PURE__ */ new Set(["migrations", "prisma", "supabase", "drizzle", "seeds"]);
function collectEntrypoints(input, moduleFiles, htmlFiles, fileSet) {
  const reasons = /* @__PURE__ */ new Map();
  const add = (path, reason) => {
    if (!reasons.has(path)) reasons.set(path, reason);
  };
  const manifests = [...input.manifests].sort((a, b) => cmp2(a.dir, b.dir));
  for (const m of manifests) {
    for (const { field, ref } of manifestRefs(m)) {
      const hit = ref.length === 0 ? null : resolveFileRef(m.dir, ref, fileSet);
      if (hit !== null) add(hit, `package.json ${field}`);
    }
  }
  for (const path of moduleFiles) {
    for (const m of manifests) {
      const rel = relUnder(m.dir, path);
      if (rel === null) continue;
      if (ROUTE_PREFIXES.some((p) => rel.startsWith(p))) add(path, "framework route file");
      else if (MIDDLEWARE_RE.test(rel)) add(path, "framework middleware/instrumentation");
    }
  }
  for (const path of moduleFiles) {
    for (const m of manifests) {
      const rel = relUnder(m.dir, path);
      if (rel !== null && CONVENTIONAL_ROOT_RE.test(rel)) add(path, "conventional root file");
    }
  }
  for (const path of moduleFiles) {
    const base = basenameOf(path);
    if (CONFIG_RE.test(base) || RC_RE.test(base)) add(path, "config file");
  }
  for (const path of moduleFiles) {
    if (TEST_BASENAME_RE.test(basenameOf(path)) || dirSegmentsOf(path).some((s) => TEST_SEGMENTS2.has(s))) {
      add(path, "test file");
    }
  }
  for (const path of moduleFiles) {
    if (STORY_BASENAME_RE.test(basenameOf(path)) || dirSegmentsOf(path).includes(".storybook")) {
      add(path, "storybook file");
    }
  }
  for (const path of moduleFiles) if (path.endsWith(".d.ts")) add(path, "type declaration file");
  for (const path of moduleFiles) {
    if (OPS_PREFIXES.some((p) => path.startsWith(p)) || dirSegmentsOf(path).some((s) => OPS_SEGMENTS.has(s))) {
      add(path, "ops/tooling directory");
    }
  }
  for (const path of htmlFiles) add(path, "html file");
  for (const entry of input.extraEntries) add(posix2.normalize(entry), "user-provided --entry");
  return [...reasons.entries()].map(([path, reason]) => ({ path, reason })).sort((a, b) => cmp2(a.path, b.path));
}
var SCRIPT_FILE_RE = /[\w./-]+\.(?:c|m)?[jt]sx?\b/g;
function manifestRefs(m) {
  const out = [];
  for (const field of ["main", "module", "types"]) {
    const value = m.raw[field];
    if (typeof value === "string") out.push({ field, ref: value });
  }
  for (const field of ["browser", "bin"]) {
    const value = m.raw[field];
    if (typeof value === "string") out.push({ field, ref: value });
    else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const record2 = value;
      for (const key of Object.keys(record2).sort()) {
        if (typeof record2[key] === "string") out.push({ field, ref: record2[key] });
      }
    }
  }
  for (const ref of stringLeaves(m.raw["exports"])) out.push({ field: "exports", ref });
  const scripts = m.raw["scripts"];
  if (typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)) {
    const record2 = scripts;
    for (const key of Object.keys(record2).sort()) {
      const value = record2[key];
      if (typeof value !== "string") continue;
      for (const match of value.matchAll(SCRIPT_FILE_RE)) out.push({ field: "scripts", ref: match[0] });
    }
  }
  return out;
}
function stringLeaves(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (typeof value === "object" && value !== null) {
    const record2 = value;
    return Object.keys(record2).sort().flatMap((key) => stringLeaves(record2[key]));
  }
  return [];
}
var HTML_REF_RE = /\b(?:src|href)\s*=\s*(["'])([^"']+)\1/gi;
function htmlEdges(htmlPath, source, fileSet) {
  const out = /* @__PURE__ */ new Set();
  HTML_REF_RE.lastIndex = 0;
  for (let m = HTML_REF_RE.exec(source); m !== null; m = HTML_REF_RE.exec(source)) {
    const ref = m[2].split(/[?#]/)[0].trim();
    if (ref.length === 0 || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) continue;
    const hit = ref.startsWith("/") ? resolveFileRef(".", ref.replace(/^\/+/, ""), fileSet) : resolveFileRef(posix2.dirname(htmlPath), ref, fileSet);
    if (hit !== null && isGraphModuleFile(hit)) out.add(hit);
  }
  return [...out].sort();
}
function resolveFileRef(fromDir, ref, fileSet) {
  const spec = ref.startsWith("./") || ref.startsWith("../") ? ref : `./${ref}`;
  const res = resolveSpecifier(posix2.join(fromDir, "package.json"), spec, fileSet, null, []);
  return res.kind === "internal" ? res.path : null;
}
function relUnder(dir, path) {
  if (dir === "." || dir === "") return path;
  return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null;
}
function basenameOf(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}
function dirSegmentsOf(path) {
  return path.split("/").slice(0, -1);
}
function cmp2(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// scripts/lib/junk.ts
var BUILD_DIRS = /^(dist|build|out|output|\.next|\.nuxt|\.output|\.svelte-kit|\.vercel|\.netlify|coverage|\.nyc_output|storybook-static|node_modules)$/;
var CACHE_DIRS = /^(\.cache|\.turbo|\.parcel-cache|\.pnpm-store)$/;
var EDITOR_DIRS = /^(\.idea|\.vscode)$/;
var DEBUG_LOGS = /^(npm-debug|yarn-error|yarn-debug|pnpm-debug|lerna-debug)\.log/;
var BACKUP_SUFFIX = /[._-](old|bak|backup|copy|orig|tmp)$/;
var NUMBERED_COPY = / \(\d+\)$/;
var BACKUP_EXTS = /* @__PURE__ */ new Set(["bak", "orig", "rej"]);
var ENV_EXCEPTIONS = /* @__PURE__ */ new Set([".env.example", ".env.template", ".env.sample", ".env.test"]);
var KEY_BACKUP_TOKENS = /* @__PURE__ */ new Set(["old", "bak", "backup", "copy", "orig", "tmp", "rej"]);
function keyMaterialExt(base) {
  const parts = base.toLowerCase().split(".");
  while (parts.length > 1 && KEY_BACKUP_TOKENS.has(parts[parts.length - 1])) parts.pop();
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  return last === "pem" || last === "key" ? last : null;
}
var ARCHIVE_EXTS = /* @__PURE__ */ new Set(["zip", "tar", "gz", "tgz", "rar", "7z", "iso", "dmg", "exe", "jar"]);
var RULES = [
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
    }
  },
  {
    category: "build-artifact",
    match: (_file, _base, dirSegments) => {
      const seg = dirSegments.find((s) => BUILD_DIRS.test(s));
      return seg ? `build output directory "${seg}"` : null;
    }
  },
  {
    category: "cache",
    match: (_file, base, dirSegments) => {
      const seg = dirSegments.find((s) => CACHE_DIRS.test(s));
      if (seg) return `cache directory "${seg}"`;
      return base === ".eslintcache" ? ".eslintcache" : null;
    }
  },
  {
    category: "log",
    match: (_file, base) => {
      if (DEBUG_LOGS.test(base)) return "package-manager debug log";
      return base.endsWith(".log") ? "*.log" : null;
    }
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
    }
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
    }
  },
  {
    category: "binary-or-archive",
    match: (file) => ARCHIVE_EXTS.has(file.ext) ? `archive extension ".${file.ext}"` : null
  },
  {
    category: "generated",
    match: (file, base) => {
      if (base.endsWith(".min.js")) return "minified artifact (*.min.js)";
      if (base.endsWith(".min.css")) return "minified artifact (*.min.css)";
      if (base.endsWith(".bundle.js")) return "bundled artifact (*.bundle.js)";
      return file.ext === "map" ? "source map (*.map)" : null;
    }
  }
];
function findJunk(files) {
  const findings = [];
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
  findings.sort((a, b) => a.path < b.path ? -1 : 1);
  return findings;
}

// scripts/lib/lockfile.ts
import { existsSync as existsSync3 } from "node:fs";
import { join as join3 } from "node:path";
var LOCKFILES = [
  { kind: "pnpm-lock.yaml", pm: "pnpm" },
  { kind: "package-lock.json", pm: "npm" },
  { kind: "npm-shrinkwrap.json", pm: "npm" },
  { kind: "yarn.lock", pm: "yarn" },
  { kind: "bun.lock", pm: "bun" },
  { kind: "bun.lockb", pm: "bun" }
];
function detectLockfile(cwd, trackedFiles) {
  if (trackedFiles === void 0) {
    for (const lockfile of LOCKFILES) if (existsSync3(join3(cwd, lockfile.kind))) return { ...lockfile };
    return null;
  }
  const tracked = trackedFiles ? new Set(trackedFiles) : null;
  const found = LOCKFILES.filter((lockfile) => tracked ? tracked.has(lockfile.kind) : existsSync3(join3(cwd, lockfile.kind)));
  if (found.length !== 1) return null;
  return found[0] ? { ...found[0] } : null;
}
var lockDiagnostic = (code, message) => ({
  code,
  severity: "error",
  source: "lockfile",
  message,
  affects: ["lockfile"],
  scope: { kind: "project", path: "." }
});
function parseLockfile(kind, rawContent) {
  const content = rawContent.replace(/\r\n?/g, "\n");
  try {
    if (kind === "package-lock.json" || kind === "npm-shrinkwrap.json") {
      const parsed = JSON.parse(content);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { dialect: "npm-invalid", parseStatus: "invalid", versions: /* @__PURE__ */ new Map(), diagnostics: [lockDiagnostic("lockfile.invalid-npm", "npm lockfile must contain a JSON object.")] };
      }
      const raw = parsed;
      if (raw.lockfileVersion !== void 0 && typeof raw.lockfileVersion !== "number") {
        return { dialect: "npm-invalid", parseStatus: "invalid", versions: /* @__PURE__ */ new Map(), diagnostics: [lockDiagnostic("lockfile.invalid-npm-version", "npm lockfileVersion must be numeric.")] };
      }
      const version = typeof raw.lockfileVersion === "number" ? raw.lockfileVersion : 1;
      if (![1, 2, 3].includes(version)) {
        return { dialect: `npm-v${version}`, parseStatus: "unsupported", versions: /* @__PURE__ */ new Map(), diagnostics: [lockDiagnostic("lockfile.unsupported-npm-version", `Unsupported npm lockfileVersion ${version}.`)] };
      }
      return { dialect: `npm-v${version}`, parseStatus: "parsed", versions: parseNpmLock(content), diagnostics: [] };
    }
    if (kind === "pnpm-lock.yaml") {
      const match = /^lockfileVersion:\s*["']?([^"'\s]+)["']?/m.exec(content);
      if (!match) return { dialect: "pnpm-unknown", parseStatus: "invalid", versions: /* @__PURE__ */ new Map(), diagnostics: [lockDiagnostic("lockfile.invalid-pnpm", "pnpm lockfile has no lockfileVersion.")] };
      const major = Number(match[1].split(".")[0]);
      if (![5, 6, 7, 8, 9].includes(major)) return { dialect: `pnpm-v${match[1]}`, parseStatus: "unsupported", versions: /* @__PURE__ */ new Map(), diagnostics: [lockDiagnostic("lockfile.unsupported-pnpm-version", `Unsupported pnpm lockfileVersion ${match[1]}.`)] };
      return { dialect: `pnpm-v${match[1]}`, parseStatus: "parsed", versions: parsePnpmLock(content), diagnostics: [] };
    }
    if (kind === "yarn.lock") {
      const berry = /^__metadata:\s*$/m.test(content);
      if (berry) {
        const metadataVersion = /^__metadata:\s*\n\s+version:\s*([0-9]+)/m.exec(content)?.[1];
        if (metadataVersion !== void 0 && ![6, 8].includes(Number(metadataVersion))) {
          return { dialect: `yarn-berry-v${metadataVersion}`, parseStatus: "unsupported", versions: /* @__PURE__ */ new Map(), diagnostics: [lockDiagnostic("lockfile.unsupported-yarn-version", `Unsupported Yarn Berry lockfile version ${metadataVersion}.`)] };
        }
        return { dialect: "yarn-berry", parseStatus: "parsed", versions: parseYarnBerryLock(content), diagnostics: [] };
      }
      if (content.trim() !== "" && !/^#\s*yarn lockfile v1\b/m.test(content)) {
        return { dialect: "yarn-classic", parseStatus: "invalid", versions: /* @__PURE__ */ new Map(), diagnostics: [lockDiagnostic("lockfile.invalid-yarn-classic", "Yarn Classic lockfile is missing its v1 header.")] };
      }
      return { dialect: "yarn-classic", parseStatus: "parsed", versions: parseYarnLock(content), diagnostics: [] };
    }
    if (kind === "bun.lock" || kind === "bun.lockb") {
      return { dialect: kind, parseStatus: "unsupported", versions: /* @__PURE__ */ new Map(), diagnostics: [lockDiagnostic("lockfile.unsupported-bun-dialect", `${kind} is detected for gate selection, but duplicate-version analysis is unavailable.`)] };
    }
    return { dialect: kind, parseStatus: "unsupported", versions: /* @__PURE__ */ new Map(), diagnostics: [lockDiagnostic("lockfile.unsupported-dialect", `Unsupported lockfile dialect: ${kind}.`)] };
  } catch (error) {
    return { dialect: kind, parseStatus: "invalid", versions: /* @__PURE__ */ new Map(), diagnostics: [lockDiagnostic("lockfile.invalid", `${kind} could not be parsed: ${error.message}`)] };
  }
}
function findLockfileDuplicates(versions) {
  return [...versions.entries()].filter(([, set]) => set.size >= 2).map(([name, set]) => ({ name, versions: [...set].sort(compareVersions) })).sort((a, b) => b.versions.length - a.versions.length || (a.name < b.name ? -1 : 1));
}
function parsePnpmLock(content) {
  const versions = /* @__PURE__ */ new Map();
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
    if (key.startsWith("'") && key.endsWith("'") || key.startsWith('"') && key.endsWith('"')) {
      key = key.slice(1, -1);
    }
    if (key.startsWith("/")) key = key.slice(1);
    const paren = key.indexOf("(");
    if (paren !== -1) key = key.slice(0, paren);
    const at = key.lastIndexOf("@");
    const slash = key.lastIndexOf("/");
    const separator = at > 0 ? at : slash;
    if (separator <= 0) continue;
    const name = at > 0 ? descriptorName(key, at) : key.slice(0, slash);
    const version = key.slice(separator + 1);
    if (!/^\d/.test(version)) continue;
    addVersion(versions, name, version);
  }
  return versions;
}
function parseNpmLock(content) {
  const versions = /* @__PURE__ */ new Map();
  let raw;
  try {
    raw = JSON.parse(content);
  } catch {
    return versions;
  }
  if (typeof raw !== "object" || raw === null) return versions;
  const lock = raw;
  if (typeof lock.packages === "object" && lock.packages !== null) {
    for (const [key, entry] of Object.entries(lock.packages)) {
      const cut = key.lastIndexOf("node_modules/");
      if (cut === -1) continue;
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
function versionOf(entry) {
  if (typeof entry !== "object" || entry === null) return null;
  const version = entry.version;
  return typeof version === "string" && version !== "" ? version : null;
}
function collectLegacyDeps(tree, versions) {
  if (typeof tree !== "object" || tree === null) return;
  for (const [name, entry] of Object.entries(tree)) {
    const version = versionOf(entry);
    if (version !== null) addVersion(versions, name, version);
    if (typeof entry === "object" && entry !== null) {
      collectLegacyDeps(entry.dependencies, versions);
    }
  }
}
function parseYarnLock(content) {
  const versions = /* @__PURE__ */ new Map();
  let pending = [];
  for (const line of content.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    if (!line.startsWith(" ")) {
      pending = [];
      if (!line.endsWith(":")) continue;
      for (const spec of line.slice(0, -1).split(",")) {
        let cleaned = spec.trim();
        if (cleaned.startsWith('"') && cleaned.endsWith('"')) cleaned = cleaned.slice(1, -1);
        const at = cleaned.lastIndexOf("@");
        if (at <= 0) continue;
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
function parseYarnBerryLock(content) {
  const versions = /* @__PURE__ */ new Map();
  let pending = [];
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
function addVersion(versions, name, version) {
  let set = versions.get(name);
  if (set === void 0) {
    set = /* @__PURE__ */ new Set();
    versions.set(name, set);
  }
  set.add(version);
}
function descriptorName(value, versionAt) {
  const firstAt = value.startsWith("@") ? value.indexOf("@", 1) : value.indexOf("@");
  if (firstAt <= 0 || firstAt >= versionAt) return value.slice(0, versionAt);
  return value.slice(0, firstAt);
}
function compareVersions(a, b) {
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

// scripts/lib/projects.ts
import { posix as posix3 } from "node:path";
var LOCKS = {
  "pnpm-lock.yaml": "pnpm",
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun"
};
function diagnostic(code, message, path = ".") {
  return {
    code,
    severity: "error",
    source: "workspace",
    message,
    affects: ["workspace", "dependencies", "lockfile"],
    scope: { kind: path === "." ? "repo" : "project", path }
  };
}
function parseManager(value) {
  if (typeof value !== "string") return null;
  const match = /^(pnpm|npm|yarn|bun)(?:@(.+))?$/.exec(value.trim());
  return match ? { name: match[1], version: match[2] ?? null } : null;
}
function globRegex2(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        out += ".*";
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else if (ch === "{") {
      const end = pattern.indexOf("}", i + 1);
      if (end !== -1) {
        const values = pattern.slice(i + 1, end).split(",").map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        out += `(?:${values.join("|")})`;
        i = end;
      } else out += "\\{";
    } else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${out}/?$`);
}
function matchesWorkspace(dir, patterns) {
  let included = false;
  for (const raw of patterns) {
    const negative = raw.startsWith("!");
    const pattern = raw.replace(/^!/, "").replace(/^\.\//, "").replace(/\/$/, "");
    if (globRegex2(pattern).test(dir)) included = !negative;
  }
  return included;
}
function manifestPatterns(root, pnpmWorkspaceText) {
  const value = root.raw.workspaces;
  const fromManifest = Array.isArray(value) ? value.filter((v) => typeof v === "string") : value && typeof value === "object" && Array.isArray(value.packages) ? value.packages.filter((v) => typeof v === "string") : [];
  if (pnpmWorkspaceText === null) return fromManifest;
  const fromPnpm = [];
  let inPackages = false;
  for (const rawLine of pnpmWorkspaceText.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;
    const match = inPackages ? /^\s*-\s*["']?([^"']+?)["']?\s*$/.exec(line) : null;
    if (match) fromPnpm.push(match[1]);
  }
  return fromPnpm.length > 0 ? fromPnpm : fromManifest;
}
function resolveManager(root, rootDir, tracked) {
  const declared = parseManager(root.raw.packageManager);
  const locks = Object.entries(LOCKS).map(([name, manager]) => ({ path: rootDir === "." ? name : `${rootDir}/${name}`, manager })).filter(({ path }) => tracked.has(path));
  const conflicts = [];
  if (root.raw.packageManager !== void 0 && declared === null) {
    conflicts.push(`invalid packageManager declaration ${JSON.stringify(root.raw.packageManager)}`);
  }
  if (declared && locks.some((lock) => lock.manager !== declared.name)) {
    conflicts.push(`packageManager declares ${declared.name} but tracked lockfile(s) belong to ${locks.map((lock) => lock.manager).join(", ")}`);
  }
  if (locks.length > 1) conflicts.push(`multiple package-manager lockfiles are tracked: ${locks.map((lock) => lock.path).join(", ")}`);
  if (conflicts.length > 0) {
    return { status: "ambiguous", name: null, version: null, source: null, lockfilePath: null, conflicts };
  }
  if (declared) {
    return {
      status: "resolved",
      name: declared.name,
      version: declared.version,
      source: "packageManager",
      lockfilePath: locks.find((lock) => lock.manager === declared.name)?.path ?? null,
      conflicts: []
    };
  }
  if (locks.length === 1) {
    return { status: "resolved", name: locks[0].manager, version: null, source: "single-lockfile", lockfilePath: locks[0].path, conflicts: [] };
  }
  return { status: "none", name: null, version: null, source: null, lockfilePath: null, conflicts: [] };
}
function discoverProjects(args) {
  const manifests = [...args.manifests].sort((a, b) => a.dir.localeCompare(b.dir));
  const root = manifests.find((manifest) => manifest.dir === ".");
  const tracked = new Set(args.trackedFiles);
  const diagnostics = [];
  if (!root) return { projects: [], diagnostics: [diagnostic("workspace.no-root-manifest", "No tracked root package.json; dependency mutations are unavailable.")] };
  const pnpmWorkspaceText = tracked.has("pnpm-workspace.yaml") ? args.readFile("pnpm-workspace.yaml") : null;
  const patterns = manifestPatterns(root, pnpmWorkspaceText);
  const members = manifests.filter((manifest) => manifest.dir !== "." && matchesWorkspace(manifest.dir, patterns));
  const assigned = /* @__PURE__ */ new Set([".", ...members.map((manifest) => manifest.dir)]);
  const rootKind = patterns.length > 0 ? "workspace" : "standalone";
  const rootManager = resolveManager(root, ".", tracked);
  if (rootManager.status === "ambiguous") diagnostics.push(diagnostic("workspace.manager-ambiguous", rootManager.conflicts.join("; ")));
  const projects = [{
    rootDir: ".",
    kind: rootKind,
    manager: rootManager,
    workspacePatterns: patterns,
    packageDirs: [".", ...members.map((manifest) => manifest.dir)].sort(),
    packageNames: [root, ...members].map((manifest) => manifest.name).sort(),
    workspaceSkew: [],
    lockfile: {
      path: rootManager.lockfilePath,
      dialect: rootManager.lockfilePath ? posix3.basename(rootManager.lockfilePath) : null,
      parseStatus: rootManager.lockfilePath ? "parsed" : "not-applicable",
      diagnostics: []
    },
    diagnostics: rootManager.conflicts.map((message) => diagnostic("workspace.manager-conflict", message))
  }];
  for (const manifest of manifests.filter((candidate) => !assigned.has(candidate.dir))) {
    const manager = resolveManager(manifest, manifest.dir, tracked);
    const hasBoundary = manager.status !== "none";
    projects.push({
      rootDir: manifest.dir,
      kind: hasBoundary ? "standalone" : "unmanaged",
      manager,
      workspacePatterns: [],
      packageDirs: [manifest.dir],
      packageNames: [manifest.name],
      workspaceSkew: [],
      lockfile: {
        path: manager.lockfilePath,
        dialect: manager.lockfilePath ? posix3.basename(manager.lockfilePath) : null,
        parseStatus: manager.lockfilePath ? "parsed" : "not-applicable",
        diagnostics: []
      },
      diagnostics: hasBoundary ? [] : [diagnostic("workspace.unmanaged-manifest", `Nested ${manifest.dir}/package.json is not declared by a workspace and has no project boundary; dependency mutations are blocked.`, manifest.dir)]
    });
  }
  const names = /* @__PURE__ */ new Map();
  for (const manifest of manifests) names.set(manifest.name, [...names.get(manifest.name) ?? [], manifest.dir]);
  for (const [name, dirs] of names) {
    if (dirs.length < 2) continue;
    const sortedDirs = dirs.sort();
    for (const dir of sortedDirs) {
      const item = {
        ...diagnostic("workspace.duplicate-package-name", `Package name ${name} is duplicated in ${sortedDirs.join(", ")}; dependency mutations are blocked.`, dir),
        scope: { kind: "package", path: dir }
      };
      diagnostics.push(item);
      projects.find((candidate) => candidate.packageDirs.includes(dir))?.diagnostics.push(item);
    }
  }
  for (const project of projects) {
    for (const dir of project.packageDirs) {
      const manifest = manifests.find((candidate) => candidate.dir === dir);
      if (manifest) {
        manifest.projectRoot = project.rootDir;
        manifest.projectKind = project.kind;
      }
    }
  }
  return { projects: projects.sort((a, b) => a.rootDir.localeCompare(b.rootDir)), diagnostics };
}

// scripts/lib/walk.ts
import { createHash as createHash3 } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join as join4 } from "node:path";
var execFileAsync = promisify(execFile);
async function indexEntries(cwd) {
  let stdout;
  try {
    const result = await execFileAsync("git", ["ls-files", "-s", "-z", "--cached"], {
      cwd,
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024
    });
    stdout = Buffer.from(result.stdout);
  } catch {
    return /* @__PURE__ */ new Map();
  }
  const map = /* @__PURE__ */ new Map();
  for (const record2 of Buffer.from(stdout).toString("utf8").split("\0")) {
    if (!record2) continue;
    const match = /^(\d+) ([0-9a-f]+) \d+\t([\s\S]+)$/.exec(record2);
    if (match) map.set(match[3], { mode: match[1], objectId: match[2], path: match[3], preferIndex: false });
  }
  try {
    const status = await execFileAsync("git", ["ls-files", "-v", "-z", "--cached"], { cwd, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
    for (const record2 of Buffer.from(status.stdout).toString("utf8").split("\0")) {
      if (record2.length < 3) continue;
      const marker = record2[0];
      const path = record2.slice(2);
      const entry = map.get(path);
      if (entry) entry.preferIndex = marker === "S" || marker === "s";
    }
  } catch {
  }
  return map;
}
async function readIndexBlob(cwd, path) {
  const { stdout } = await execFileAsync("git", ["show", `:${path}`], {
    cwd,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024
  });
  return Buffer.from(stdout);
}
async function listTrackedFiles(cwd) {
  const res = await run("git", ["ls-files", "-z", "--cached"], { cwd, timeoutMs: 12e4 });
  if (res.code !== 0) {
    const detail = res.stderr.trim().split("\n")[0] || `git exited with code ${res.code}`;
    throw new Error(`${cwd} is not a git repository (or git failed): ${detail}`);
  }
  return res.stdout.split("\0").filter((p) => p.length > 0).sort();
}
async function collectFileInfo(cwd, paths, concurrency = 8) {
  const index = await indexEntries(cwd);
  const infos = await pool(paths, concurrency, async (relPath) => {
    const trackedEntry = index.get(relPath);
    const entry = trackedEntry ?? { mode: "100644", objectId: "worktree-only", path: relPath, preferIndex: false };
    if (entry.mode === "160000") return null;
    try {
      if (trackedEntry?.preferIndex) {
        const buf2 = await readIndexBlob(cwd, relPath);
        return {
          path: relPath,
          bytes: buf2.byteLength,
          hash: createHash3("sha256").update(buf2).digest("hex"),
          objectId: entry.objectId,
          mode: entry.mode,
          ext: extOf(relPath),
          symlink: entry.mode === "120000",
          fromIndex: true
        };
      }
      const abs = join4(cwd, relPath);
      const stats = await lstat(abs);
      if (stats.isSymbolicLink()) {
        const target = await readlink(abs);
        return {
          path: relPath,
          bytes: stats.size,
          hash: createHash3("sha256").update(target).digest("hex"),
          ...trackedEntry ? { objectId: entry.objectId, mode: entry.mode } : {},
          ext: extOf(relPath),
          symlink: true
        };
      }
      const buf = await readFile(abs);
      return {
        path: relPath,
        bytes: buf.byteLength,
        hash: createHash3("sha256").update(buf).digest("hex"),
        ...trackedEntry ? { objectId: entry.objectId, mode: entry.mode } : {},
        ext: extOf(relPath),
        symlink: false
      };
    } catch {
      try {
        const buf = await readIndexBlob(cwd, relPath);
        const symlink = entry.mode === "120000";
        return {
          path: relPath,
          bytes: buf.byteLength,
          hash: createHash3("sha256").update(buf).digest("hex"),
          objectId: entry.objectId,
          mode: entry.mode,
          ext: extOf(relPath),
          symlink,
          fromIndex: true
        };
      } catch {
        return null;
      }
    }
  });
  return infos.filter((i) => i !== null).sort(byPath);
}
function findDuplicates(files, minBytes = 1) {
  const byHash = /* @__PURE__ */ new Map();
  for (const f of files) {
    if (f.symlink || f.bytes < minBytes) continue;
    const members = byHash.get(f.hash);
    if (members) members.push(f);
    else byHash.set(f.hash, [f]);
  }
  const groups = [];
  for (const [hash, members] of byHash) {
    if (members.length < 2) continue;
    const paths = members.map((m) => m.path).sort();
    groups.push({
      hash,
      bytes: members[0].bytes,
      paths,
      wastedBytes: members[0].bytes * (paths.length - 1)
    });
  }
  groups.sort((a, b) => b.wastedBytes - a.wastedBytes || (a.hash < b.hash ? -1 : 1));
  return groups;
}
function largestFiles(files, n) {
  return [...files].sort((a, b) => b.bytes - a.bytes || byPath(a, b)).slice(0, Math.max(0, n));
}
function byPath(a, b) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
function extOf(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

// scripts/scan.ts
var TOOL_VERSION = "0.2.0";
var TEXT_EXTS = new Set(
  "js,jsx,ts,tsx,mjs,cjs,mts,cts,json,jsonc,json5,yaml,yml,md,mdx,html,htm,css,scss,sass,less,vue,svelte,astro,toml,ini,txt,xml,svg,graphql,gql,prisma,sql,sh,bash,zsh,fish,ps1,py,rb,go,rs,env,cfg,conf,properties,tf,tfvars,mk,cmake,gradle,bat".split(",")
);
var ASSET_EXTS = new Set(
  "png,jpg,jpeg,gif,webp,avif,ico,bmp,tiff,svg,woff,woff2,ttf,otf,eot,mp3,mp4,webm,ogg,wav,pdf".split(
    ","
  )
);
var WELL_KNOWN_ASSET_PREFIXES = [
  "favicon",
  "robots.txt",
  "sitemap",
  "manifest",
  "apple-touch",
  "og-image",
  "opengraph-image",
  "twitter-image",
  "icon",
  "apple-icon"
];
var MAX_TEXT_BYTES = 2 * 1024 * 1024;
var LOCKFILE_NAMES = /* @__PURE__ */ new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb"
]);
var MODULE_EXTS2 = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"];
function firstStringLeaf2(value) {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return null;
  const record2 = value;
  for (const key of ["import", "require", "default"]) {
    const hit = firstStringLeaf2(record2[key]);
    if (hit) return hit;
  }
  for (const v of Object.values(record2)) {
    const hit = firstStringLeaf2(v);
    if (hit) return hit;
  }
  return null;
}
function deriveWorkspacePkgs(manifests, fileSet) {
  const resolveEntry = (dir, candidate) => {
    const base = posix4.normalize(posix4.join(dir === "." ? "" : dir, candidate));
    const tries = [
      base,
      ...MODULE_EXTS2.map((e) => `${base}.${e}`),
      ...MODULE_EXTS2.map((e) => `${base}/index.${e}`)
    ];
    return tries.find((p) => fileSet.has(p)) ?? null;
  };
  const pkgs = [];
  for (const m of manifests) {
    if (typeof m.raw.name !== "string" || m.raw.name.length === 0) continue;
    const exportsRaw = m.raw.exports;
    const dotExport = exportsRaw !== null && typeof exportsRaw === "object" && "." in exportsRaw ? exportsRaw["."] : exportsRaw;
    const candidates = [m.raw.main, m.raw.module, firstStringLeaf2(dotExport)].filter(
      (c) => typeof c === "string" && c.length > 0
    );
    let entry = null;
    for (const c of candidates) {
      entry = resolveEntry(m.dir, c);
      if (entry) break;
    }
    if (!entry) {
      const prefix = m.dir === "." ? "" : `${m.dir}/`;
      entry = MODULE_EXTS2.map((e) => `${prefix}index.${e}`).find((p) => fileSet.has(p)) ?? null;
    }
    pkgs.push({ name: m.raw.name, dir: m.dir, entry, projectRoot: m.projectRoot ?? m.dir, imports: m.raw.imports, exports: m.raw.exports });
  }
  return pkgs.sort((a, b) => a.name < b.name ? -1 : 1);
}
async function runScan(options) {
  const cwd = realpathSync3(resolve3(options.cwd));
  const ignore = options.ignore ?? [];
  const largeCount = options.largeCount ?? 20;
  const minDupBytes = options.minDupBytes ?? 1;
  const concurrency = options.concurrency ?? 8;
  const warnings = [];
  const diagnostics = [];
  const indexOnly = /* @__PURE__ */ new Set();
  try {
    const status = execFileSync3("git", ["ls-files", "-v", "-z", "--cached"], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    for (const record2 of status.split("\0")) if (record2[0] === "S" || record2[0] === "s") indexOnly.add(record2.slice(2));
  } catch {
  }
  const readFile2 = (relPath) => {
    if (indexOnly.has(relPath)) return execFileSync3("git", ["show", `:${relPath}`], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    try {
      return readFileSync3(join5(cwd, relPath), "utf8");
    } catch {
      return execFileSync3("git", ["show", `:${relPath}`], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    }
  };
  const allTracked = await listTrackedFiles(cwd);
  const paths = allTracked.filter((p) => !ignore.some((re) => re.test(p))).sort();
  if (paths.length === 0) {
    throw new Error(
      ignore.length > 0 ? "no tracked files left after --ignore filters" : "no git-tracked files found \u2014 is this an empty repository?"
    );
  }
  const files = (await collectFileInfo(cwd, paths, concurrency)).sort(
    (a, b) => a.path < b.path ? -1 : 1
  );
  if (files.length < paths.length) {
    warnings.push(
      `${paths.length - files.length} tracked file(s) could not be read and were skipped`
    );
    diagnostics.push({
      code: "inventory.unreadable-tracked-files",
      severity: "error",
      source: "inventory",
      message: `${paths.length - files.length} tracked file(s) could not be read from the worktree or Git index.`,
      affects: ["inventory", "graph", "dependencies"],
      scope: { kind: "repo", path: "." }
    });
  }
  const fileSet = new Set(files.map((f) => f.path));
  const loaded = loadManifests(cwd, files.map((f) => f.path), readFile2);
  const manifests = loaded.manifests;
  warnings.push(...loaded.warnings);
  for (const warning of loaded.warnings) diagnostics.push({ code: "dependencies.manifest-unparseable", severity: "error", source: "dependencies", message: warning, affects: ["dependencies", "workspace"], scope: { kind: "repo", path: "." } });
  const discovered = discoverProjects({ manifests, trackedFiles: paths, readFile: readFile2 });
  diagnostics.push(...discovered.diagnostics, ...discovered.projects.flatMap((project) => project.diagnostics));
  const rootConfig = fileSet.has("tsconfig.json") ? "tsconfig.json" : fileSet.has("jsconfig.json") ? "jsconfig.json" : null;
  const configDiagnostics = (issues, scope) => {
    for (const issue of issues) diagnostics.push({
      code: issue.code,
      severity: "error",
      source: "graph",
      message: issue.message,
      affects: ["graph", "dependencies"],
      scope: { kind: scope === "." ? "repo" : "package", path: scope }
    });
  };
  const rootIssues = [];
  const rootTsPaths = rootConfig ? loadTsPaths(cwd, rootConfig, rootIssues) : null;
  configDiagnostics(rootIssues, ".");
  const tsPathsByDir = /* @__PURE__ */ new Map([[".", rootTsPaths]]);
  for (const m of manifests) {
    if (m.dir === ".") continue;
    const tsCfg = `${m.dir}/tsconfig.json`;
    const jsCfg = `${m.dir}/jsconfig.json`;
    const cfg = fileSet.has(tsCfg) ? tsCfg : fileSet.has(jsCfg) ? jsCfg : null;
    const issues = [];
    const loadedConfig = cfg ? loadTsPaths(cwd, cfg, issues) : rootTsPaths;
    configDiagnostics(issues, m.dir);
    tsPathsByDir.set(m.dir, loadedConfig);
  }
  const workspacePkgs = deriveWorkspacePkgs(manifests, fileSet);
  const normalizedEntries = (options.entries ?? []).map((e) => e.replace(/\\/g, "/").replace(/^\.\//, "")).sort();
  for (const e of normalizedEntries) {
    if (!fileSet.has(e)) warnings.push(`--entry ${e} is not a git-tracked file \u2014 ignored as a graph root`);
  }
  const extraEntries = normalizedEntries.filter((e) => fileSet.has(e));
  const { graph, importsByFile } = buildModuleGraph({
    cwd,
    files,
    manifests,
    tsPathsByDir,
    workspacePkgs,
    extraEntries,
    readFile: readFile2
  });
  diagnostics.push(...graph.health.diagnostics);
  const moduleFileSet = new Set(graph.moduleFiles);
  if (graph.moduleFiles.length > 0 && !graph.entrypoints.some((e) => moduleFileSet.has(e.path))) {
    warnings.push(
      "no module entrypoints discovered \u2014 orphan analysis is unreliable; pass --entry <path>"
    );
  }
  const textFiles = [];
  for (const f of files) {
    if (f.bytes > MAX_TEXT_BYTES) continue;
    const known = TEXT_EXTS.has(f.ext);
    if (!known && f.ext !== "") continue;
    try {
      const buf = Buffer.from(readFile2(f.path));
      if (!known && buf.subarray(0, 512).includes(0)) continue;
      const content = buf.toString("utf8");
      textFiles.push({ path: f.path, content, lower: content.toLowerCase() });
    } catch {
      continue;
    }
  }
  for (const orphan of graph.orphans) {
    const refs = [];
    for (const t of textFiles) {
      if (t.path === orphan.path || LOCKFILE_NAMES.has(basename(t.path))) continue;
      if (!t.content.includes(orphan.path)) continue;
      refs.push(t.path);
      if (refs.length === 3) break;
    }
    orphan.pathReferencedBy = refs;
  }
  const depsAnalysis = analyzeDeps({
    manifests,
    importsByFile,
    resolvedEdges: graph.resolvedEdges,
    textFiles: textFiles.filter((t) => {
      const b = basename(t.path);
      return b !== "package.json" && !LOCKFILE_NAMES.has(b);
    }).map((t) => ({ path: t.path, content: t.content })),
    workspacePkgNames: new Set(workspacePkgs.map((p) => p.name)),
    projects: discovered.projects,
    orphanFiles: new Set(graph.orphans.map((orphan) => orphan.path)),
    dynamicImporters: new Set(graph.dynamicImporters)
  });
  for (const project of discovered.projects) {
    project.workspaceSkew = depsAnalysis.workspaceSkew.filter((item) => (item.projectRoot ?? ".") === project.rootDir);
  }
  const lock = detectLockfile(cwd, paths);
  let lockfileDuplicates = [];
  for (const project of discovered.projects) {
    const path = project.manager.lockfilePath;
    if (!path) continue;
    const parsed = parseLockfile(posix4.basename(path), readFile2(path));
    for (const item of parsed.diagnostics) {
      item.scope = { kind: "project", path: project.rootDir };
      diagnostics.push(item);
      warnings.push(item.message);
    }
    const duplicates = findLockfileDuplicates(parsed.versions);
    project.lockfile = { path, dialect: parsed.dialect, parseStatus: parsed.parseStatus, diagnostics: parsed.diagnostics };
    project.lockfileDuplicates = duplicates;
    if (project.rootDir === ".") {
      lockfileDuplicates = duplicates;
    }
  }
  const unreferencedAssets = [];
  for (const f of files) {
    if (!ASSET_EXTS.has(f.ext)) continue;
    if (f.path.startsWith(".github/")) continue;
    const base = basename(f.path);
    const needle = base.toLowerCase();
    if (WELL_KNOWN_ASSET_PREFIXES.some((p) => needle.startsWith(p))) continue;
    const referenced = textFiles.some((t) => t.path !== f.path && t.lower.includes(needle));
    if (!referenced) {
      unreferencedAssets.push({
        path: f.path,
        bytes: f.bytes,
        reason: `basename "${base}" appears in no tracked text file`
      });
    }
  }
  unreferencedAssets.sort((a, b) => a.path < b.path ? -1 : 1);
  const declaredByManifest = manifests.map(
    (m) => {
      const names = /* @__PURE__ */ new Set();
      for (const field of Object.values(m.fields)) for (const n of Object.keys(field)) names.add(n);
      return { dir: m.dir, names };
    }
  );
  const overlaps = [];
  for (const { dir, names } of declaredByManifest) {
    for (const fam of OVERLAP_FAMILIES) {
      const present = fam.packages.filter((p) => names.has(p)).sort();
      if (present.length >= 2) {
        overlaps.push({ family: fam.family, packages: present, packageDir: dir, hint: fam.hint });
      }
    }
  }
  overlaps.sort(
    (a, b) => a.packageDir !== b.packageDir ? a.packageDir < b.packageDir ? -1 : 1 : a.family < b.family ? -1 : 1
  );
  const declaredDeps = declaredByManifest.reduce((s, m) => s + m.names.size, 0);
  const scanOptions = { ignore: ignore.map((re) => re.source), entries: normalizedEntries, largeCount, minDupBytes };
  const source = repositorySnapshot(cwd, files);
  const uniqueDiagnostics = [...new Map(diagnostics.map((item) => [canonicalJson({ code: item.code, source: item.source, scope: item.scope, affects: item.affects, message: item.message }), item])).values()];
  diagnostics.splice(0, diagnostics.length, ...uniqueDiagnostics);
  const lockProjects = discovered.projects.filter((project) => project.lockfile.path !== null);
  const health = {
    inventory: diagnostics.some((item) => item.affects.includes("inventory")) ? "degraded" : "complete",
    graph: graph.moduleFiles.length === 0 ? "not-applicable" : diagnostics.some((item) => item.affects.includes("graph")) ? "degraded" : "complete",
    dependencies: manifests.length === 0 ? "not-applicable" : diagnostics.some((item) => item.affects.includes("dependencies")) ? "degraded" : "complete",
    workspace: manifests.length === 0 ? "not-applicable" : diagnostics.some((item) => item.affects.includes("workspace")) ? "degraded" : "complete",
    lockfile: lockProjects.length === 0 ? "not-applicable" : lockProjects.every((project) => project.lockfile.parseStatus === "parsed") ? "complete" : "degraded"
  };
  const rootProject = discovered.projects.find((project) => project.rootDir === ".");
  return {
    version: 2,
    tool: "repo-doctor",
    toolVersion: TOOL_VERSION,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    cwd,
    source,
    scanOptions,
    scanOptionsDigest: sha256(canonicalJson(scanOptions)),
    health,
    diagnostics,
    projects: discovered.projects,
    packageManager: rootProject?.manager.status === "resolved" ? rootProject.manager.name : null,
    lockfileKind: rootProject?.lockfile.path ?? lock?.kind ?? null,
    totals: {
      trackedFiles: files.length,
      trackedBytes: files.reduce((s, f) => s + f.bytes, 0),
      moduleFiles: graph.moduleFiles.length,
      packages: manifests.length,
      declaredDeps
    },
    files,
    duplicateGroups: findDuplicates(files, minDupBytes),
    graph,
    unreferencedAssets,
    packages: depsAnalysis.packages,
    workspaceSkew: depsAnalysis.workspaceSkew,
    lockfileDuplicates,
    overlaps,
    junk: findJunk(files),
    largeFiles: largestFiles(files, largeCount),
    warnings
  };
}

// scripts/verify.ts
var HELP = `verify \u2014 enforce a reviewed repo-doctor v2 cleanup plan

Usage: node repo-doctor-verify.mjs [options]

Options:
  --cwd <dir>             Target repository (default: current directory)
  --baseline <file>       Bound v2 scan report (default: .repo-doctor/report.json)
  --plan <file>           Reviewed v2 plan (default: .repo-doctor/plan.json)
  --out <file>            Verification JSON (default: .repo-doctor/verify.json)
  --after-out <file>      Authoritative final scan (default: .repo-doctor/report.after.json)
  --run-gates             Opt in to installs and repository scripts
  --trust-repo            Confirm target code is trusted; required with --run-gates/--gate
  --skip-install          Skip frozen install when trusted gates run
  --skip-typecheck        Skip automatic typecheck script
  --skip-build            Skip automatic build script
  --skip-test             Skip automatic test script
  --gate <command>        Custom argv command; replaces automatic script gates (repeatable)
  --pass-env <name>       Forward one environment variable by name (repeatable)
  --inherit-env           Explicitly pass the complete current environment
  --timeout-ms <n>        Per-gate timeout (default: 600000)
  --ignore <regex>        May repeat a baseline ignore only; additions are rejected
  --entry <path>          May repeat a baseline entry only; additions are rejected
  --allow-output-outside-cwd  Permit artifact outputs outside the target root
  --help                  Show this help

Default mode is deterministic static verification and executes no target code.
Exit codes: 0 pass, 1 cleanup/gate regression, 2 usage, trust, binding, or artifact error.`;
function fail(message) {
  console.error(`
verify: ${message}`);
  process.exit(2);
}
function parseVersioned(loaded, kind) {
  const value = loaded.value;
  if (!value || typeof value !== "object" || value.tool !== "repo-doctor") {
    fail(`unrecognized ${kind} artifact: ${loaded.path}`);
  }
  if (value.version === 1) {
    fail(`legacy v1 ${kind} rejected: ${loaded.path} \u2014 re-run scan and plan with repo-doctor 0.2.0`);
  }
  if (value.version !== 2) fail(`unrecognized ${kind} version: ${loaded.path}`);
  try {
    if (kind === "report") assertRepoReportV2(value);
    else assertCleanupPlanV2(value);
  } catch (error) {
    fail(`malformed v2 ${kind}: ${error.message}`);
  }
  return value;
}
function manifestScripts(cwd, report) {
  const dirs = new Set(report.projects.flatMap((project) => project.packageDirs));
  const manifests = [];
  for (const dir of dirs) {
    const path = join6(cwd, dir === "." ? "package.json" : `${dir}/package.json`);
    if (!existsSync5(path)) continue;
    const raw = JSON.parse(readFileSync4(path, "utf8"));
    const scripts = raw.scripts && typeof raw.scripts === "object" ? Object.fromEntries(Object.entries(raw.scripts).filter((entry) => typeof entry[1] === "string")) : {};
    manifests.push({ dir, scripts });
  }
  return manifests;
}
function regressionCount(regressions) {
  return Object.values(regressions).reduce((sum, values) => sum + values.length, 0);
}
function trackedChanges(before, after) {
  const a = new Map(before.files.map((file) => [file.path, file.hash]));
  const b = new Map(after.files.map((file) => [file.path, file.hash]));
  return [.../* @__PURE__ */ new Set([...a.keys(), ...b.keys()])].filter((path) => a.get(path) !== b.get(path)).sort();
}
function enforceMutationFilesystem(cwd, plan, regressions) {
  const approved = plan.items.filter((item) => item.decision.status === "approved").flatMap((item) => item.mutations);
  for (const mutation of approved) {
    if (mutation.kind === "delete-file" && existsSync5(join6(cwd, mutation.path))) {
      regressions.unauthorizedRemovals.push(`${mutation.path} remains on disk after approved delete-file`);
    }
    if (mutation.kind === "untrack-file" && existsSync5(join6(cwd, mutation.path))) {
      const abs = join6(cwd, mutation.path);
      const stat = lstatSync2(abs);
      const bytes = stat.isSymbolicLink() ? readlinkSync(abs) : readFileSync4(abs);
      if (sha256(bytes).replace(/^sha256:/, "") !== mutation.beforeHash) regressions.unauthorizedChanges.push(`${mutation.path} changed before untracking`);
      try {
        execFileSync4("git", ["check-ignore", "-q", "--", mutation.path], { cwd, stdio: "ignore" });
      } catch {
        regressions.unplannedManifestChanges.push(`${mutation.path} was untracked but is not ignored`);
      }
    } else if (mutation.kind === "untrack-file") {
      regressions.unauthorizedRemovals.push(`${mutation.path} was removed instead of untracked`);
    }
  }
  const byIgnorePath = /* @__PURE__ */ new Map();
  for (const mutation of approved) {
    if (mutation.kind !== "untrack-file") continue;
    byIgnorePath.set(mutation.ignorePath, [...byIgnorePath.get(mutation.ignorePath) ?? [], mutation]);
  }
  for (const [ignorePath, mutations] of byIgnorePath) {
    const before = plan.source.baselineHead ? (() => {
      try {
        return execFileSync4("git", ["show", `${plan.source.baselineHead}:${ignorePath}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        return "";
      }
    })() : "";
    const currentPath = join6(cwd, ignorePath);
    const current = existsSync5(currentPath) ? readFileSync4(currentPath, "utf8") : "";
    const baselineLines = new Set(before.replace(/\r\n?/g, "\n").split("\n").filter(Boolean));
    const currentLines = new Set(current.replace(/\r\n?/g, "\n").split("\n").filter(Boolean));
    const approvedLines = new Set(mutations.map((mutation) => mutation.ignorePattern));
    const removed = [...baselineLines].filter((line) => !currentLines.has(line));
    const added = [...currentLines].filter((line) => !baselineLines.has(line) && !approvedLines.has(line));
    const missing = [...approvedLines].filter((line) => !currentLines.has(line));
    if (removed.length > 0 || added.length > 0 || missing.length > 0) {
      regressions.unauthorizedChanges.push(`${ignorePath} differs beyond exact approved ignore additions`);
    }
  }
}
async function verifyMain() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        cwd: { type: "string", default: "." },
        baseline: { type: "string", default: ".repo-doctor/report.json" },
        plan: { type: "string", default: ".repo-doctor/plan.json" },
        out: { type: "string", default: ".repo-doctor/verify.json" },
        "after-out": { type: "string", default: ".repo-doctor/report.after.json" },
        "run-gates": { type: "boolean", default: false },
        "trust-repo": { type: "boolean", default: false },
        "skip-install": { type: "boolean", default: false },
        "skip-typecheck": { type: "boolean", default: false },
        "skip-build": { type: "boolean", default: false },
        "skip-test": { type: "boolean", default: false },
        gate: { type: "string", multiple: true, default: [] },
        "pass-env": { type: "string", multiple: true, default: [] },
        "inherit-env": { type: "boolean", default: false },
        "timeout-ms": { type: "string", default: "600000" },
        ignore: { type: "string", multiple: true, default: [] },
        entry: { type: "string", multiple: true, default: [] },
        "allow-output-outside-cwd": { type: "boolean", default: false },
        help: { type: "boolean", default: false }
      }
    }));
  } catch (error) {
    return fail(error.message);
  }
  if (values.help) {
    console.log(HELP);
    return;
  }
  const cwd = realpathSync4(resolve4(values.cwd));
  const timeoutMs = Number(values["timeout-ms"]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail("--timeout-ms must be a positive safe integer");
  const custom = values.gate;
  const runGates = values["run-gates"];
  const trusted = values["trust-repo"];
  if ((runGates || custom.length > 0) && !trusted) fail("--run-gates and --gate require explicit --trust-repo");
  if (custom.length > 0 && !runGates) fail("--gate also requires --run-gates");
  const allowOutside = values["allow-output-outside-cwd"];
  const reportPath = resolveSafePath(values.baseline, { cwd });
  const planPath = resolveSafePath(values.plan, { cwd });
  const outPath = resolveSafePath(values.out, { cwd, allowOutside, rejectTracked: true });
  const afterPath = resolveSafePath(values["after-out"], { cwd, allowOutside, rejectTracked: true });
  assertDistinctArtifactPaths([reportPath, planPath, outPath, afterPath]);
  const reportLoaded = readJsonArtifact(reportPath, { cwd });
  const planLoaded = readJsonArtifact(planPath, { cwd });
  const baseline = parseVersioned(reportLoaded, "report");
  const plan = parseVersioned(planLoaded, "plan");
  if (plan.source.reportSha256 !== reportLoaded.digest) fail("plan is not bound to these exact report bytes \u2014 regenerate the plan");
  if (plan.source.repositoryId !== baseline.source.repository.id || plan.source.baselineHead !== baseline.source.repository.head || plan.source.inventoryDigest !== baseline.source.inventoryDigest || plan.source.indexDigest !== baseline.source.indexDigest || plan.source.scanOptionsDigest !== baseline.scanOptionsDigest || plan.source.toolVersion !== baseline.toolVersion) {
    fail("plan/report binding fields do not match \u2014 regenerate scan and plan");
  }
  try {
    const expectedPlan = buildPlan(baseline, {
      keep: plan.options.keep,
      approve: plan.options.approve,
      allowDelete: plan.options.allowDelete,
      minConfidence: plan.options.minConfidence,
      reportSha256: reportLoaded.digest
    });
    const comparable = (value) => canonicalJson({ ...value, createdAt: "<ignored>" });
    if (comparable(expectedPlan) !== comparable(plan)) fail("plan contents do not match a plan generated from the bound report and review controls \u2014 regenerate the plan");
  } catch (error) {
    return fail(`invalid or tampered plan: ${error.message}`);
  }
  const identity = repositoryIdentity(cwd);
  if (identity.id !== baseline.source.repository.id) fail("baseline belongs to a different repository");
  assertBaselineHistory(cwd, plan.source.baselineHead);
  if (baseline.toolVersion !== TOOL_VERSION || plan.toolVersion !== TOOL_VERSION) fail(`artifact tool version does not match repo-doctor ${TOOL_VERSION}`);
  let scanOptions;
  try {
    scanOptions = resolveVerifyScanOptions(baseline, values.ignore, values.entry);
  } catch (error) {
    return fail(error.message);
  }
  const ignore = scanOptions.ignore.map((pattern) => new RegExp(pattern));
  const scan = () => runScan({
    cwd,
    ignore,
    entries: scanOptions.entries,
    largeCount: baseline.scanOptions.largeCount,
    minDupBytes: baseline.scanOptions.minDupBytes
  });
  console.error("static preflight: scanning with the exact reviewed options\u2026");
  const candidate = await scan();
  const candidateSnapshot = candidate.source;
  let regressions = verifyAuthorizedChanges(baseline, candidate, plan);
  enforceMutationFilesystem(cwd, plan, regressions);
  const comparison = compareScans(baseline, candidate).comparison;
  const gates = [];
  if (runGates && regressionCount(regressions) === 0) {
    let specs;
    try {
      specs = pickProjectGates(candidate.projects, manifestScripts(cwd, candidate), {
        skipInstall: values["skip-install"],
        custom,
        skipScripts: [
          values["skip-typecheck"] ? "typecheck" : "",
          values["skip-build"] ? "build" : "",
          values["skip-test"] ? "test" : ""
        ]
      });
    } catch (error) {
      return fail(error.message);
    }
    if (specs.length === 0) fail("--run-gates selected no automatic or custom gates");
    for (const spec of specs) {
      console.error(`gate ${spec.name}: ${spec.command.join(" ")}`);
      const result2 = await run(spec.command[0], spec.command.slice(1), {
        cwd: resolve4(cwd, spec.cwd),
        timeoutMs,
        environment: "minimal",
        passEnv: values["pass-env"],
        inheritEnv: values["inherit-env"]
      });
      const combined = `${result2.stdout}
${result2.stderr}`.trim();
      gates.push({
        name: spec.name,
        command: spec.command.join(" "),
        ok: !result2.timedOut && result2.code === 0,
        ms: result2.wallMs,
        output: combined.slice(-4096),
        truncated: result2.stdoutTruncated || result2.stderrTruncated || combined.length > 4096,
        timedOut: result2.timedOut
      });
      if (gates.at(-1).ok) console.error(`\u2713 ${spec.name}`);
      else console.error(`\u2717 ${spec.name}`);
    }
  }
  console.error("authoritative final scan\u2026");
  const final = await scan();
  const finalRegressions = verifyAuthorizedChanges(baseline, final, plan);
  enforceMutationFilesystem(cwd, plan, finalRegressions);
  const induced = trackedChanges(candidate, final);
  if (induced.length > 0) finalRegressions.gateInducedTrackedChanges.push(...induced);
  if (candidate.source.indexDigest !== final.source.indexDigest) finalRegressions.gateInducedTrackedChanges.push("<git-index>");
  if (canonicalJson(candidate.source.gitStatus ?? []) !== canonicalJson(final.source.gitStatus ?? [])) finalRegressions.gateInducedTrackedChanges.push("<git-status>");
  regressions = finalRegressions;
  const result = evaluateVerify({
    mode: runGates ? "full" : "static-only",
    gates,
    regressions,
    comparison: compareScans(baseline, final).comparison,
    warnings: [
      ...scanOptions.warnings,
      ...final.warnings,
      ...values["pass-env"].length > 0 ? [`forwarded environment names: ${values["pass-env"].sort().join(", ")}`] : [],
      ...values["inherit-env"] ? ["full environment inheritance explicitly enabled"] : []
    ],
    inputs: { reportSha256: reportLoaded.digest, planSha256: planLoaded.digest },
    candidateSnapshot,
    finalSnapshot: final.source,
    toolVersion: TOOL_VERSION,
    healthChanges: Object.keys(baseline.health).filter((capability) => baseline.health[capability] !== final.health[capability]).map((capability) => ({ capability, before: baseline.health[capability], after: final.health[capability] }))
  });
  writeArtifactAtomic(afterPath, `${JSON.stringify(final, null, 2)}
`, { cwd, allowOutside, rejectTracked: true });
  writeArtifactAtomic(outPath, `${JSON.stringify(result, null, 2)}
`, { cwd, allowOutside, rejectTracked: true });
  console.error(`verdict written: ${outPath}`);
  if (!result.ok) {
    console.error(`\u2717 VERIFY FAILED: ${regressionCount(result.regressions)} regression(s), ${result.gates.filter((gate) => !gate.ok).length} failed gate(s)`);
    process.exit(1);
  }
  console.error(runGates ? "\u2713 FULL VERIFY PASSED" : "\u2713 STATIC VERIFY PASSED (no target code executed)");
}
verifyMain().catch((error) => fail(error.stack ?? String(error)));
export {
  verifyMain
};
