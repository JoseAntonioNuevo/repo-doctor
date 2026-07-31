import { describe, expect, it } from "vitest";
import {
  compareScans,
  evaluateVerify,
  pickGates,
  resolveVerifyScanOptions,
} from "../scripts/lib/verify-core.ts";
import type { GateResult, MissingDep, RepoReport, UnresolvedImport } from "../scripts/lib/types.ts";

function report(over: {
  unresolved?: UnresolvedImport[];
  packages?: { dir: string; missing: MissingDep[] }[];
  totals?: Partial<RepoReport["totals"]>;
  scanOptions?: RepoReport["scanOptions"];
} = {}): RepoReport {
  return {
    version: 1,
    tool: "repo-doctor",
    createdAt: "2026-01-01T00:00:00.000Z",
    cwd: "/repo",
    scanOptions: over.scanOptions ?? { ignore: [], entries: [] },
    packageManager: null,
    lockfileKind: null,
    totals: {
      trackedFiles: 0,
      trackedBytes: 0,
      moduleFiles: 0,
      packages: 0,
      declaredDeps: 0,
      ...over.totals,
    },
    files: [],
    duplicateGroups: [],
    graph: {
      moduleFiles: [],
      entrypoints: [],
      orphans: [],
      unresolved: over.unresolved ?? [],
      dynamicImporters: [],
    },
    unreferencedAssets: [],
    packages: (over.packages ?? []).map((p) => ({
      dir: p.dir,
      name: p.dir,
      deps: [],
      unused: [],
      missing: p.missing,
      dualDeclared: [],
    })),
    workspaceSkew: [],
    lockfileDuplicates: [],
    overlaps: [],
    junk: [],
    largeFiles: [],
    warnings: [],
  };
}

function missing(name: string, declaredIn: string | null): MissingDep {
  return { name, importers: ["src/index.ts"], declaredIn };
}

describe("scan comparison", () => {
  it("flags only unresolved imports the cleanup introduced — pre-existing and fixed ones are not regressions", () => {
    const before = report({
      unresolved: [
        { from: "src/a.ts", specifier: "./always-broken.ts" },
        { from: "src/z.ts", specifier: "./fixed-by-cleanup.ts" },
      ],
    });
    const after = report({
      unresolved: [
        { from: "src/a.ts", specifier: "./always-broken.ts" },
        { from: "src/b.ts", specifier: "./deleted-module.ts" },
      ],
    });
    expect(compareScans(before, after).regressions.newUnresolvedImports).toEqual([
      { from: "src/b.ts", specifier: "./deleted-module.ts" },
    ]);
  });

  it("treats a dep that lost its hoisting ancestor as a new missing dep", () => {
    // Before: covered by the root manifest. After: the cleanup removed the
    // root declaration, so the same import is now declared nowhere.
    const before = report({
      packages: [{ dir: "packages/app", missing: [missing("lodash", ".")] }],
    });
    const after = report({
      packages: [{ dir: "packages/app", missing: [missing("lodash", null)] }],
    });
    expect(compareScans(before, after).regressions.newMissingDeps).toEqual([
      { packageDir: "packages/app", name: "lodash" },
    ]);
  });

  it("ignores missing deps that are still hoist-covered after cleanup", () => {
    const before = report();
    const after = report({
      packages: [{ dir: "packages/app", missing: [missing("lodash", ".")] }],
    });
    expect(compareScans(before, after).regressions.newMissingDeps).toEqual([]);
  });

  it("does not re-report hard-missing deps the baseline already had", () => {
    const both = { packages: [{ dir: ".", missing: [missing("left-pad", null)] }] };
    expect(compareScans(report(both), report(both)).regressions.newMissingDeps).toEqual([]);
  });

  it("sorts regressions by file/dir then name regardless of input order", () => {
    const after = report({
      unresolved: [
        { from: "src/b.ts", specifier: "./y.ts" },
        { from: "src/a.ts", specifier: "./z.ts" },
        { from: "src/a.ts", specifier: "./a.ts" },
      ],
      packages: [
        { dir: "packages/b", missing: [missing("axios", null)] },
        { dir: "packages/a", missing: [missing("zod", null), missing("chalk", null)] },
      ],
    });
    const { regressions } = compareScans(report(), after);
    expect(regressions.newUnresolvedImports.map((u) => `${u.from} ${u.specifier}`)).toEqual([
      "src/a.ts ./a.ts",
      "src/a.ts ./z.ts",
      "src/b.ts ./y.ts",
    ]);
    expect(regressions.newMissingDeps).toEqual([
      { packageDir: "packages/a", name: "chalk" },
      { packageDir: "packages/a", name: "zod" },
      { packageDir: "packages/b", name: "axios" },
    ]);
  });

  it("copies before/after totals into the comparison", () => {
    const before = report({ totals: { trackedFiles: 100, trackedBytes: 5000, declaredDeps: 40 } });
    const after = report({ totals: { trackedFiles: 80, trackedBytes: 3000, declaredDeps: 31 } });
    expect(compareScans(before, after).comparison).toEqual({
      filesBefore: 100,
      filesAfter: 80,
      bytesBefore: 5000,
      bytesAfter: 3000,
      depsBefore: 40,
      depsAfter: 31,
    });
  });
});

describe("gate selection", () => {
  const noSkips = {
    skipInstall: false,
    skipTypecheck: false,
    skipBuild: false,
    skipTest: false,
    custom: [] as string[],
  };
  const allScripts = { scripts: { typecheck: "tsc --noEmit", build: "vite build", test: "vitest run" } };

  it("runs install first, then only the scripts the root manifest defines", () => {
    const gates = pickGates({ scripts: { typecheck: "tsc", test: "vitest run" } }, "pnpm", noSkips);
    expect(gates).toEqual([
      {
        name: "install (lockfile update allowed)",
        command: ["pnpm", "install", "--no-frozen-lockfile"],
      },
      { name: "typecheck", command: ["pnpm", "run", "typecheck"] },
      { name: "test", command: ["pnpm", "run", "test"] },
    ]);
  });

  it("adapts the install command to the package manager", () => {
    expect(pickGates(null, "npm", noSkips)).toEqual([{ name: "install", command: ["npm", "install"] }]);
    expect(pickGates(null, "yarn", noSkips)).toEqual([
      {
        name: "install (lockfile update allowed)",
        command: ["yarn", "install"],
        env: { YARN_ENABLE_IMMUTABLE_INSTALLS: "false" },
      },
    ]);
  });

  // Regression (reviewer scenario): verify runs with CI=true, where pnpm
  // defaults to --frozen-lockfile — after the plan's manifest edits the
  // install gate died with ERR_PNPM_OUTDATED_LOCKFILE and an empty regression
  // list. The install gate must allow the lockfile to update.
  it("pnpm install survives CI=true after manifest edits (no frozen lockfile)", () => {
    const [install] = pickGates(null, "pnpm", noSkips);
    expect(install.command).toContain("--no-frozen-lockfile");
    expect(install.name).toContain("lockfile update allowed");
    expect(install.env).toBeUndefined();
  });

  it("yarn install disables Berry's CI immutable-install default via env", () => {
    const [install] = pickGates(null, "yarn", noSkips);
    expect(install.env).toEqual({ YARN_ENABLE_IMMUTABLE_INSTALLS: "false" });
    expect(install.name).toContain("lockfile update allowed");
  });

  it("npm install carries no env override — npm never freezes by default", () => {
    const [install] = pickGates(null, "npm", noSkips);
    expect(install).toEqual({ name: "install", command: ["npm", "install"] });
    expect(install.env).toBeUndefined();
  });

  it("falls back to npm when no package manager was detected", () => {
    const gates = pickGates({ scripts: { test: "node --test" } }, null, noSkips);
    expect(gates).toEqual([
      { name: "install", command: ["npm", "install"] },
      { name: "test", command: ["npm", "run", "test"] },
    ]);
  });

  it("omits the install gate when skipInstall is set", () => {
    const gates = pickGates(allScripts, "pnpm", { ...noSkips, skipInstall: true });
    expect(gates.map((g) => g.name)).toEqual(["typecheck", "build", "test"]);
  });

  it("skips individual script gates without touching the others", () => {
    const gates = pickGates(allScripts, "pnpm", { ...noSkips, skipTypecheck: true, skipTest: true });
    expect(gates.map((g) => g.name)).toEqual(["install (lockfile update allowed)", "build"]);
  });

  it("replaces script gates with custom gates but keeps install", () => {
    const gates = pickGates(allScripts, "pnpm", { ...noSkips, custom: ["node -e 0"] });
    expect(gates).toEqual([
      {
        name: "install (lockfile update allowed)",
        command: ["pnpm", "install", "--no-frozen-lockfile"],
      },
      { name: "custom-1", command: ["node", "-e", "0"] },
    ]);
  });

  it("splits custom gates on whitespace and drops blank ones", () => {
    const gates = pickGates(null, "pnpm", {
      ...noSkips,
      skipInstall: true,
      custom: ["  pnpm   run  lint  ", "   "],
    });
    expect(gates).toEqual([{ name: "custom-1", command: ["pnpm", "run", "lint"] }]);
  });

  it("ignores non-string script values instead of building a broken command", () => {
    const gates = pickGates({ scripts: { test: { watch: false } } }, "pnpm", noSkips);
    expect(gates.map((g) => g.name)).toEqual(["install (lockfile update allowed)"]);
  });

  it("returns no gates when everything is skipped and nothing is runnable", () => {
    expect(pickGates(null, null, { ...noSkips, skipInstall: true })).toEqual([]);
  });
});

describe("verify re-scan options", () => {
  // Regression (reviewer scenario adv-5-entry-gap): a baseline scanned with
  // --entry could not be replayed — verify re-scanned without the entry root,
  // so deleting a live file inside the --entry-rooted subtree turned the
  // subtree back into orphans instead of a new unresolved import, and verify
  // PASSED. The baseline's recorded scanOptions must drive the re-scan.
  it("replays the baseline's recorded --ignore/--entry scan options by default", () => {
    const baseline = report({
      scanOptions: { ignore: ["^vendor/"], entries: ["scripts/cron-job.ts"] },
    });
    expect(resolveVerifyScanOptions(baseline, [], [])).toEqual({
      ignore: ["^vendor/"],
      entries: ["scripts/cron-job.ts"],
      warnings: [],
    });
  });

  it("flags ADD to the replayed set — baseline first, duplicates collapse", () => {
    const baseline = report({ scanOptions: { ignore: ["^dist/"], entries: ["a.ts"] } });
    const resolved = resolveVerifyScanOptions(baseline, ["^coverage/", "^dist/"], ["a.ts", "b.ts"]);
    expect(resolved.ignore).toEqual(["^dist/", "^coverage/"]);
    expect(resolved.entries).toEqual(["a.ts", "b.ts"]);
    expect(resolved.warnings).toEqual([]);
  });

  it("falls back to flags-only with a warning when an older baseline has no scanOptions", () => {
    const { scanOptions: _omit, ...legacy } = report();
    const resolved = resolveVerifyScanOptions(legacy as unknown as RepoReport, ["^dist/"], ["cli.ts"]);
    expect(resolved.ignore).toEqual(["^dist/"]);
    expect(resolved.entries).toEqual(["cli.ts"]);
    expect(resolved.warnings).toHaveLength(1);
    expect(resolved.warnings[0]).toMatch(/scanOptions/);
  });

  it("treats a malformed scanOptions field as missing instead of crashing", () => {
    const broken = {
      ...report(),
      scanOptions: { ignore: "not-an-array", entries: null },
    } as unknown as RepoReport;
    const resolved = resolveVerifyScanOptions(broken, [], ["x.ts"]);
    expect(resolved.ignore).toEqual([]);
    expect(resolved.entries).toEqual(["x.ts"]);
    expect(resolved.warnings).toHaveLength(1);
  });
});

describe("verify verdict", () => {
  const gate = (name: string, ok: boolean): GateResult => ({
    name,
    command: name,
    ok,
    ms: 10,
    output: "",
  });
  const clean: Parameters<typeof evaluateVerify>[0] = {
    gates: [gate("install", true), gate("test", true)],
    regressions: { newUnresolvedImports: [], newMissingDeps: [] },
    comparison: {
      filesBefore: 2,
      filesAfter: 1,
      bytesBefore: 20,
      bytesAfter: 10,
      depsBefore: 2,
      depsAfter: 1,
    },
    warnings: [],
  };

  it("passes when every gate is green and the cleanup introduced no regressions", () => {
    const result = evaluateVerify(clean);
    expect(result.ok).toBe(true);
    expect(result.tool).toBe("repo-doctor");
    expect(result.gates.map((g) => g.name)).toEqual(["install", "test"]);
  });

  it("fails on a red gate even without regressions", () => {
    expect(evaluateVerify({ ...clean, gates: [gate("install", true), gate("test", false)] }).ok).toBe(
      false,
    );
  });

  it("fails on a regression even when all gates are green", () => {
    const result = evaluateVerify({
      ...clean,
      regressions: {
        newUnresolvedImports: [],
        newMissingDeps: [{ packageDir: ".", name: "lodash" }],
      },
    });
    expect(result.ok).toBe(false);
  });

  it("does not fail on an empty gate list — skip flags may remove every gate", () => {
    expect(evaluateVerify({ ...clean, gates: [] }).ok).toBe(true);
  });

  it("carries warnings through without failing the verdict", () => {
    const result = evaluateVerify({ ...clean, warnings: ["no quality gates selected"] });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(["no quality gates selected"]);
  });
});
