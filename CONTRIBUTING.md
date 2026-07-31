# Contributing to repo-doctor

Thanks for helping make repositories smaller and safer to work in. Five kinds
of contributions are especially welcome:

1. **New bloat patterns** for the catalog
2. **New detection knowledge** — junk rules, bin mappings, overlap families
3. **New entrypoint conventions** (frameworks the graph should know)
4. **New lockfile dialects** (Bun, yarn berry, …)
5. **Bug fixes and test cases** for the scripts

## Development setup

```bash
git clone https://github.com/JoseAntonioNuevo/repo-doctor.git
cd repo-doctor
pnpm install --frozen-lockfile
pnpm test          # vitest self-tests
pnpm typecheck     # tsc --noEmit
```

Both must be green before opening a PR. CI runs them on Node 20 and 22, plus
a demo-pipeline smoke test: it builds the fixture repo from
`examples/make-demo.ts`, runs scan + plan over it, and asserts the planted
`dist/` artifact lands in the plan.

## Ground rules

- **Scripts stay dependency-light.** `scripts/` imports Node.js builtins only
  (`node:fs`, `node:path`, `node:child_process`, `node:util`…). No runtime
  npm dependencies — the scripts must run in any repo via `npx tsx` (or
  `pnpm dlx tsx`) without an install step. Dev dependencies (vitest,
  typescript, tsx) are fine.
- **Scripts stay tool-agnostic.** Nothing in `scripts/` or the core
  `SKILL.md` workflow may require a specific agent product. Any human with a
  shell must be able to run every step.
- **Determinism is a feature.** Same repo + same flags ⇒ byte-identical
  report and plan (minus `createdAt`). Every list is sorted; anything
  judgment-based belongs in `SKILL.md` or `references/`, not in code.
- **Every algorithm change ships with a test** in `tests/`. Pure logic lives
  in `scripts/lib/` precisely so it is unit-testable without a real repo or
  child processes.

## Adding a junk pattern

1. Open an issue with the [bloat-pattern template](https://github.com/JoseAntonioNuevo/repo-doctor/issues/new?template=bloat-pattern.yml)
   — or go straight to a PR.
2. Add the rule to the ordered `RULES` array in `scripts/lib/junk.ts`. Rule
   order matters — a file gets its FIRST matching category, and `sensitive`
   runs first on purpose so a secret (`dist/.env`, `server.pem.bak`) can
   never fall into a deletable category — so extend an existing category
   unless the finding needs a genuinely different plan action
   (`scripts/lib/planner.ts` decides what each category becomes, and its
   reachability veto can still turn a junk match into a review item).
3. Add cases to `tests/junk.test.ts`, including one showing what the rule
   does **not** match — over-matching junk rules delete real files.
4. If it is a new bloat family, add a numbered section to
   `references/bloat-patterns.md` (signal, why it's bloat, remedy, when it's
   NOT bloat) and update the table of contents.

## Adding an overlap family

`OVERLAP_FAMILIES` in `scripts/lib/catalogs.ts`: a family id, the package
list, and a one-sentence consolidation hint. A family fires when ≥2 members
are declared in one manifest — so only group true same-purpose substitutes;
packages that *layer* (a wrapper and its engine) do not belong in one family.
Ship a test asserting the family fires with two members and stays silent with
one.

## Adding a bin mapping

`BIN_TO_PACKAGE` in `scripts/lib/catalogs.ts` maps a CLI name to the package
that ships it (`tsc` → `typescript`). It rescues deps that are only ever
invoked from `package.json` scripts. Keep it to widely used tools — one-off
bins are what plan-time `--keep` is for. Ship a `tests/deps.test.ts` case.

## Adding an entrypoint convention

Entrypoint conventions live in `scripts/lib/graph.ts`, each with a
human-readable reason string (shown in the report). A convention makes files
reachable, so it can hide true orphans — justify it with a real framework's
documented behavior, not "seems safer". Add a `tests/graph.test.ts` case with
a minimal synthetic repo.

## Adding a lockfile dialect

`scripts/lib/lockfile.ts` — detection order lives in `detectLockfile`, one
parse branch per dialect in `parseLockfileVersions`. Parsers are deliberately
dependency-free — line-based for pnpm/yarn, plain `JSON.parse` for
package-lock (no YAML/JSON5 libraries) — and must never throw on weird
input: skip it. Add a small literal fixture to `tests/lockfile.test.ts` covering
scoped names and peer-suffix noise.

## Releases

Semver tags (`v0.x.y`). The skill is consumed by `git clone`, so `main` stays
releasable at all times.
