#!/usr/bin/env -S node
/**
 * PLAN — turn a scan report into an evidence-backed cleanup plan.
 *
 * Consumes the report produced by scan.ts and maps every finding to a concrete
 * action (delete-file, remove-dep, untrack-and-gitignore, …) with a confidence
 * level and one-sentence evidence.
 *
 * The plan is a PROPOSAL. Nothing is deleted by this script — a human or an
 * agent reviews it (see references/false-positives.md) first.
 *
 * Standalone usage:
 *   node bin/repo-doctor-plan.mjs --report .repo-doctor/report.json \
 *     --keep "^public/" --min-confidence medium
 */
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildPlan } from "./lib/planner.ts";
import { renderPlanMarkdown } from "./lib/render.ts";
import { assertDistinctArtifactPaths, readJsonArtifact, resolveSafePath, writeArtifactAtomic } from "./lib/artifacts.ts";
import { indexDigest, repositoryIdentity, trackedWorktreeClean } from "./lib/repository.ts";
import { assertRepoReportV2 } from "./lib/schema.ts";
import type { Confidence, RepoReport } from "./lib/types.ts";

const HELP = `plan — evidence-backed cleanup plan from a scan report

Usage: node repo-doctor-plan.mjs [options]

Options:
  --cwd <dir>             Target repo root (default: current directory)
  --report <file>          Scan report (default: .repo-doctor/report.json)
  --out-plan <file>        Plan JSON output (default: .repo-doctor/plan.json)
  --out-md <file>          Human-readable plan (default: .repo-doctor/plan.md)
  --keep <regex>           Rescue items whose target or id matches
                           (repeatable) — kept in the plan for the audit
                           trail, excluded from action counts
  --approve <item-id>      Approve one exact mutation-capable plan item
                           (repeatable; --keep wins)
  --allow-delete <path>    Explicitly authorize one non-sensitive protected path
                           (repeatable, exact repo-relative path)
  --min-confidence <level> low|medium|high — drop items below this confidence
                           (default: low = keep everything)
  --allow-output-outside-cwd
                           Permit plan outputs outside the target root
  --help                   Show this help

Exit codes: 0 plan written, 2 environment/usage error.`;

function fail(msg: string): never {
  console.error(`\nplan: ${msg}`);
  process.exit(2);
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** parseArgs throws on unknown flags — route that to the usage exit code (2). */
function parseCliValues(): ReturnType<typeof parseValues> {
  try {
    return parseValues();
  } catch (err) {
    return fail((err as Error).message);
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
      help: { type: "boolean", default: false },
    },
  }).values;
}

function main(): void {
  const values = parseCliValues();
  if (values.help) {
    console.log(HELP);
    return;
  }
  const cwd = realpathSync(resolve(values.cwd!));
  const reportPath = resolveSafePath(values.report!, { cwd });
  let loaded: ReturnType<typeof readJsonArtifact<unknown>>;
  try {
    loaded = readJsonArtifact<unknown>(reportPath, { cwd });
  } catch (err) {
    return fail((err as Error).message);
  }
  const parsed = loaded.value;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as { tool?: unknown }).tool !== "repo-doctor" ||
    (parsed as { version?: unknown }).version !== 2
  ) {
    const version = parsed && typeof parsed === "object" ? (parsed as { version?: unknown }).version : null;
    fail(version === 1 ? `legacy v1 report rejected: ${reportPath} — re-run scan with repo-doctor 0.2.0` : `unrecognized report format in ${reportPath}`);
  }
  const report = parsed as RepoReport;
  try {
    assertRepoReportV2(report);
  } catch (error) {
    return fail(`malformed v2 report: ${(error as Error).message}`);
  }
  const identity = repositoryIdentity(cwd);
  if (identity.id !== report.source.repository.id || identity.head !== report.source.repository.head) {
    fail("scan report is stale or belongs to a different repository/HEAD — re-run scan");
  }
  if (indexDigest(cwd) !== report.source.indexDigest || !trackedWorktreeClean(cwd) || !report.source.trackedWorktreeClean) {
    fail("a mutation-capable plan requires the same clean tracked baseline recorded by scan — clean the worktree and re-run scan");
  }
  const minConfidence = values["min-confidence"] as Confidence;
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
    reportSha256: loaded.digest,
  });

  const planPath = resolveSafePath(values["out-plan"]!, { cwd, allowOutside: values["allow-output-outside-cwd"]!, rejectTracked: true });
  const mdPath = resolveSafePath(values["out-md"]!, { cwd, allowOutside: values["allow-output-outside-cwd"]!, rejectTracked: true });
  assertDistinctArtifactPaths([reportPath, planPath, mdPath]);
  writeArtifactAtomic(planPath, `${JSON.stringify(plan, null, 2)}\n`, { cwd, allowOutside: values["allow-output-outside-cwd"]!, rejectTracked: true });
  writeArtifactAtomic(mdPath, `${renderPlanMarkdown(plan, report)}\n`, { cwd, allowOutside: values["allow-output-outside-cwd"]!, rejectTracked: true });

  const s = plan.summary;
  const by = (a: string): number => s.byAction[a] ?? 0;
  console.error(`plan written: ${planPath} (+ ${mdPath})`);
  console.error(`items: ${s.itemsTotal} total, ${s.itemsRescued} rescued by --keep`);
  console.error(
    `files: ${s.deleteFiles} delete, ${s.reviewFiles} review, ` +
      `${by("untrack-and-gitignore")} untrack, ${by("review-sensitive")} sensitive — ` +
      `${fmtBytes(s.reclaimBytes)} reclaimable`,
  );
  console.error(
    `deps: ${s.removeDeps} remove, ${by("move-dep")} move, ` +
      `${by("add-missing-dep")} add-missing, ${by("align-versions")} align-versions`,
  );
  console.error(
    `lockfile: ${by("dedupe-lockfile")} dedupe — overlaps: ${by("consolidate-overlap")} consolidate`,
  );
  for (const w of s.warnings) console.error(`⚠️  ${w}`);
  console.error(
    "\nnext: review the plan against references/false-positives.md — do NOT delete blindly.",
  );
}

// Exit-code contract: 0 plan written, 2 anything that stopped it — never an
// uncaught throw leaking exit code 1.
try {
  main();
} catch (err) {
  fail((err as Error).stack ?? String(err));
}
