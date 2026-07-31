#!/usr/bin/env -S npx tsx
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
 *   npx tsx scripts/plan.ts --report .repo-doctor/report.json \
 *     --keep "^public/" --min-confidence medium
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildPlan } from "./lib/planner.ts";
import { renderPlanMarkdown } from "./lib/render.ts";
import type { Confidence, RepoReport } from "./lib/types.ts";

const HELP = `plan — evidence-backed cleanup plan from a scan report

Usage: npx tsx scripts/plan.ts [options]

Options:
  --report <file>          Scan report (default: .repo-doctor/report.json)
  --out-plan <file>        Plan JSON output (default: .repo-doctor/plan.json)
  --out-md <file>          Human-readable plan (default: .repo-doctor/plan.md)
  --keep <regex>           Rescue items whose target or id matches
                           (repeatable) — kept in the plan for the audit
                           trail, excluded from action counts
  --min-confidence <level> low|medium|high — drop items below this confidence
                           (default: low = keep everything)
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
      "out-plan": { type: "string", default: ".repo-doctor/plan.json" },
      "out-md": { type: "string", default: ".repo-doctor/plan.md" },
      keep: { type: "string", multiple: true, default: [] },
      "min-confidence": { type: "string", default: "low" },
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
  const reportPath = resolve(values.report!);
  if (!existsSync(reportPath)) {
    fail(`report not found: ${reportPath} — run scan.ts first (evidence before opinions).`);
  }
  let reportText: string;
  try {
    reportText = readFileSync(reportPath, "utf8");
  } catch (err) {
    return fail(`report could not be read: ${reportPath} — ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(reportText);
  } catch (err) {
    return fail(`report is not valid JSON: ${reportPath} — ${(err as Error).message}`);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as { tool?: unknown }).tool !== "repo-doctor" ||
    (parsed as { version?: unknown }).version !== 1
  ) {
    fail(`unrecognized report format in ${reportPath}`);
  }
  const report = parsed as RepoReport;
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

  const plan = buildPlan(report, { keep, minConfidence });

  const planPath = resolve(values["out-plan"]!);
  const mdPath = resolve(values["out-md"]!);
  mkdirSync(resolve(planPath, ".."), { recursive: true });
  mkdirSync(resolve(mdPath, ".."), { recursive: true });
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  writeFileSync(mdPath, renderPlanMarkdown(plan, report));

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
