# Repo cleanup plan

Generated 2026-01-01T00:00:00.000Z from a scan of <code>demo-fixture</code> by repo-doctor 0.2.0.

## Summary

| Metric | Before | After (estimate) |
|---|---:|---:|
| Tracked files | 15 | **8** |
| Tracked size | 2.2 KB | 1.6 KB |
| Declared deps | 5 | 5 |

Up to **625 B** reclaimable across 9 actionable items (1 rescued by --keep).

## Analysis diagnostics

| Code | Severity | Source | Scope | Message |
|---|---|---|---|---|
| <code>graph.dynamic-nonliteral</code> | warning | graph | file:src/index.ts | src/index.ts contains a non-literal dynamic load; dependency and orphan certainty is reduced for this file. |

## Delete files (4)

| ID | Target | Disposition | Decision | Confidence | Evidence | Bytes |
|---|---|---|---|---|---|---:|
| <code>delete-file:src/index-old.ts</code> | <code>src/index-old.ts</code> | proposed | pending | high | unreachable from the only entrypoint; the filename also marks it as a backup copy | 61 B |
| <code>delete-file:src/utils/format-copy.ts</code> | <code>src/utils/format-copy.ts</code> | proposed | pending | high | unreachable from the only entrypoint; the filename also marks it as a backup copy | 189 B |
| <code>delete-file:src/legacy/engine.ts</code> | <code>src/legacy/engine.ts</code> | manual | pending | medium | unreachable from the only entrypoint; its package has dynamic imports — verify none loads this file | 143 B |
| <code>delete-file:src/legacy/helpers.ts</code> | <code>src/legacy/helpers.ts</code> | manual | pending | medium | unreachable from the only entrypoint (imported only by 1 fellow orphan); its package has dynamic imports — verify none loads this file | 90 B |

## Review files (1)

| ID | Target | Disposition | Decision | Confidence | Evidence | Bytes |
|---|---|---|---|---|---|---:|
| <code>review-file:assets/old-banner.png</code> | <code>assets/old-banner.png</code> | review-only | pending | low | basename "old-banner.png" appears in no tracked text file (38 bytes) | — |

## Remove dependencies (2)

| ID | Target | Disposition | Decision | Confidence | Evidence | Bytes |
|---|---|---|---|---|---|---:|
| <code>remove-dep:left-pad:.</code> | <code>left-pad</code> (<code>.</code>) | blocked | blocked | low | usage is uncertain because this package owns non-literal dynamic loading; destructive dependency advice is blocked | — |
| <code>remove-dep:moment:.</code> | <code>moment</code> (<code>.</code>) | blocked | blocked | low | usage is uncertain because this package owns non-literal dynamic loading; destructive dependency advice is blocked | — |

## Move dependencies (1)

| ID | Target | Disposition | Decision | Confidence | Evidence | Bytes |
|---|---|---|---|---|---|---:|
| <code>move-dep:lodash:.</code> | <code>lodash</code> (<code>.</code>) | manual | pending | medium | declared in both dependencies and devDependencies — imported by non-test reachable code, keep the dependencies entry | — |

## Add missing dependencies (1)

| ID | Target | Disposition | Decision | Confidence | Evidence | Bytes |
|---|---|---|---|---|---|---:|
| <code>add-missing-dep:zod:.</code> | <code>zod</code> (<code>.</code>) | manual | pending | high | imported by 1 file (e.g. src/index.ts) but declared in no manifest | — |

## Dedupe the lockfile (1)

| ID | Target | Disposition | Decision | Confidence | Evidence | Bytes |
|---|---|---|---|---|---|---:|
| <code>dedupe-lockfile:package-lock.json</code> | <code>package-lock.json</code> | review-only | pending | low | 1 dependency names resolve to multiple versions; review as one project-level lockfile operation (semver) | — |

## Untrack and gitignore (3)

| ID | Target | Disposition | Decision | Confidence | Evidence | Bytes |
|---|---|---|---|---|---|---:|
| <code>untrack-and-gitignore:.DS_Store</code> | <code>.DS_Store</code> | proposed | pending | high | OS or editor dropping (.DS_Store, 19 bytes) — belongs in .gitignore, not in git | 19 B |
| <code>untrack-and-gitignore:debug.log</code> | <code>debug.log</code> | proposed | pending | high | committed log file (*.log, 50 bytes) — belongs in .gitignore, not in git | 50 B |
| <code>untrack-and-gitignore:dist/index.js</code> | <code>dist/index.js</code> | proposed | pending | high | committed build artifact (build output directory "dist", 73 bytes) — belongs in .gitignore, not in git; it is also unreachable in the module graph | 73 B |

## Consolidate overlapping packages (1)

| ID | Target | Disposition | Decision | Confidence | Evidence | Bytes |
|---|---|---|---|---|---|---:|
| <code>consolidate-overlap:date libraries:.</code> | <code>date libraries</code> (<code>.</code>) | review-only | pending | low | 2 date libraries in one manifest (dayjs, moment) — pick one date library; date-fns and dayjs are the lightest — migrate call sites incrementally. | — |

## Sensitive files — review, never auto-delete (1)

> Rotate any exposed credentials FIRST. These files are reported only —
> untrack and gitignore them by hand, never delete them automatically.

| ID | Target | Disposition | Decision | Confidence | Evidence | Bytes |
|---|---|---|---|---|---|---:|
| <code>review-sensitive:.env</code> | <code>.env</code> | blocked | blocked | high | may contain secrets — never auto-delete; rotate credentials, untrack, and gitignore | — |

## Rescued by --keep (1)

| Target | Action | Pattern | Evidence |
|---|---|---|---|
| <code>src/plugins/analytics.ts</code> | delete-file | <code>plugins\/</code> | unreachable from the only entrypoint; its package has dynamic imports — verify none loads this file |

## Next steps

1. Set the installed tool root: `REPO_DOCTOR_ROOT='<repo-doctor-root>'`.
2. Re-run plan with exact `--approve <item-id>` flags for every concrete mutation you reviewed; draft items remain pending.
3. Delete files with `git rm <path>` and untrack junk with `git rm --cached <path>` so changes remain reviewable.
4. Make dependency edits with the resolved project manager (<code>npm</code>); never invent an external version range.
5. Run static verification, which executes no target code:
   `node "$REPO_DOCTOR_ROOT/bin/repo-doctor-verify.mjs" --cwd 'demo-fixture'`
6. For explicitly trusted gates, add `--run-gates --trust-repo`. Re-scan after file cleanup before applying deferred dependency findings.
