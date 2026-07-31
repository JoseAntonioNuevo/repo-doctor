import { describe, expect, it } from "vitest";
import {
  compareScans,
  emptyRegressions,
  evaluateVerify,
  pickGates,
  resolveVerifyScanOptions,
  verifyAuthorizedChanges,
} from "../scripts/lib/verify-core.ts";
import type { CleanupPlan, RepoReport } from "../scripts/lib/types.ts";

function report(over: Partial<RepoReport> = {}): RepoReport {
  return {
    version: 2,
    tool: "repo-doctor",
    toolVersion: "0.2.0",
    createdAt: "2026-01-01T00:00:00.000Z",
    cwd: "/repo",
    source: { repository: { id: "repo", kind: "git-history", root: "/repo", head: "abc", rootCommits: ["root"] }, inventoryDigest: "inventory", indexDigest: "index", trackedWorktreeClean: true },
    scanOptions: { ignore: [], entries: [], largeCount: 20, minDupBytes: 1 },
    scanOptionsDigest: "options",
    health: { inventory: "complete", graph: "complete", dependencies: "complete", workspace: "complete", lockfile: "not-applicable" },
    diagnostics: [],
    projects: [],
    packageManager: null,
    lockfileKind: null,
    totals: { trackedFiles: 0, trackedBytes: 0, moduleFiles: 0, packages: 0, declaredDeps: 0 },
    files: [], duplicateGroups: [],
    graph: { moduleFiles: [], entrypoints: [], orphans: [], unresolved: [], dynamicImporters: [], resolvedEdges: [], health: { status: "complete", diagnostics: [] } },
    unreferencedAssets: [], packages: [], workspaceSkew: [], lockfileDuplicates: [], overlaps: [], junk: [], largeFiles: [], warnings: [],
    ...over,
  };
}

function plan(over: Partial<CleanupPlan> = {}): CleanupPlan {
  return {
    version: 2, tool: "repo-doctor", toolVersion: "0.2.0", createdAt: "now",
    source: { reportSha256: "report", repositoryId: "repo", baselineHead: "abc", inventoryDigest: "inventory", indexDigest: "index", scanOptionsDigest: "options", toolVersion: "0.2.0" },
    options: { keep: [], approve: [], allowDelete: [], minConfidence: "low" }, diagnostics: [], protectedFiles: [],
    summary: { itemsTotal: 0, itemsRescued: 0, deleteFiles: 0, reviewFiles: 0, removeDeps: 0, reclaimBytes: 0, byAction: {}, byDisposition: { proposed: 0, manual: 0, "review-only": 0, deferred: 0, blocked: 0 }, warnings: [] },
    items: [], ...over,
  };
}

describe("scan comparison", () => {
  it("finds new unresolved imports, missing deps, orphans, and health degradation", () => {
    const before = report();
    const after = report({
      health: { ...before.health, graph: "degraded" },
      graph: { ...before.graph, unresolved: [{ from: "src/a.ts", specifier: "./gone" }], orphans: [{ path: "src/a.ts", bytes: 1, importers: [], pathReferencedBy: [], hasShebang: false }] },
      packages: [{ dir: ".", name: "root", deps: [], unused: [], missing: [{ name: "left-pad", importers: ["src/a.ts"], declaredIn: "." }], dualDeclared: [] }],
    });
    const { regressions } = compareScans(before, after);
    expect(regressions.newUnresolvedImports).toHaveLength(1);
    expect(regressions.newMissingDeps).toEqual([{ packageDir: ".", name: "left-pad" }]);
    expect(regressions.newOrphans).toEqual(["src/a.ts"]);
    expect(regressions.healthErrors).toEqual(["graph: complete -> degraded"]);
  });

  it("detects loss of a hoisting ancestor as a new missing-dependency state", () => {
    const pkg = (declaredIn: string | null) => [{ dir: "app", name: "app", deps: [], unused: [], missing: [{ name: "zod", importers: ["app/a.ts"], declaredIn }], dualDeclared: [] }];
    expect(compareScans(report({ packages: pkg(".") }), report({ packages: pkg(null) })).regressions.newMissingDeps).toEqual([{ packageDir: "app", name: "zod" }]);
  });
});

describe("authorization", () => {
  it("rejects unapproved removal and permits an exact approved hash-bound delete", () => {
    const before = report({ files: [{ path: "dead.ts", bytes: 1, hash: "h", ext: "ts", symlink: false }], totals: { trackedFiles: 1, trackedBytes: 1, moduleFiles: 1, packages: 0, declaredDeps: 0 } });
    expect(verifyAuthorizedChanges(before, report(), plan()).unauthorizedRemovals).toEqual(["dead.ts"]);
    const reviewed = plan({ items: [{ id: "delete-file:dead.ts", action: "delete-file", target: "dead.ts", packageDir: null, confidence: "high", disposition: "proposed", evidence: "dead", evidenceItems: ["dead"], reclaimBytes: 1, rescued: false, keepPattern: null, prerequisites: [], relatedTargets: [], decision: { status: "approved", source: "approve-id", value: "delete-file:dead.ts" }, mutations: [{ kind: "delete-file", path: "dead.ts", beforeHash: "h" }] }] });
    expect(verifyAuthorizedChanges(before, report(), reviewed).unauthorizedRemovals).toEqual([]);
  });
});

describe("safe gates and options", () => {
  it("uses frozen installs and never falls back to npm", () => {
    expect(pickGates(null, null, { skipInstall: false, skipTypecheck: false, skipBuild: false, skipTest: false, custom: [] })).toEqual([]);
    expect(pickGates(null, "pnpm", { skipInstall: false, skipTypecheck: false, skipBuild: false, skipTest: false, custom: [] })[0].command).toEqual(["pnpm", "install", "--frozen-lockfile"]);
    expect(pickGates(null, "npm", { skipInstall: false, skipTypecheck: false, skipBuild: false, skipTest: false, custom: [] })[0].command).toEqual(["npm", "ci"]);
  });

  it("replays exact options and rejects additions", () => {
    const baseline = report({ scanOptions: { ignore: ["^vendor/"], entries: ["cli.ts"], largeCount: 20, minDupBytes: 1 } });
    expect(resolveVerifyScanOptions(baseline, ["^vendor/"], ["cli.ts"])).toMatchObject({ ignore: ["^vendor/"], entries: ["cli.ts"] });
    expect(() => resolveVerifyScanOptions(baseline, ["^secret/"], [])).toThrow(/cannot add --ignore/);
  });
});

describe("v2 verdict", () => {
  it("labels static success and fails any regression", () => {
    const snapshot = report().source;
    const base = { mode: "static-only" as const, gates: [], regressions: emptyRegressions(), comparison: { filesBefore: 1, filesAfter: 1, bytesBefore: 1, bytesAfter: 1, depsBefore: 0, depsAfter: 0 }, warnings: [], inputs: { reportSha256: "r", planSha256: "p" }, candidateSnapshot: snapshot, finalSnapshot: snapshot, toolVersion: "0.2.0" };
    expect(evaluateVerify(base)).toMatchObject({ ok: true, mode: "static-only", version: 2 });
    expect(evaluateVerify({ ...base, regressions: { ...emptyRegressions(), protectedChanges: ["src/live.ts"] } }).ok).toBe(false);
  });
});
