import type { GateResult, PackageManager, RepoReport, VerifyResult } from "./types.ts";

/**
 * Diff two scan reports for cleanup-caused damage. A regression is a problem
 * the cleanup introduced: an unresolved import, or a hard-missing dependency
 * (imported but declared nowhere, `declaredIn === null`), present after the
 * cleanup but not before. Problems the baseline already had never fail
 * verification, and fixed ones are simply gone — the bar is "no worse", not
 * "perfect". A dep that was hoist-covered before (`declaredIn` set) and loses
 * its covering ancestor DOES count as new: the cleanup broke it.
 */
export function compareScans(
  before: RepoReport,
  after: RepoReport,
): { regressions: VerifyResult["regressions"]; comparison: VerifyResult["comparison"] } {
  const knownUnresolved = new Set(before.graph.unresolved.map((u) => `${u.from}\0${u.specifier}`));
  const newUnresolvedImports = after.graph.unresolved
    .filter((u) => !knownUnresolved.has(`${u.from}\0${u.specifier}`))
    .sort((a, b) =>
      a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.specifier < b.specifier ? -1 : 1,
    );

  const hardMissing = (r: RepoReport): { packageDir: string; name: string }[] =>
    r.packages.flatMap((p) =>
      p.missing
        .filter((m) => m.declaredIn === null)
        .map((m) => ({ packageDir: p.dir, name: m.name })),
    );
  const knownMissing = new Set(hardMissing(before).map((m) => `${m.packageDir}\0${m.name}`));
  const newMissingDeps = hardMissing(after)
    .filter((m) => !knownMissing.has(`${m.packageDir}\0${m.name}`))
    .sort((a, b) =>
      a.packageDir !== b.packageDir ? (a.packageDir < b.packageDir ? -1 : 1) : a.name < b.name ? -1 : 1,
    );

  return {
    regressions: { newUnresolvedImports, newMissingDeps },
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

/** A quality gate verify.ts runs in the target repo. */
export interface GateSpec {
  name: string;
  /** argv array — executed without a shell. */
  command: string[];
  /** Extra environment for this gate, merged over process.env (and CI=true). */
  env?: Record<string, string>;
}

/**
 * Install gates INTENTIONALLY allow a lockfile update: the cleanup just edited
 * package.json manifests, and verify runs with CI=true, where pnpm defaults to
 * --frozen-lockfile (failing ERR_PNPM_OUTDATED_LOCKFILE) and Yarn Berry to
 * immutable installs — both would go red before regressions are even measured.
 * npm install never freezes by default, so it stays unchanged.
 */
const INSTALL_GATES: Record<PackageManager, GateSpec> = {
  pnpm: {
    name: "install (lockfile update allowed)",
    command: ["pnpm", "install", "--no-frozen-lockfile"],
  },
  npm: { name: "install", command: ["npm", "install"] },
  yarn: {
    name: "install (lockfile update allowed)",
    command: ["yarn", "install"],
    env: { YARN_ENABLE_IMMUTABLE_INSTALLS: "false" },
  },
};

/** Script gates probed in the root manifest, in run order. */
const SCRIPT_GATES = ["typecheck", "build", "test"] as const;

/**
 * Decide which quality gates to run, in order: install first (unless skipped,
 * and pm-aware — see INSTALL_GATES for why lockfile updates are allowed), then
 * the root manifest's own typecheck/build/test scripts — a script gate exists
 * only when the target repo defines that script. Custom --gate commands
 * REPLACE the script gates (install still applies); they are split on
 * whitespace, so shell quoting is not supported (documented limitation).
 * With no detected package manager, npm is the universal fallback.
 */
export function pickGates(
  rootManifest: Record<string, unknown> | null,
  pm: PackageManager | null,
  flags: {
    skipInstall: boolean;
    skipTypecheck: boolean;
    skipBuild: boolean;
    skipTest: boolean;
    custom: string[];
  },
): GateSpec[] {
  const manager: PackageManager = pm ?? "npm";
  const gates: GateSpec[] = [];
  if (!flags.skipInstall) {
    const spec = INSTALL_GATES[manager];
    gates.push({
      name: spec.name,
      command: [...spec.command],
      ...(spec.env ? { env: { ...spec.env } } : {}),
    });
  }

  if (flags.custom.length > 0) {
    flags.custom.forEach((raw, i) => {
      const argv = raw.trim().split(/\s+/).filter((t) => t.length > 0);
      if (argv.length > 0) gates.push({ name: `custom-${i + 1}`, command: argv });
    });
    return gates;
  }

  const rawScripts = rootManifest?.scripts;
  const scripts =
    rawScripts !== null && typeof rawScripts === "object"
      ? (rawScripts as Record<string, unknown>)
      : {};
  const skipped: Record<(typeof SCRIPT_GATES)[number], boolean> = {
    typecheck: flags.skipTypecheck,
    build: flags.skipBuild,
    test: flags.skipTest,
  };
  for (const name of SCRIPT_GATES) {
    if (skipped[name]) continue;
    if (typeof scripts[name] !== "string") continue;
    gates.push({ name, command: [manager, "run", name] });
  }
  return gates;
}

/** Re-scan options verify.ts feeds to runScan. `ignore` holds regex SOURCES —
 *  the caller recompiles them with `new RegExp()`. */
export interface VerifyScanOptions {
  ignore: string[];
  entries: string[];
  /** Non-fatal notes, e.g. an older baseline that recorded no scanOptions. */
  warnings: string[];
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Decide the options for verify's re-scan: default to the baseline report's
 * recorded scanOptions — the instrument the baseline was measured with — and
 * let --ignore/--entry flags ADD to that replayed set (deduplicated, baseline
 * order first). Re-scanning with a different instrument hides regressions:
 * without the baseline's --entry roots, a deleted live file inside an
 * --entry-rooted subtree just makes the whole subtree an orphan again instead
 * of a new unresolved import. Baselines from older repo-doctor versions (no or
 * malformed scanOptions) fall back to flags-only plus a warning.
 */
export function resolveVerifyScanOptions(
  baseline: RepoReport,
  flagIgnores: string[],
  flagEntries: string[],
): VerifyScanOptions {
  const recorded = (baseline as { scanOptions?: unknown }).scanOptions;
  const rec =
    recorded !== null && typeof recorded === "object"
      ? (recorded as Record<string, unknown>)
      : null;
  const baseIgnore = rec && isStringArray(rec.ignore) ? rec.ignore : null;
  const baseEntries = rec && isStringArray(rec.entries) ? rec.entries : null;
  const warnings: string[] = [];
  if (baseIgnore === null || baseEntries === null) {
    warnings.push(
      "baseline has no usable scanOptions (older report) — re-scanning with flag-provided --ignore/--entry only; regressions visible only under the baseline's scan options may go unnoticed",
    );
  }
  const merge = (base: string[] | null, flags: string[]): string[] => [
    ...new Set([...(base ?? []), ...flags]),
  ];
  return {
    ignore: merge(baseIgnore, flagIgnores),
    entries: merge(baseEntries, flagEntries),
    warnings,
  };
}

/**
 * Final verdict: verification passes only when every gate exited 0 AND the
 * cleanup introduced zero regressions. Warnings ride along for the record but
 * never fail the run. An empty gate list (all skipped) leaves regressions as
 * the only check.
 */
export function evaluateVerify(args: {
  gates: GateResult[];
  regressions: VerifyResult["regressions"];
  comparison: VerifyResult["comparison"];
  warnings: string[];
}): VerifyResult {
  const { gates, regressions, comparison, warnings } = args;
  const ok =
    gates.every((g) => g.ok) &&
    regressions.newUnresolvedImports.length === 0 &&
    regressions.newMissingDeps.length === 0;
  return {
    version: 1,
    tool: "repo-doctor",
    createdAt: new Date().toISOString(),
    ok,
    gates,
    regressions,
    comparison,
    warnings,
  };
}
