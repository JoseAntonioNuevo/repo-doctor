---
name: repo-doctor
description: Audit and slim a bloated repository — dead JS/TS modules, byte-identical duplicate files, committed junk (build artifacts, logs, caches, editor droppings, backup copies, secrets), unreferenced assets, and dependency bloat (unused, dual-declared, version-skewed, multi-version, overlapping packages). Use when the user wants to clean up a repo, find unused dependencies, remove dead files or dead modules, shrink a repo that is too big, or audit what is safe to delete. Evidence-driven — bundled scripts build the import graph and dependency-usage report and compute the removal plan; never delete files by gut feeling.
---

# repo-doctor

Slim an overgrown repository (committed build output, zombie modules, `-old`
copies, a dependency graveyard) down to what the code actually uses —
measured from the import graph and the manifests, not guessed.

## Hard rules

1. **Evidence before opinions.** Never propose deleting a file or removing a
   dependency before `scan.ts` and `plan.ts` have produced a plan. A file that
   "looks dead" can be loaded dynamically, referenced from config by string,
   or served by framework convention.
2. **The plan is a proposal, not a verdict.** The import graph cannot see
   computed `import()` paths, plugin registries, CMS-referenced assets, or
   CLI-only dependencies. Every candidate gets reviewed (step 3) against
   `references/false-positives.md` before anything is removed.
3. **Work on a clean branch, delete via `git rm` only.** Verify the working
   tree is clean, create a branch (e.g. `repo-doctor/cleanup`), and let git do
   the removal — recovery must always be one `git revert` away. Never
   `rm -rf`, never on a dirty tree or the default branch.
4. **Sensitive files are reported, never deleted.** A committed `.env` or key
   file means: rotate the credentials, untrack the file, gitignore it.
   Deleting it silently hides the incident while git history keeps the bytes.
5. **Verify or revert.** The job is not done until `verify.ts` exits 0. If it
   fails, restore what the regression list names — or revert the branch.

## Requirements check (do this first)

- Node.js ≥ 20 and `git` on PATH; the target must be a git repository — the
  scan analyzes tracked files only
  (`npx tsx scripts/scan.ts --help` from this skill's directory).
- Dead-module and dependency analysis needs a JS/TS repo with a
  `package.json`; junk, duplicate, and unreferenced-asset findings work in
  any git repository.
- The working tree should be clean before starting — cleanup happens on a
  branch, and verify re-scans the tree.
- `verify.ts` runs the repo's own install/typecheck/build/test scripts
  (package manager auto-detected from the lockfile). In monorepos run
  everything from the workspace root.
- Those gates should be green before starting: run them once BEFORE cleaning.
  If they are already red, report it and agree scope with the user (e.g.
  `--skip-test`, or `--gate` substitutes) before any deletion — a
  pre-existing failure must not be blamed on the cleanup.

All commands below run from the target repo root; `$SKILL` is this skill's
directory. Artifacts land in `.repo-doctor/` (suggest gitignoring it).

## Workflow

### 1. SCAN (script — always first)

```bash
npx tsx $SKILL/scripts/scan.ts --cwd .
```

Lists git-tracked files, hashes them, builds the module graph from entrypoint
conventions (package.json fields, framework routes, configs, tests,
scripts…), analyzes per-manifest dependency usage, parses the lockfile, and
flags junk, duplicates, and unreferenced assets. Writes
`.repo-doctor/report.json`.

- `--ignore <regex>` drops vendored or generated trees from all analysis;
  `--entry <path>` adds roots the conventions miss (both repeatable — do this
  BEFORE trusting the orphan list).
- Read the report's `warnings` and `graph.entrypoints` before going further:
  if a framework's roots are missing, everything they load looks dead.

### 2. PLAN (script)

```bash
npx tsx $SKILL/scripts/plan.ts
```

Maps findings to concrete actions (`delete-file`, `untrack-and-gitignore`,
`remove-dep`, …), each with a confidence tier and a one-line evidence string.
Writes `.repo-doctor/plan.json` and a human-readable `.repo-doctor/plan.md`.

- Force-keep anything you already know is live:
  `--keep 'migrations' --keep 'legacy-api'` (regex on target and item id).
- `--min-confidence` filters the plan (default `low` = everything). Heed the
  plan's `warnings` array and relay it to the user verbatim.

### 3. REVIEW (judgment — yours)

Read `references/bloat-patterns.md` and `references/false-positives.md`, then
review the plan in `plan.md`:

- Rescue false positives — dynamically imported modules, string-referenced
  files, CLI-only deps, type-only packages, convention-served `public/`
  files. Re-run plan with additional `--keep` patterns rather than editing
  the plan by hand, so the audit trail records each rescue.
- Confidence gates execution (table in `false-positives.md`): high items may
  be executed after a sanity read; medium items need a repo-wide call-site
  scan first; low and sensitive items are a conversation with the user, not
  an action.
- Classify what remains by bloat pattern so the user sees *why* each item
  dies (the patterns file has the catalog).

### 4. CLEAN (judgment — yours)

On a clean tree, on a branch — then apply plan items by action:

```bash
git switch -c repo-doctor/cleanup
git rm <path>                        # delete-file
git rm --cached <path>               # untrack-and-gitignore …
echo '<pattern>' >> .gitignore       # … plus the ignore rule
pnpm remove <dep>                    # remove-dep (npm/yarn per lockfile)
```

`move-dep`, `add-missing-dep`, and `align-versions` are manifest edits (the
evidence says which side or range to keep) followed by a reinstall;
`dedupe-lockfile` is one `pnpm dedupe` / `npm dedupe` / `yarn dedupe`;
`consolidate-overlap` is a migration — propose it, don't do it unilaterally.
`review-file` and `review-sensitive` items are findings to discuss or convert
into explicit decisions — never executed from the plan (hard rule 4 for
sensitive). The `plan.md` footer lists the command templates to use.

### 5. VERIFY (script — gates completion)

```bash
npx tsx $SKILL/scripts/verify.ts --baseline .repo-doctor/report.json
```

Re-scans the repo, diffs it against the baseline (new unresolved imports or
new missing deps = regressions), then runs the repo's own install, typecheck,
build, and test scripts as gates. Exit 0 = done; exit 1 = fix and re-run
(restore what the regression list names); exit 2 = environment problem, stop
and report. The re-scan replays the `--ignore`/`--entry` options recorded in
the baseline report automatically — `--ignore`/`--entry` here only ADD to
that set. `--gate "cmd args"` replaces the script gates with custom ones. The
install gate deliberately allows a lockfile update (pnpm
`--no-frozen-lockfile`, Yarn immutable off) — the cleanup edits manifests.

## Reporting back

Summarize for the user: tracked files and bytes before → after, dependencies
removed per package, junk untracked, duplicate groups collapsed, items
rescued from the plan and why (cite the false-positive section), sensitive
findings and how they were handled, and the final verify verdict. Include
the path to `plan.md` for the full audit trail.

## Failure modes

- **Not a git repository / no tracked files** → scripts exit 2 with
  guidance; run from the repo root or pass `--cwd`.
- **The orphan list looks absurd** (half of `src/` "dead") → the entrypoint
  conventions missed the framework. Check `graph.entrypoints`, add `--entry`
  roots, re-scan. Never bulk-delete a suspicious orphan list.
- **`graph.dynamicImporters` is non-empty** → orphan confidence drops to
  medium by design (backup-named orphans stay high); grep each orphan's
  basename before deleting it.
- **Verify keeps failing** → stop looping after ~3 attempts; the regressions
  name exact files and deps — restore those (`git revert`, or re-add the
  dep) and present the residual failures to the user.
- **Sensitive files found** → stop and report before any other cleanup;
  credentials must be rotated, and git history still holds the bytes
  (history rewriting is a human decision — see
  `references/bloat-patterns.md`).
