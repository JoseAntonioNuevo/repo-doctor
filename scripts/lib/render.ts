import type { CleanupPlan, PlanAction, PlanItem, RepoReport } from "./types.ts";

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
  return item.packageDir == null ? `\`${item.target}\`` : `\`${item.target}\` (\`${item.packageDir}\`)`;
}

/** Human-readable companion to plan.json, safe to paste into a PR description. */
export function renderPlanMarkdown(plan: CleanupPlan, report: RepoReport, maxRows = 400): string {
  const s = plan.summary;
  const actionable = plan.items.filter((i) => !i.rescued);
  const rescued = plan.items.filter((i) => i.rescued);
  const filesRemoved = (s.byAction["delete-file"] ?? 0) + (s.byAction["untrack-and-gitignore"] ?? 0);
  // move-dep changes a dep's field, not the declared-name count — only adds and removes shift it.
  const depsDelta = (s.byAction["add-missing-dep"] ?? 0) - (s.byAction["remove-dep"] ?? 0);
  const t = report.totals;

  const lines: string[] = [];
  lines.push("# Repo cleanup plan");
  lines.push("");
  lines.push(`Generated ${plan.createdAt} from a scan of \`${report.cwd}\` by repo-doctor.`);
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
    for (const w of s.warnings) lines.push(`- ⚠️ ${w}`);
    lines.push("");
  }
  for (const { action, title } of SECTIONS) {
    const rows = actionable.filter((i) => i.action === action);
    if (rows.length === 0) continue;
    lines.push(`## ${title} (${rows.length})`);
    lines.push("");
    if (action === "review-sensitive") {
      lines.push("> Rotate any exposed credentials FIRST. These files are reported only —");
      lines.push("> untrack and gitignore them by hand, never delete them automatically.");
      lines.push("");
    }
    lines.push("| Target | Confidence | Evidence | Bytes |");
    lines.push("|---|---|---|---:|");
    for (const item of rows.slice(0, maxRows)) {
      lines.push(
        `| ${targetCell(item)} | ${item.confidence} | ${item.evidence} | ${
          item.reclaimBytes > 0 ? formatBytes(item.reclaimBytes) : "—"
        } |`,
      );
    }
    if (rows.length > maxRows) lines.push(`| … +${rows.length - maxRows} more | | | |`);
    lines.push("");
  }
  if (rescued.length > 0) {
    lines.push(`## Rescued by --keep (${rescued.length})`);
    lines.push("");
    lines.push("| Target | Action | Pattern | Evidence |");
    lines.push("|---|---|---|---|");
    for (const item of rescued.slice(0, maxRows)) {
      lines.push(`| ${targetCell(item)} | ${item.action} | \`${item.keepPattern ?? ""}\` | ${item.evidence} |`);
    }
    if (rescued.length > maxRows) lines.push(`| … +${rescued.length - maxRows} more | | | |`);
    lines.push("");
  }
  const pm = report.packageManager ?? "npm";
  lines.push("## Next steps");
  lines.push("");
  lines.push("1. Work on a fresh branch: `git switch -c repo-doctor/cleanup`.");
  lines.push("2. Delete files with `git rm <path>` (never plain `rm`) so every removal is staged and reviewable.");
  lines.push("3. Untrack junk with `git rm --cached <path>` and add the path to `.gitignore`.");
  lines.push(`4. Remove dependencies inside each package dir: \`${pm} remove <name>\`.`);
  lines.push("5. Review items are findings to discuss — they are never executed from the plan.");
  lines.push(
    "6. Re-verify from the target repo root: `npx tsx $SKILL/scripts/verify.ts --baseline .repo-doctor/report.json` — " +
      "gates must pass before merging. (`$SKILL` is this skill's checkout directory.)",
  );
  lines.push("");
  return lines.join("\n");
}
