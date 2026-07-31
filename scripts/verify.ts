#!/usr/bin/env -S node
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  assertDistinctArtifactPaths,
  canonicalJson,
  readJsonArtifact,
  resolveSafePath,
  writeArtifactAtomic,
  sha256,
} from "./lib/artifacts.ts";
import { buildPlan } from "./lib/planner.ts";
import { run } from "./lib/exec.ts";
import { assertBaselineHistory, repositoryIdentity } from "./lib/repository.ts";
import { assertCleanupPlanV2, assertRepoReportV2 } from "./lib/schema.ts";
import {
  compareScans,
  evaluateVerify,
  pickProjectGates,
  resolveVerifyScanOptions,
  verifyAuthorizedChanges,
  type GateManifest,
} from "./lib/verify-core.ts";
import { runScan, TOOL_VERSION } from "./scan.ts";
import type { CleanupPlan, GateResult, RepoReport, VerifyRegressions } from "./lib/types.ts";

const HELP = `verify — enforce a reviewed repo-doctor v2 cleanup plan

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

function fail(message: string): never {
  console.error(`\nverify: ${message}`);
  process.exit(2);
}

function parseVersioned<T extends { version: number; tool: string }>(
  loaded: ReturnType<typeof readJsonArtifact<unknown>>,
  kind: "report" | "plan",
): T {
  const value = loaded.value;
  if (!value || typeof value !== "object" || (value as { tool?: unknown }).tool !== "repo-doctor") {
    fail(`unrecognized ${kind} artifact: ${loaded.path}`);
  }
  if ((value as { version?: unknown }).version === 1) {
    fail(`legacy v1 ${kind} rejected: ${loaded.path} — re-run scan and plan with repo-doctor 0.2.0`);
  }
  if ((value as { version?: unknown }).version !== 2) fail(`unrecognized ${kind} version: ${loaded.path}`);
  try {
    if (kind === "report") assertRepoReportV2(value);
    else assertCleanupPlanV2(value);
  } catch (error) {
    fail(`malformed v2 ${kind}: ${(error as Error).message}`);
  }
  return value as unknown as T;
}

function manifestScripts(cwd: string, report: RepoReport): GateManifest[] {
  const dirs = new Set(report.projects.flatMap((project) => project.packageDirs));
  const manifests: GateManifest[] = [];
  for (const dir of dirs) {
    const path = join(cwd, dir === "." ? "package.json" : `${dir}/package.json`);
    if (!existsSync(path)) continue;
    const raw = JSON.parse(readFileSync(path, "utf8")) as { scripts?: unknown };
    const scripts = raw.scripts && typeof raw.scripts === "object"
      ? Object.fromEntries(Object.entries(raw.scripts as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    manifests.push({ dir, scripts });
  }
  return manifests;
}

function regressionCount(regressions: VerifyRegressions): number {
  return Object.values(regressions).reduce((sum, values) => sum + values.length, 0);
}

function trackedChanges(before: RepoReport, after: RepoReport): string[] {
  const a = new Map(before.files.map((file) => [file.path, file.hash]));
  const b = new Map(after.files.map((file) => [file.path, file.hash]));
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((path) => a.get(path) !== b.get(path))
    .sort();
}

function enforceMutationFilesystem(cwd: string, plan: CleanupPlan, regressions: VerifyRegressions): void {
  const approved = plan.items.filter((item) => item.decision.status === "approved").flatMap((item) => item.mutations);
  for (const mutation of approved) {
    if (mutation.kind === "delete-file" && existsSync(join(cwd, mutation.path))) {
      regressions.unauthorizedRemovals.push(`${mutation.path} remains on disk after approved delete-file`);
    }
    if (mutation.kind === "untrack-file" && existsSync(join(cwd, mutation.path))) {
      const abs = join(cwd, mutation.path);
      const stat = lstatSync(abs);
      const bytes = stat.isSymbolicLink() ? readlinkSync(abs) : readFileSync(abs);
      if (sha256(bytes).replace(/^sha256:/, "") !== mutation.beforeHash) regressions.unauthorizedChanges.push(`${mutation.path} changed before untracking`);
      try {
        execFileSync("git", ["check-ignore", "-q", "--", mutation.path], { cwd, stdio: "ignore" });
      } catch {
        regressions.unplannedManifestChanges.push(`${mutation.path} was untracked but is not ignored`);
      }
    } else if (mutation.kind === "untrack-file") {
      regressions.unauthorizedRemovals.push(`${mutation.path} was removed instead of untracked`);
    }
  }
  const byIgnorePath = new Map<string, Extract<(typeof approved)[number], { kind: "untrack-file" }>[]>();
  for (const mutation of approved) {
    if (mutation.kind !== "untrack-file") continue;
    byIgnorePath.set(mutation.ignorePath, [...(byIgnorePath.get(mutation.ignorePath) ?? []), mutation]);
  }
  for (const [ignorePath, mutations] of byIgnorePath) {
    const before = plan.source.baselineHead
      ? (() => {
          try {
            return execFileSync("git", ["show", `${plan.source.baselineHead}:${ignorePath}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
          } catch {
            return "";
          }
        })()
      : "";
    const currentPath = join(cwd, ignorePath);
    const current = existsSync(currentPath) ? readFileSync(currentPath, "utf8") : "";
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

export async function verifyMain(): Promise<void> {
  let values: ReturnType<typeof parseArgs>["values"];
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
        help: { type: "boolean", default: false },
      },
    }));
  } catch (error) {
    return fail((error as Error).message);
  }
  if (values.help) {
    console.log(HELP);
    return;
  }
  const cwd = realpathSync(resolve(values.cwd as string));
  const timeoutMs = Number(values["timeout-ms"]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail("--timeout-ms must be a positive safe integer");
  const custom = values.gate as string[];
  const runGates = values["run-gates"] as boolean;
  const trusted = values["trust-repo"] as boolean;
  if ((runGates || custom.length > 0) && !trusted) fail("--run-gates and --gate require explicit --trust-repo");
  if (custom.length > 0 && !runGates) fail("--gate also requires --run-gates");

  // All paths are validated before scanning or executing target code.
  const allowOutside = values["allow-output-outside-cwd"] as boolean;
  const reportPath = resolveSafePath(values.baseline as string, { cwd });
  const planPath = resolveSafePath(values.plan as string, { cwd });
  const outPath = resolveSafePath(values.out as string, { cwd, allowOutside, rejectTracked: true });
  const afterPath = resolveSafePath(values["after-out"] as string, { cwd, allowOutside, rejectTracked: true });
  assertDistinctArtifactPaths([reportPath, planPath, outPath, afterPath]);
  const reportLoaded = readJsonArtifact<unknown>(reportPath, { cwd });
  const planLoaded = readJsonArtifact<unknown>(planPath, { cwd });
  const baseline = parseVersioned<RepoReport>(reportLoaded, "report");
  const plan = parseVersioned<CleanupPlan>(planLoaded, "plan");

  if (plan.source.reportSha256 !== reportLoaded.digest) fail("plan is not bound to these exact report bytes — regenerate the plan");
  if (plan.source.repositoryId !== baseline.source.repository.id || plan.source.baselineHead !== baseline.source.repository.head || plan.source.inventoryDigest !== baseline.source.inventoryDigest || plan.source.indexDigest !== baseline.source.indexDigest || plan.source.scanOptionsDigest !== baseline.scanOptionsDigest || plan.source.toolVersion !== baseline.toolVersion) {
    fail("plan/report binding fields do not match — regenerate scan and plan");
  }
  try {
    const expectedPlan = buildPlan(baseline, {
      keep: plan.options.keep,
      approve: plan.options.approve,
      allowDelete: plan.options.allowDelete,
      minConfidence: plan.options.minConfidence,
      reportSha256: reportLoaded.digest,
    });
    const comparable = (value: CleanupPlan): string => canonicalJson({ ...value, createdAt: "<ignored>" });
    if (comparable(expectedPlan) !== comparable(plan)) fail("plan contents do not match a plan generated from the bound report and review controls — regenerate the plan");
  } catch (error) {
    return fail(`invalid or tampered plan: ${(error as Error).message}`);
  }
  const identity = repositoryIdentity(cwd);
  if (identity.id !== baseline.source.repository.id) fail("baseline belongs to a different repository");
  assertBaselineHistory(cwd, plan.source.baselineHead);
  if (baseline.toolVersion !== TOOL_VERSION || plan.toolVersion !== TOOL_VERSION) fail(`artifact tool version does not match repo-doctor ${TOOL_VERSION}`);

  let scanOptions: ReturnType<typeof resolveVerifyScanOptions>;
  try {
    scanOptions = resolveVerifyScanOptions(baseline, values.ignore as string[], values.entry as string[]);
  } catch (error) {
    return fail((error as Error).message);
  }
  const ignore = scanOptions.ignore.map((pattern) => new RegExp(pattern));
  const scan = (): Promise<RepoReport> => runScan({
    cwd,
    ignore,
    entries: scanOptions.entries,
    largeCount: baseline.scanOptions.largeCount,
    minDupBytes: baseline.scanOptions.minDupBytes,
  });

  console.error("static preflight: scanning with the exact reviewed options…");
  const candidate = await scan();
  const candidateSnapshot = candidate.source;
  let regressions = verifyAuthorizedChanges(baseline, candidate, plan);
  enforceMutationFilesystem(cwd, plan, regressions);
  const comparison = compareScans(baseline, candidate).comparison;
  const gates: GateResult[] = [];

  if (runGates && regressionCount(regressions) === 0) {
    let specs;
    try {
      specs = pickProjectGates(candidate.projects, manifestScripts(cwd, candidate), {
        skipInstall: values["skip-install"] as boolean,
        custom,
        skipScripts: [
          values["skip-typecheck"] ? "typecheck" : "",
          values["skip-build"] ? "build" : "",
          values["skip-test"] ? "test" : "",
        ],
      });
    } catch (error) {
      return fail((error as Error).message);
    }
    if (specs.length === 0) fail("--run-gates selected no automatic or custom gates");
    for (const spec of specs) {
      console.error(`gate ${spec.name}: ${spec.command.join(" ")}`);
      const result = await run(spec.command[0], spec.command.slice(1), {
        cwd: resolve(cwd, spec.cwd),
        timeoutMs,
        environment: "minimal",
        passEnv: values["pass-env"] as string[],
        inheritEnv: values["inherit-env"] as boolean,
      });
      const combined = `${result.stdout}\n${result.stderr}`.trim();
      gates.push({
        name: spec.name,
        command: spec.command.join(" "),
        ok: !result.timedOut && result.code === 0,
        ms: result.wallMs,
        output: combined.slice(-4096),
        truncated: result.stdoutTruncated || result.stderrTruncated || combined.length > 4096,
        timedOut: result.timedOut,
      });
      if (gates.at(-1)!.ok) console.error(`✓ ${spec.name}`);
      else console.error(`✗ ${spec.name}`);
    }
  }

  console.error("authoritative final scan…");
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
      ...((values["pass-env"] as string[]).length > 0 ? [`forwarded environment names: ${(values["pass-env"] as string[]).sort().join(", ")}`] : []),
      ...(values["inherit-env"] ? ["full environment inheritance explicitly enabled"] : []),
    ],
    inputs: { reportSha256: reportLoaded.digest, planSha256: planLoaded.digest },
    candidateSnapshot,
    finalSnapshot: final.source,
    toolVersion: TOOL_VERSION,
    healthChanges: (Object.keys(baseline.health) as (keyof RepoReport["health"])[])
      .filter((capability) => baseline.health[capability] !== final.health[capability])
      .map((capability) => ({ capability, before: baseline.health[capability], after: final.health[capability] })),
  });
  writeArtifactAtomic(afterPath, `${JSON.stringify(final, null, 2)}\n`, { cwd, allowOutside, rejectTracked: true });
  writeArtifactAtomic(outPath, `${JSON.stringify(result, null, 2)}\n`, { cwd, allowOutside, rejectTracked: true });
  console.error(`verdict written: ${outPath}`);
  if (!result.ok) {
    console.error(`✗ VERIFY FAILED: ${regressionCount(result.regressions)} regression(s), ${result.gates.filter((gate) => !gate.ok).length} failed gate(s)`);
    process.exit(1);
  }
  console.error(runGates ? "✓ FULL VERIFY PASSED" : "✓ STATIC VERIFY PASSED (no target code executed)");
}

verifyMain().catch((error) => fail((error as Error).stack ?? String(error)));
