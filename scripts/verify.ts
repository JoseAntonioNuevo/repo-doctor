#!/usr/bin/env -S npx tsx
/**
 * VERIFY — prove the cleaned repository still stands.
 *
 * Re-scans the repo, compares it against the baseline report recorded before
 * cleanup, and runs the target repo's own quality gates (install, typecheck,
 * build, test):
 *   - every gate must exit 0;
 *   - no unresolved import may appear that the baseline did not have;
 *   - no undeclared dependency may appear that the baseline did not have.
 *
 * Fails loudly with a non-zero exit code so it can gate CI.
 *
 * Standalone usage:
 *   npx tsx scripts/verify.ts --baseline .repo-doctor/report.json
 *   npx tsx scripts/verify.ts --skip-install --gate "pnpm run lint"
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { run } from "./lib/exec.ts";
import {
  compareScans,
  evaluateVerify,
  pickGates,
  resolveVerifyScanOptions,
} from "./lib/verify-core.ts";
import { runScan } from "./scan.ts";
import type { GateResult, RepoReport } from "./lib/types.ts";

const HELP = `verify — compare the cleaned repo against the recorded baseline

Usage: npx tsx scripts/verify.ts [options]

Options:
  --cwd <dir>          Target repo root (default: current directory)
  --baseline <file>    Scan report from before the cleanup
                       (default: .repo-doctor/report.json)
  --out <file>         JSON verdict (default: .repo-doctor/verify.json)
  --skip-install       Skip the install gate
  --skip-typecheck     Skip the typecheck script gate
  --skip-build         Skip the build script gate
  --skip-test          Skip the test script gate
  --gate <cmd>         Custom gate command — replaces the script gates
                       (repeatable; split on whitespace, no shell quoting)
  --timeout-ms <n>     Per-gate timeout (default: 600000)
  --ignore <regex>     ADD an ignore pattern to the re-scan (repeatable) —
                       defaults come from the baseline scan's recorded options
  --entry <path>       ADD a module-graph entrypoint to the re-scan, repo-
                       relative (repeatable) — defaults come from the baseline
                       scan's recorded options
  --help               Show this help

The re-scan replays the baseline's --ignore/--entry scan options so both scans
measure with the same instrument; --ignore/--entry here only ADD to that set.
Baselines from older repo-doctor versions carry no scan options — those re-scan
with the flags given here only (a warning is printed).

Exit codes: 0 all gates green and no regressions, 1 verification failed,
2 environment/usage error.`;

/** Tail of combined gate output kept in the verdict JSON. */
const OUTPUT_CAP = 4000;

function fail(msg: string): never {
  console.error(`\nverify: ${msg}`);
  process.exit(2);
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cwd: { type: "string", default: "." },
      baseline: { type: "string", default: ".repo-doctor/report.json" },
      out: { type: "string", default: ".repo-doctor/verify.json" },
      "skip-install": { type: "boolean", default: false },
      "skip-typecheck": { type: "boolean", default: false },
      "skip-build": { type: "boolean", default: false },
      "skip-test": { type: "boolean", default: false },
      gate: { type: "string", multiple: true, default: [] },
      "timeout-ms": { type: "string", default: "600000" },
      ignore: { type: "string", multiple: true, default: [] },
      entry: { type: "string", multiple: true, default: [] },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const cwd = resolve(values.cwd!);
  const baselinePath = resolve(cwd, values.baseline!);
  if (!existsSync(baselinePath)) {
    fail(`baseline report not found: ${baselinePath} — run scan.ts before cleaning.`);
  }
  let baselineRaw: unknown;
  try {
    baselineRaw = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch (err) {
    return fail(`baseline report unreadable: ${baselinePath} — ${(err as Error).message}`);
  }
  if (
    baselineRaw === null ||
    typeof baselineRaw !== "object" ||
    (baselineRaw as { tool?: unknown }).tool !== "repo-doctor" ||
    (baselineRaw as { version?: unknown }).version !== 1
  ) {
    fail(`unrecognized report format in ${baselinePath}`);
  }
  const baseline = baselineRaw as RepoReport;
  const timeoutMs = Number(values["timeout-ms"]);
  if (!(timeoutMs > 0)) fail("--timeout-ms must be a positive number");
  for (const p of values.ignore ?? []) {
    try {
      new RegExp(p);
    } catch {
      fail(`invalid --ignore regex: ${p}`);
    }
  }

  // --- 1. Fresh scan (same instrument as the baseline) ----------------------
  const scanOpts = resolveVerifyScanOptions(baseline, values.ignore ?? [], values.entry ?? []);
  for (const w of scanOpts.warnings) console.error(`⚠️  ${w}`);
  const ignore = scanOpts.ignore.map((p) => {
    try {
      return new RegExp(p);
    } catch {
      return fail(`invalid ignore regex in baseline scanOptions: ${p}`);
    }
  });
  console.error("re-scanning the repository…");
  let after: RepoReport;
  try {
    after = await runScan({ cwd, ignore, entries: scanOpts.entries });
  } catch (err) {
    return fail((err as Error).message);
  }
  const afterPath = resolve(cwd, ".repo-doctor/report.after.json");
  mkdirSync(resolve(afterPath, ".."), { recursive: true });
  writeFileSync(afterPath, JSON.stringify(after, null, 2));
  console.error(`after-report written: ${afterPath}`);

  // --- 2. Regressions vs baseline ------------------------------------------
  const { regressions, comparison } = compareScans(baseline, after);

  // --- 3. Quality gates -----------------------------------------------------
  const warnings = [...scanOpts.warnings, ...after.warnings];
  let rootManifest: Record<string, unknown> | null = null;
  const rootPkgPath = join(cwd, "package.json");
  if (existsSync(rootPkgPath)) {
    try {
      rootManifest = JSON.parse(readFileSync(rootPkgPath, "utf8")) as Record<string, unknown>;
    } catch {
      warnings.push("root package.json is unparseable — script gates skipped");
    }
  }
  const gateSpecs = pickGates(rootManifest, after.packageManager, {
    skipInstall: values["skip-install"]!,
    skipTypecheck: values["skip-typecheck"]!,
    skipBuild: values["skip-build"]!,
    skipTest: values["skip-test"]!,
    custom: values.gate ?? [],
  });
  if (gateSpecs.length === 0) {
    warnings.push("no quality gates selected — regressions are the only check");
  }
  const gates: GateResult[] = [];
  for (const spec of gateSpecs) {
    const command = spec.command.join(" ");
    console.error(`gate ${spec.name}: ${command}…`);
    const res = await run(spec.command[0], spec.command.slice(1), { cwd, timeoutMs, env: spec.env });
    const ok = !res.timedOut && res.code === 0;
    const combined = `${res.stdout}\n${res.stderr}`.trim();
    const output = (
      res.timedOut ? `${combined}\n[timed out after ${timeoutMs}ms]` : combined
    ).slice(-OUTPUT_CAP);
    gates.push({ name: spec.name, command, ok, ms: res.wallMs, output });
    console.error(`${ok ? "✓" : "✗"} ${spec.name} (${(res.wallMs / 1000).toFixed(1)}s)`);
  }

  // --- Verdict --------------------------------------------------------------
  const result = evaluateVerify({ gates, regressions, comparison, warnings });
  const outPath = resolve(cwd, values.out!);
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.error(`\nverdict written: ${outPath}\n`);

  const nameWidth = Math.max(4, ...result.gates.map((g) => g.name.length));
  console.error(`${"gate".padEnd(nameWidth)}  result  time`);
  for (const g of result.gates) {
    console.error(`${g.name.padEnd(nameWidth)}  ${g.ok ? "✓ ok  " : "✗ FAIL"}  ${(g.ms / 1000).toFixed(1)}s`);
  }
  console.error(
    `\nfiles ${comparison.filesBefore} → ${comparison.filesAfter}, ` +
      `${fmtBytes(comparison.bytesBefore)} → ${fmtBytes(comparison.bytesAfter)}, ` +
      `deps ${comparison.depsBefore} → ${comparison.depsAfter}`,
  );
  const { newUnresolvedImports, newMissingDeps } = regressions;
  if (newUnresolvedImports.length > 0) {
    console.error(`✗ ${newUnresolvedImports.length} new unresolved import(s):`);
    for (const u of newUnresolvedImports.slice(0, 10)) {
      console.error(`   - ${u.from} → ${u.specifier}`);
    }
  } else {
    console.error("✓ no new unresolved imports");
  }
  if (newMissingDeps.length > 0) {
    console.error(`✗ ${newMissingDeps.length} new missing dep(s):`);
    for (const m of newMissingDeps.slice(0, 10)) {
      console.error(`   - ${m.packageDir}: ${m.name}`);
    }
  } else {
    console.error("✓ no new missing deps");
  }
  for (const w of result.warnings) console.error(`⚠️  ${w}`);

  if (!result.ok) {
    const reasons = [
      ...result.gates.filter((g) => !g.ok).map((g) => `gate ${g.name} failed`),
      ...(newUnresolvedImports.length > 0
        ? [`${newUnresolvedImports.length} new unresolved import(s)`]
        : []),
      ...(newMissingDeps.length > 0 ? [`${newMissingDeps.length} new missing dep(s)`] : []),
    ];
    console.error(`✗ VERIFY FAILED: ${reasons.join("; ")}`);
    process.exit(1);
  }
  console.error("✓ VERIFY PASSED");
}

main().catch((err) => fail((err as Error).stack ?? String(err)));
