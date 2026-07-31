# repo-doctor 🧹

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/JoseAntonioNuevo/repo-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/JoseAntonioNuevo/repo-doctor/actions/workflows/ci.yml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-blue.svg)](package.json)
[![Agent Skill](https://img.shields.io/badge/agent%20skill-SKILL.md-8A2BE2)](SKILL.md)

An [agent skill](https://agentskills.io) + standalone CLI scripts that
**audit and slim bloated repositories** — dead modules, byte-identical
duplicates, committed junk, unreferenced assets, and dependency bloat — with
an evidence-driven removal plan computed from the import graph and the
manifests, not gut feeling, and verified afterwards against the repo's own
build and test gates.

Works with **Claude Code, Codex, Cursor, Grok build, and any agent that can
read a markdown file and run a CLI** — and with no agent at all: the scripts
are plain `npx tsx` CLIs you can run by hand or in CI.

---

## The problem: repo bloat

Repositories grow in only one direction. AI-assisted development and years of
drift leave the same sediment everywhere: committed `dist/` and coverage
output, `utils-old.ts` next to `utils.ts`, whole module clusters nothing
imports anymore, the same image copied into four folders, a dependency
graveyard where moment, dayjs, AND date-fns are all declared and one is used.
Every clone, install, review, and grep pays for all of it — and a committed
`.env` in the pile is not bloat but an incident.

Prompting an LLM "delete the unused stuff" cannot fix this — it has no import
graph, no per-manifest usage data, and no idea which deletion breaks the
build. Deterministic scripts collect the evidence and compute the plan; the
agent's judgment is reserved for the two places it is genuinely needed:
rescuing files and deps whose usage static analysis can't see, and executing
the cleanup safely on a branch.

## How it works

```
┌─ 1. SCAN ────────────────┐   ┌─ 2. PLAN ────────────────┐   ┌─ 3. REVIEW ──────────────┐
│ scripts/scan.ts          │   │ scripts/plan.ts          │   │ agent judgment +         │
│ import graph, dep usage, │──▶│ findings → actions with  │──▶│ references/              │
│ junk, dups, assets       │   │ confidence tiers         │   │ false-positives.md       │
│ → report.json            │   │ → plan.json / plan.md    │   │ rescue / classify        │
└──────────────────────────┘   └──────────────────────────┘   └────────────┬─────────────┘
                                                                           │ git rm on a branch
┌─ 5. VERIFY ──────────────┐   ┌─ 4. CLEAN ───────────────┐                │
│ scripts/verify.ts        │◀──│ agent judgment           │◀───────────────┘
│ re-scan: no regressions, │   │ git rm / git rm --cached │
│ install/build/test       │   │ <pm> remove, .gitignore  │
│ gates green              │   │ never rm -rf             │
└──────────────────────────┘   └──────────────────────────┘
```

1. **SCAN** (script) — lists git-tracked files, hashes them, builds the
   module graph from entrypoint conventions (package.json fields, framework
   routes, configs, tests…), analyzes per-manifest dependency usage, parses
   the lockfile, and flags junk, duplicates, and unreferenced assets into a
   machine-readable report.
2. **PLAN** (script) — maps findings to concrete actions (`delete-file`,
   `untrack-and-gitignore`, `remove-dep`, `align-versions`, …), each with a
   confidence tier and one-line evidence. Deterministic: same report + same
   flags ⇒ the same plan, byte for byte (minus the `createdAt` timestamp).
3. **REVIEW** (agent/human) — nothing is deleted automatically. Candidates
   are checked against the [false-positive guide](references/false-positives.md)
   (dynamic imports, string references, CLI-only deps…); live ones get
   rescued with `--keep`. The [bloat-pattern catalog](references/bloat-patterns.md)
   names *why* each survivor dies.
4. **CLEAN** (agent/human) — on a clean branch, via git only: `git rm`,
   `git rm --cached` + `.gitignore`, `<pm> remove`. Sensitive files are
   never deleted — reported for credential rotation instead.
5. **VERIFY** (script) — re-scans with the baseline's recorded scan flags and
   diffs against it (new unresolved imports or missing deps = regressions),
   then runs the repo's own install/typecheck/build/test scripts. Non-zero
   exit on failure, so it can gate CI.

## Example: before / after

Output from the bundled demo (`examples/`) — a fixture repo with planted
bloat: a committed `dist/` and a stray log, an orphan module cluster, a
byte-duplicate file, an `-old` copy, unused deps, a dual-declared dep, and a
multi-version lockfile entry. (Numbers below are regenerated with the demo;
see [examples/demo-plan.md](examples/demo-plan.md) for the full plan.)

| Metric | Before | After (planned) |
|---|---:|---:|
| Tracked files | 14 | **7** |
| Tracked size | 2.2 KB | 1.6 KB |
| Declared dependencies | 5 | 4 |
| Reclaimable bytes | — | 625 B |

Plan excerpt — every item carries its action, confidence, and evidence
(evidence quoted verbatim from the generated plan):

| Target | Action | Confidence | Evidence |
|---|---|---|---|
| `dist/index.js` | untrack-and-gitignore | high | committed build artifact (build output directory "dist", 73 bytes) — belongs in .gitignore, … |
| `src/index-old.ts` | delete-file | high | unreachable from the only entrypoint; the filename also marks it as a backup copy |
| `src/legacy/engine.ts` | delete-file | medium | unreachable from the only entrypoint; repo has dynamic imports — verify none loads this file |
| `left-pad` | remove-dep | medium | declared in dependencies (^1.3.0) with no usage evidence — runtime loading can hide usage, … |

And two deliberately planted teaching cases show why step 3 (REVIEW) exists:

- `moment` **and** `dayjs` in one manifest — the scripts flag the overlap but
  only ever *suggest* consolidating; picking the survivor and migrating call
  sites is the review phase's job.
- a dynamically imported module — **looks orphaned**, because
  `import(computed)` is invisible to the static graph. The report's
  `dynamicImporters` field downgrades its confidence, and the review phase
  rescues it.

Try it yourself, no target repo needed:

```bash
git clone https://github.com/JoseAntonioNuevo/repo-doctor.git
cd repo-doctor
npx tsx scripts/plan.ts --report examples/demo-report.json \
  --out-plan /tmp/plan.json --out-md /tmp/plan.md --keep 'plugins/'
```

## Installation

The skill is a plain folder — `SKILL.md` (the workflow) + `scripts/`
(deterministic CLIs) + `references/` (judgment guides). Installing it
anywhere is "put the folder where your tool looks for it."

### Claude Code

```bash
# user-level (all projects)
git clone https://github.com/JoseAntonioNuevo/repo-doctor.git \
  ~/.claude/skills/repo-doctor

# or project-level (this repo only)
git clone https://github.com/JoseAntonioNuevo/repo-doctor.git \
  .claude/skills/repo-doctor
```

Or with the [skills CLI](https://github.com/vercel-labs/skills), which also
targets other compatible tools:

```bash
npx skills add JoseAntonioNuevo/repo-doctor
```

Then just ask: *"clean up this repo"*, *"find unused dependencies"*, *"remove
dead files"*. Claude Code auto-discovers the skill from its description.
Update later with `git -C ~/.claude/skills/repo-doctor pull`.

### Codex / OpenAI agents

Clone the repo anywhere (e.g. `~/skills/repo-doctor`) and point the agent at
it from your `AGENTS.md`:

```markdown
## Repository cleanup
When asked to clean up, slim, or audit the repository, read
~/skills/repo-doctor/SKILL.md and follow its workflow exactly.
Its scripts run standalone: `npx tsx ~/skills/repo-doctor/scripts/<name>.ts --help`.
```

Codex also supports the skills folder convention directly (`~/.codex/skills/`
in recent versions) — clone there and it is discovered like any other skill.

### Cursor

Clone the repo into your project (e.g. `tools/repo-doctor`, matching the
rule below) and add a rule (`.cursor/rules/repo-doctor.mdc`, or
Settings → Rules):

```
When the user asks to clean up the repo, remove dead files, or audit
dependencies, read tools/repo-doctor/SKILL.md and follow its workflow.
Always run its scan and plan scripts before proposing any deletion.
```

### Grok build and other agentic tools

Any tool that can read files and run shell commands can use this skill. Wire
it into the tool's custom-instructions mechanism with one line:

> Read `<path>/SKILL.md` and follow it when working on repository health.

The core workflow intentionally uses **no vendor-specific features** — no
Claude-Code-only frontmatter beyond the standard `name`/`description`, no MCP
servers, no tool-specific commands.

### No agent at all (human / CI)

The scripts are self-contained CLIs — Node ≥ 20, zero runtime dependencies
(`npx tsx` fetches the TypeScript runner on demand; `pnpm dlx tsx` works the
same if you prefer pnpm):

```bash
npx tsx scripts/scan.ts --cwd /path/to/repo
npx tsx scripts/plan.ts --report /path/to/repo/.repo-doctor/report.json
npx tsx scripts/verify.ts --cwd /path/to/repo
```

`verify.ts` exits non-zero on regressions or failing gates, so it drops
straight into a CI job as a guard after any large cleanup PR.

## CLI reference

Every script supports `--help`. The important knobs:

### `scripts/scan.ts` — SCAN

| Flag | Default | Meaning |
|---|---|---|
| `--cwd` | `.` | Target repo root (must be a git repository) |
| `--out` | `.repo-doctor/report.json` | Report path |
| `--ignore <regex>` | — | Drop matching tracked paths from all analysis (repeatable) |
| `--entry <path>` | — | Extra entrypoint the conventions miss (repeatable) |
| `--large-count` | `20` | How many largest files to report |
| `--min-dup-bytes` | `1` | Minimum file size for duplicate grouping |
| `--concurrency` | `8` | Parallel file reads/hashes |

Analyzes **git-tracked files only** (`git ls-files`) — untracked and ignored
files are already not the repo's problem. Not a git repo ⇒ exit 2.

### `scripts/plan.ts` — PLAN

| Flag | Default | Meaning |
|---|---|---|
| `--report` | `.repo-doctor/report.json` | Scan report to plan from |
| `--out-plan` | `.repo-doctor/plan.json` | Plan JSON path |
| `--out-md` | `.repo-doctor/plan.md` | Human-readable plan path |
| `--keep <regex>` | — | Rescue matching items — kept in the plan, marked `rescued` (repeatable) |
| `--min-confidence` | `low` | Lowest tier to include: `low` \| `medium` \| `high` |

### `scripts/verify.ts` — VERIFY

| Flag | Default | Meaning |
|---|---|---|
| `--cwd` | `.` | Target repo root |
| `--baseline` | `.repo-doctor/report.json` | Pre-cleanup scan to diff against |
| `--out` | `.repo-doctor/verify.json` | Verdict path |
| `--skip-install` / `--skip-typecheck` / `--skip-build` / `--skip-test` | off | Skip that gate |
| `--gate <cmd>` | — | Custom gate command; replaces the script gates (repeatable) |
| `--timeout-ms` | `600000` | Per-gate timeout |
| `--ignore <regex>` | baseline's | ADD an ignore pattern to the re-scan (repeatable) |
| `--entry <path>` | baseline's | ADD a module-graph entrypoint to the re-scan (repeatable) |

The re-scan replays the `--ignore`/`--entry` options recorded in the baseline
report, so both scans measure with the same instrument — the flags here only
add to that set (older baselines without recorded options re-scan with the
flags given here, plus a warning). The install gate deliberately allows a
lockfile update (`pnpm install --no-frozen-lockfile`, Yarn with immutable
installs off): the cleanup just edited manifests, and a frozen-lockfile
failure would go red before any regression is measured.

Exit codes: `0` pass · `1` regressions found / gates red · `2` environment
error.

## How detection works

- **Dead modules** — the scan builds an import graph over every tracked JS/TS
  file, plus `.vue`/`.svelte`/`.astro` SFCs whose script blocks import like
  any module (a comment-aware extractor handles `import`/`export from`/
  `require`/dynamic `import()`/reference directives; resolution understands
  extension guessing, `index.*`, ESM `.js`→`.ts` rewrites, per-package
  tsconfig `paths` — each workspace package's own tsconfig owns its aliases —
  and workspace packages). Entrypoints come from conventions: package.json
  `main`/`module`/`exports`/`bin` and script references, framework route
  dirs, config files, tests, stories, declarations, ops dirs, and tracked
  HTML. BFS from all entrypoints; what is never reached is an orphan.
- **Honest uncertainty** — any non-literal `import()`/`require()` puts its
  file in `dynamicImporters` and downgrades orphan confidence; unresolved
  specifiers are reported from reachable files only, so orphan noise doesn't
  drown them; an orphan whose path appears in a tracked text file or that
  starts with a shebang is demoted to a review item with that evidence cited.
- **One path, one instruction** — the planner's passes share a single claims
  set; the first pass to claim a path owns its instruction, so a file can
  never collect contradictory actions.
- **Dependency usage** — per manifest (workspace-aware): a dep is used if the
  manifest's own files import it, a tracked text file mentions it as a whole
  word, or an implicit rule applies (`@types/*` pairing, a bin-name catalog
  for CLIs like `tsc` → typescript, eslint/babel/prettier config shorthand,
  workspace packages). Everything else is unused; imported-but-undeclared is
  reported as missing, with hoisting evidence.
- **Junk, duplicates, assets** — first-match category rules for build
  artifacts, logs, caches, OS/editor droppings, backups, archives, generated
  bundles, and env/key files (report-only); sha1 groups for byte-identical
  duplicates (survivor picked by reachability evidence); a basename
  reference-search across text files for image/font/media assets. Symlinks
  are recorded as links and are never deletion candidates.
- **Lockfile** — light dependency-free parsers (line-based for pnpm-lock v6
  and v9+ and yarn classic, plain JSON for package-lock) surface
  multi-version duplicates without any YAML library.

Everything the static analysis can't see is pushed to the explicit REVIEW
step: that split — deterministic scripts for measurable facts, judgment for
conventions and intent — is the design center of the whole skill.

## Artifacts

All artifacts land under `.repo-doctor/` (gitignore it) — versioned JSON,
plus a human-readable markdown plan:

- `report.json` — files, hashes, module graph (entrypoints, orphans,
  unresolved, dynamic importers), per-package dependency usage, junk,
  duplicates, assets, lockfile duplicates, warnings.
- `plan.json` / `plan.md` — one item per action with target, confidence,
  evidence, reclaimable bytes, and rescue markers; the markdown version ends
  with the cleanup command templates.
- `report.after.json` / `verify.json` — the post-cleanup scan and the
  verdict: gates, regressions, before/after comparison.

## Limitations

- **JS/TS module graph only** (for now). Junk, duplicate, and asset detection
  work in any git repo, but imports in other languages are not parsed —
  orphan analysis covers `js/jsx/ts/tsx/mjs/cjs/mts/cts` plus the script
  blocks of `.vue`/`.svelte`/`.astro` files.
- **Static analysis is static.** Computed `import()` paths, plugin
  registries, and CMS-referenced assets are invisible — that's why
  confidence tiers, `dynamicImporters`, and the REVIEW step exist. Don't
  skip them.
- Dependency text-matching is whole-word: a dep referenced only through a
  constructed string can still look unused. `--keep` is the escape hatch and
  [false-positives.md](references/false-positives.md) the checklist.
- Lockfile parsers cover pnpm, npm, and yarn classic; exotic dialects skip
  unparseable lines rather than fail.
- **Git history is not rewritten.** Deleting a giant binary today shrinks no
  clone — the catalog's [pattern #11](references/bloat-patterns.md#11-giant-binaries-in-git-history)
  points at git-filter-repo/BFG, deliberately out of automated scope.
- Custom `--gate` commands are split on whitespace — no shell quoting.

## Contributing

Bug reports, new bloat patterns for the catalog, new bin mappings and overlap
families, and new lockfile dialects are all welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) (development is pnpm-first:
`pnpm install --frozen-lockfile && pnpm test && pnpm typecheck`). Found a new
bloat pattern in the wild?
[File it with the dedicated issue template](https://github.com/JoseAntonioNuevo/repo-doctor/issues/new?template=bloat-pattern.yml).

## License

[MIT](LICENSE) © Jose Antonio Nuevo
