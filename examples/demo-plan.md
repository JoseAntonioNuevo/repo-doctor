# Repo cleanup plan

Generated 2026-07-31T18:03:49.844Z from a scan of `demo-fixture` by repo-doctor.

## Summary

| Metric | Before | After (estimate) |
|---|---:|---:|
| Tracked files | 14 | **7** |
| Tracked size | 2.2 KB | 1.6 KB |
| Declared deps | 5 | 4 |

Up to **625 B** reclaimable across 15 actionable items (1 rescued by --keep).

## Delete files (4)

| Target | Confidence | Evidence | Bytes |
|---|---|---|---:|
| `src/index-old.ts` | high | unreachable from the only entrypoint; the filename also marks it as a backup copy | 61 B |
| `src/utils/format-copy.ts` | high | unreachable from the only entrypoint; the filename also marks it as a backup copy | 189 B |
| `src/legacy/engine.ts` | medium | unreachable from the only entrypoint; repo has dynamic imports — verify none loads this file | 143 B |
| `src/legacy/helpers.ts` | medium | unreachable from the only entrypoint (imported only by 1 fellow orphan); repo has dynamic imports — verify none loads this file | 90 B |

## Review files (1)

| Target | Confidence | Evidence | Bytes |
|---|---|---|---:|
| `assets/old-banner.png` | low | basename "old-banner.png" appears in no tracked text file (38 bytes) | — |

## Remove dependencies (2)

| Target | Confidence | Evidence | Bytes |
|---|---|---|---:|
| `left-pad` (`.`) | medium | declared in dependencies (^1.3.0) with no usage evidence — runtime loading can hide usage, verify before removing | — |
| `moment` (`.`) | medium | declared in dependencies (^2.30.0) with no usage evidence — runtime loading can hide usage, verify before removing | — |

## Move dependencies (1)

| Target | Confidence | Evidence | Bytes |
|---|---|---|---:|
| `lodash` (`.`) | high | declared in both dependencies and devDependencies — imported by non-test reachable code, keep the dependencies entry | — |

## Add missing dependencies (1)

| Target | Confidence | Evidence | Bytes |
|---|---|---|---:|
| `zod` (`.`) | high | imported by 1 file (e.g. src/index.ts) but declared in no manifest | — |

## Dedupe the lockfile (1)

| Target | Confidence | Evidence | Bytes |
|---|---|---|---:|
| `semver` | low | 2 resolved versions in the lockfile: 6.3.1, 7.6.0 | — |

## Untrack and gitignore (3)

| Target | Confidence | Evidence | Bytes |
|---|---|---|---:|
| `.DS_Store` | high | OS or editor dropping (.DS_Store, 19 bytes) — belongs in .gitignore, not in git | 19 B |
| `debug.log` | high | committed log file (*.log, 50 bytes) — belongs in .gitignore, not in git | 50 B |
| `dist/index.js` | high | committed build artifact (build output directory "dist", 73 bytes) — belongs in .gitignore, not in git; it is also unreachable in the module graph | 73 B |

## Consolidate overlapping packages (1)

| Target | Confidence | Evidence | Bytes |
|---|---|---|---:|
| `date libraries` (`.`) | low | 2 date libraries in one manifest (dayjs, moment) — pick one date library; date-fns and dayjs are the lightest — migrate call sites incrementally. | — |

## Sensitive files — review, never auto-delete (1)

> Rotate any exposed credentials FIRST. These files are reported only —
> untrack and gitignore them by hand, never delete them automatically.

| Target | Confidence | Evidence | Bytes |
|---|---|---|---:|
| `.env` | high | may contain secrets — never auto-delete; rotate credentials, untrack, and gitignore | — |

## Rescued by --keep (1)

| Target | Action | Pattern | Evidence |
|---|---|---|---|
| `src/plugins/analytics.ts` | delete-file | `plugins\/` | unreachable from the only entrypoint; repo has dynamic imports — verify none loads this file |

## Next steps

1. Work on a fresh branch: `git switch -c repo-doctor/cleanup`.
2. Delete files with `git rm <path>` (never plain `rm`) so every removal is staged and reviewable.
3. Untrack junk with `git rm --cached <path>` and add the path to `.gitignore`.
4. Remove dependencies inside each package dir: `npm remove <name>`.
5. Review items are findings to discuss — they are never executed from the plan.
6. Re-verify from the target repo root: `npx tsx $SKILL/scripts/verify.ts --baseline .repo-doctor/report.json` — gates must pass before merging. (`$SKILL` is this skill's checkout directory.)
