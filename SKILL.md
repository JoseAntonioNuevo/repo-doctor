---
name: repo-doctor
description: Audit and safely slim a Git repository using a bound scan, exact review approvals, and static post-cleanup verification. Finds dead JS/TS modules, duplicate and junk files, unreferenced assets, unused or missing dependencies, workspace drift, and lockfile duplication. Use when asked to clean a repo, find dead code or dependencies, or determine what is safe to remove.
license: MIT
compatibility: Requires Node.js 22.13+ and Git. Target code execution is opt-in and may require its package manager or network access.
---

# repo-doctor

## Non-negotiable rules

1. Run scan and plan before proposing any deletion or dependency mutation.
2. Work from a clean tracked baseline on a non-default branch.
3. Treat every draft mutation as pending. Apply only exact IDs regenerated
   with `--approve`; `--keep` always wins.
4. Never approve or delete sensitive findings. Rotate credentials, remediate,
   then establish a new baseline.
5. Use `git rm` or `git rm --cached`; never bulk-delete by intuition.
6. Static verification is the default. Execute target code only when the user
   trusts the repository and explicitly authorizes gates.

## Requirements

- Node.js `>=22.13` and Git on `PATH`.
- Resolve this installed skill's directory to an absolute path and assign it
  once. Do not use an undefined skill-root placeholder.

```bash
REPO_DOCTOR_ROOT="/absolute/path/to/installed/repo-doctor"
TARGET_REPO="/absolute/path/to/target repo"
```

All invocations quote both values.

## Workflow

### 1. Baseline

Confirm the target is a Git repository, the tracked worktree is clean, and
you are not cleaning directly on the default branch. If trusted project tests
are requested, record their pre-cleanup status separately.

### 2. Scan

```bash
node "$REPO_DOCTOR_ROOT/bin/repo-doctor-scan.mjs" --cwd "$TARGET_REPO"
```

Inspect `diagnostics`, `health`, `projects`, and `graph.entrypoints`. If a
framework or runtime root is missing, add it with `--entry` and re-scan. Use
`--ignore` only at baseline time; it changes the analysis instrument.

### 3. Draft plan

```bash
node "$REPO_DOCTOR_ROOT/bin/repo-doctor-plan.mjs" --cwd "$TARGET_REPO"
```

Read `.repo-doctor/plan.md`, `references/false-positives.md`, and
`references/bloat-patterns.md`. Explain proposed, manual, review-only,
deferred, blocked, and sensitive findings to the user.

### 4. Record review decisions

Regenerate the plan with repeatable exact decisions:

```bash
node "$REPO_DOCTOR_ROOT/bin/repo-doctor-plan.mjs" \
  --cwd "$TARGET_REPO" \
  --keep '^known-live/' \
  --approve 'delete-file:src/obsolete.ts'
```

Use `--allow-delete <exact-path>` only for an intentional non-sensitive
entrypoint/reachable deletion. Never edit `plan.json` by hand; its exact bytes
and source report are part of verification.

### 5. Clean

Apply only approved exact mutations using Git-aware commands. Review-only,
deferred, blocked, pending, rescued, and sensitive items remain protected.

If a dependency is `deferred` because only proposed orphan files use it,
remove the approved files first, then run a fresh scan and plan. Do not remove
the dependency from the first plan.

### 6. Verify statically

```bash
node "$REPO_DOCTOR_ROOT/bin/repo-doctor-verify.mjs" --cwd "$TARGET_REPO"
```

Exit 0 with `STATIC VERIFY PASSED` proves the reviewed static invariants and
executes no target code. Exit 1 names cleanup regressions. Exit 2 indicates an
unsafe path, stale/wrong binding, legacy artifact, usage error, or missing
trust; stop and correct the baseline rather than bypassing it.

### 7. Optional trusted gates

Only with explicit authorization:

```bash
node "$REPO_DOCTOR_ROOT/bin/repo-doctor-verify.mjs" \
  --cwd "$TARGET_REPO" --run-gates --trust-repo
```

Automatic installs are frozen and manager-specific. Use `--pass-env NAME`
for individual credentials or `--inherit-env` only when explicitly accepted.
Environment scrubbing is not a sandbox; use a VM/container for untrusted code.

## Report back

State separately:

- baseline and final tracked files/bytes;
- approved and applied exact IDs;
- rescued, deferred, blocked, and sensitive findings with reasons;
- dependencies changed per package/project;
- static verification result;
- trusted gate commands/results, if any;
- paths to `plan.md`, `report.after.json`, and `verify.json`.
