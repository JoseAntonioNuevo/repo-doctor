import type { CleanupPlan, PlanAction, PlanItem, RepoReport } from "./types.ts";
import { realpathSync } from "node:fs";

/** Human-format a byte count (1024-based); small values stay exact. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** Section order and titles — one section per action group, in PlanAction order. */
const SECTIONS: { action: PlanAction; title: string }[] = [
  { action: "delete-file", title: "Delete files" },
  { action: "review-file", title: "Review files" },
  { action: "remove-dep", title: "Remove dependencies" },
  { action: "move-dep", title: "Move dependencies" },
  { action: "add-missing-dep", title: "Add missing dependencies" },
  { action: "align-versions", title: "Align workspace versions" },
  { action: "dedupe-lockfile", title: "Dedupe the lockfile" },
  { action: "untrack-and-gitignore", title: "Untrack and gitignore" },
  { action: "consolidate-overlap", title: "Consolidate overlapping packages" },
  { action: "review-sensitive", title: "Sensitive files — review, never auto-delete" },
];

function targetCell(item: PlanItem): string {
  return item.packageDir == null ? code(item.target) : `${code(item.target)} (${code(item.packageDir)})`;
}

export function escapeMarkdownCell(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;")
    .replace(/\r?\n|\r/g, "<br>")
    .replace(/`/g, "&#96;");
}

function code(value: unknown): string {
  return `<code>${escapeMarkdownCell(value)}</code>`;
}

/** Human-readable companion to plan.json, safe to paste into a PR description. */
export function renderPlanMarkdown(plan: CleanupPlan, report: RepoReport, maxRows = 400): string {
  const s = plan.summary;
  const actionable = plan.items.filter((i) => !i.rescued && (i.disposition === "proposed" || i.disposition === "manual"));
  const rescued = plan.items.filter((i) => i.rescued);
  const filesRemoved = (s.byAction["delete-file"] ?? 0) + (s.byAction["untrack-and-gitignore"] ?? 0);
  // move-dep changes a dep's field, not the declared-name count — only adds and removes shift it.
  const depsDelta = (s.byAction["add-missing-dep"] ?? 0) - (s.byAction["remove-dep"] ?? 0);
  const t = report.totals;

  const lines: string[] = [];
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
    `| Tracked size | ${formatBytes(t.trackedBytes)} | ${formatBytes(Math.max(0, t.trackedBytes - s.reclaimBytes))} |`,
  );
  lines.push(`| Declared deps | ${t.declaredDeps} | ${Math.max(0, t.declaredDeps + depsDelta)} |`);
  lines.push("");
  lines.push(
    `Up to **${formatBytes(s.reclaimBytes)}** reclaimable across ${actionable.length} actionable ` +
      `item${actionable.length === 1 ? "" : "s"}${rescued.length > 0 ? ` (${rescued.length} rescued by --keep)` : ""}.`,
  );
  lines.push("");
  if (s.warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const w of s.warnings) lines.push(`- ⚠️ ${escapeMarkdownCell(w)}`);
    lines.push("");
  }
  if (plan.diagnostics.length > 0) {
    lines.push("## Analysis diagnostics");
    lines.push("");
    lines.push("| Code | Severity | Source | Scope | Message |");
    lines.push("|---|---|---|---|---|");
    for (const diagnostic of plan.diagnostics.slice(0, maxRows)) {
      const scope = diagnostic.scope.path.length > 0
        ? `${diagnostic.scope.kind}:${diagnostic.scope.path}`
        : diagnostic.scope.kind;
      lines.push(
        `| ${code(diagnostic.code)} | ${escapeMarkdownCell(diagnostic.severity)} | ${escapeMarkdownCell(diagnostic.source)} | ${escapeMarkdownCell(scope)} | ${escapeMarkdownCell(diagnostic.message)} |`,
      );
    }
    if (plan.diagnostics.length > maxRows) lines.push(`| … +${plan.diagnostics.length - maxRows} more | | | | |`);
    lines.push("");
  }
  for (const { action, title } of SECTIONS) {
    const rows = plan.items.filter((i) => !i.rescued && i.action === action);
    if (rows.length === 0) continue;
    lines.push(`## ${title} (${rows.length})`);
    lines.push("");
    if (action === "review-sensitive") {
      lines.push("> Rotate any exposed credentials FIRST. These files are reported only —");
      lines.push("> untrack and gitignore them by hand, never delete them automatically.");
      lines.push("");
    }
    lines.push("| ID | Target | Disposition | Decision | Confidence | Evidence | Bytes |");
    lines.push("|---|---|---|---|---|---|---:|");
    for (const item of rows.slice(0, maxRows)) {
      lines.push(
        `| ${code(item.id)} | ${targetCell(item)} | ${item.disposition} | ${item.decision.status} | ${item.confidence} | ${escapeMarkdownCell(item.evidence)} | ${
          item.reclaimBytes > 0 ? formatBytes(item.reclaimBytes) : "—"
        } |`,
      );
    }
    if (rows.length > maxRows) lines.push(`| … +${rows.length - maxRows} more | | | | | | |`);
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
    if (rescued.length > maxRows) lines.push(`| … +${rescued.length - maxRows} more | | | |`);
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

function resolveSkillRoot(): string {
  const executable = process.argv[1] ?? "<repo-doctor-root>/bin/repo-doctor-plan.mjs";
  let detected = executable;
  try { detected = realpathSync(executable); } catch { /* unit tests and copied snippets have no real executable */ }
  const normalized = detected.replace(/\\/g, "/");
  return /\/bin\/repo-doctor-plan\.mjs$/.test(normalized)
    ? normalized.replace(/\/bin\/repo-doctor-plan\.mjs$/, "")
    : "<repo-doctor-root>";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
