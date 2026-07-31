# False positives — the rescue guide

The scanner sees three things: git-tracked files, the static import graph, and
declared manifests. Real usage hides from all three in the ways below. During
the REVIEW phase, check every `delete-file` and `remove-dep` candidate against
this list. Rescue by re-running `plan.ts` with `--keep` (or re-scanning with
`--entry` when a whole subtree is affected) — never by editing the plan by
hand, so the audit trail records each rescue and why.

Contents:

1. [Dynamic imports with computed paths](#1-dynamic-imports-with-computed-paths)
2. [String-referenced modules](#2-string-referenced-modules)
3. [Framework conventions the scanner may miss](#3-framework-conventions-the-scanner-may-miss)
4. [CLI-only deps whose bin ≠ package name](#4-cli-only-deps-whose-bin--package-name)
5. [Config shorthand beyond the built-in catalog](#5-config-shorthand-beyond-the-built-in-catalog)
6. [Peer deps consumed by a plugin host](#6-peer-deps-consumed-by-a-plugin-host)
7. [Assets referenced from CMS/db content or constructed URLs](#7-assets-referenced-from-cmsdb-content-or-constructed-urls)
8. [public/ files served by convention](#8-public-files-served-by-convention)
9. [Type-only packages](#9-type-only-packages)
10. [Files referenced from CI/Docker](#10-files-referenced-from-cidocker)
11. [Intentionally committed dist/](#11-intentionally-committed-dist)

---

## 1. Dynamic imports with computed paths

``import(`./locales/${lang}.ts`)`` reaches files no static graph can see. The
scanner knows its own blindness: any non-literal `import()`/`require()` lands
the file in `graph.dynamicImporters`, and a non-empty list downgrades orphans
to medium confidence — with one exception: an orphan ALSO named like a backup
copy (`-old`, `.bak`…) stays high, two independent death signals. Separately,
when the scan discovered no module entrypoints at all, every orphan item is
capped at low and the plan carries a warning — reachability was never
measured, only asserted.

**Rescue check:** grep each orphan's basename and parent dir name across the
`dynamicImporters` files. A directory whose contents are enumerated at runtime
(locales, themes, handlers) is live wholesale — `--keep` the directory.

## 2. String-referenced modules

Plugin registries, DI containers, worker constructors
(`new Worker("./worker.js")`), webpack magic comments, test `setupFiles`,
serverless handler strings (`"src/handlers/pay.handler"`) — all reference
modules by string, not by import.

The scan pre-screens for this: an orphan whose repo-relative path appears
verbatim in any tracked text file (config, workflow, Makefile…), or that
starts with a shebang, becomes a `review-file` item citing the referencing
file instead of a delete candidate. That catches exact path mentions only.

**Rescue check:** still grep the orphan's path fragments (not just the
basename) across configs, YAML, and JSON as well as source — the automation
lowers the odds, it doesn't retire the check. Registries usually name whole
families — rescue the family, not one file.

## 3. Framework conventions the scanner may miss

The graph knows common roots (`app/`, `pages/`, `src/routes/`, `middleware.*`,
config files, tests, stories…) but not every framework: Nuxt auto-imported
`composables/` and `components/`, SvelteKit `hooks.*` and `params/`, Astro
content collections, `import.meta.glob` route tables.

**Rescue check:** if orphans cluster inside one directory, suspect a missed
convention. Prefer `--entry <root>` + re-scan over `--keep` — it fixes the
whole subtree and future runs.

## 4. CLI-only deps whose bin ≠ package name

The bin catalog knows the common mismatches (`tsc` → typescript,
`changeset` → @changesets/cli), but a dep used only as `weird-cli` in a script
or workflow line looks unused when the catalog doesn't map it.

**Rescue check:** look up the package's `bin` field (its `package.json` on
npm), then grep those bin names across every manifest's `scripts` and
`.github/workflows/`. If real, `--keep` it — and PR the mapping into
`scripts/lib/catalogs.ts` so the next run knows.

## 5. Config shorthand beyond the built-in catalog

Tool configs load packages from un-prefixed short names: eslint `extends:
"next/core-web-vitals"` means eslint-config-next, babel presets drop their
prefix, postcss/tailwind plugins are listed as strings. The built-in shorthand
rules cover eslint-config-*, babel-preset-*, and prettier-plugin-*; anything
more exotic looks unused.

**Rescue check:** read the tool's config files for the short form of the dep's
name before believing "unused" for anything named `*-config-*`, `*-preset-*`,
or `*-plugin-*`.

## 6. Peer deps consumed by a plugin host

Some packages are declared solely so another package can load them: a
tailwind plugin's peer, the parser an eslint config requires, the adapter a
framework preset resolves by name. Your code never imports them; the host
does, at runtime, from its own resolution root.

**Rescue check:** for each "unused" dep, check whether another declared dep
lists it in `peerDependencies` (or its docs demand it installed). If yes,
`--keep` it with that reason.

## 7. Assets referenced from CMS/db content or constructed URLs

`/images/${slug}.jpg` built at runtime, image URLs stored in a CMS or
database, OG images fetched by external crawlers — the basename search over
tracked text files cannot see any of it.

**Rescue check:** before acting on `unreferencedAssets`, ask how the asset
directory is consumed. If URLs into it are constructed or stored outside the
repo, treat the whole directory as live. This is why asset findings are
low-confidence and never auto-deleted.

## 8. public/ files served by convention

Anything under `public/`, `static/`, or an equivalent served root is fetched
by URL, not imported. Well-known names (favicons, robots.txt, og-images…) are
already skipped, but arbitrary files in served roots are reachable too —
deep-linked PDFs, downloads, `.well-known` payloads.

**Rescue check:** assume convention-served directories are live unless access
logs (or the user) prove otherwise. Deletion here is a product decision, not
a hygiene one.

## 9. Type-only packages

A dep can be wired in without one import statement: tsconfig `types` /
`typeRoots` entries, `/// <reference types="…" />` in a d.ts, ambient globals
a package injects. The `@types/*` pairing rule catches the common case; the
tsconfig paths are on you.

**Rescue check:** grep the dep's name in every `tsconfig*.json` and `.d.ts`
before removing a package whose name starts with `@types/` or that ships only
declarations.

## 10. Files referenced from CI/Docker

`Dockerfile COPY scripts/migrate.js`, a workflow step running
`node tools/release.mjs`, Makefile targets, Procfiles. Modules under
`scripts/`, `tools/`, and `bin/` are entrypoints by convention already — but a
CI-invoked module in an unconventional directory looks orphaned.

**Rescue check:** grep the orphan's basename across `Dockerfile*`,
`.github/`, `Makefile`, `Procfile`, and deploy configs. (Exact repo-relative
path mentions in tracked files are already auto-demoted to `review-file` —
see §2 — but CI often invokes by basename or with a `./` prefix.) If found,
`--entry` it so the graph learns its real reachability.

## 11. Intentionally committed dist/

Packages installed straight from git (`"dep": "github:user/repo"`) need built
output in the tree; GitHub Pages serves committed `docs/` or `dist/`. The
`build-artifact` finding is right in general and wrong here.

**Rescue check:** before untracking a build dir, check the README and known
consumers for git-install or Pages usage. If intentional,
`--keep '^dist/'` and note the reason in the report.

---

## Execution rules by confidence

Who may pull the trigger, per tier — the REVIEW phase's contract:

| Tier | Execute? | Required diligence before acting |
|---|---|---|
| `high` | Yes, on the cleanup branch, no extra sign-off | Read the evidence line; confirm no section above applies. |
| `medium` | Only after a call-site scan | Repo-wide grep of the target's basename / dep name across **all** file types, plus the matching sections above; anything ambiguous escalates to the user. |
| `low` | No — present, don't act | Overlaps, hoisted deps, unreferenced assets: show the evidence and let the user decide. Always a conversation. |
| `review-file` items (any tier) | Never executed from the plan | Findings to discuss or convert into an explicit decision (delete, keep, `--keep` rescue) — the plan itself never orders them, regardless of confidence. |
| `review-sensitive` items (any tier) | Never delete, period | Report immediately; credentials rotate; untrack + gitignore only with explicit user agreement. |

A rescued item stays in the plan with `rescued: true` and the pattern that
saved it. Mention every rescue in the final report — it is the difference
between a cleanup the user trusts and one they re-audit by hand.
