# Repository bloat patterns

A field catalog of the ways repositories accumulate weight without accumulating
value. Used during the REVIEW phase to classify plan items and to justify each
removal to the user.

For each pattern: how to spot it, why it is bloat, the remedy, and — just as
important — when it is **not** bloat.

Contents:

1. [Committed build artifacts](#1-committed-build-artifacts)
2. [Zombie modules](#2-zombie-modules)
3. [Copy-paste `-old` / `-v2` files](#3-copy-paste--old---v2-files)
4. [Committed env and secret files](#4-committed-env-and-secret-files)
5. [Duplicated asset copies](#5-duplicated-asset-copies)
6. [Dependency graveyard](#6-dependency-graveyard)
7. [Dual-declared dependencies](#7-dual-declared-dependencies)
8. [Workspace version skew](#8-workspace-version-skew)
9. [Lockfile multi-version drift](#9-lockfile-multi-version-drift)
10. [Overlapping package families](#10-overlapping-package-families)
11. [Giant binaries in git history](#11-giant-binaries-in-git-history)

---

## 1. Committed build artifacts

**Signal:** tracked paths under `dist/`, `build/`, `.next/`, `coverage/`,
`storybook-static/`… — the scan's `build-artifact` junk category. The tell:
every source commit drags a wall of generated diffs behind it.

**Why it's bloat:** the artifact is derivable from source on demand. Tracking
it bloats every clone and diff, produces merge conflicts nobody resolves
meaningfully, and inevitably drifts stale against the source that generates it.

**Remedy:** `git rm -r --cached <dir>`, add the dir to `.gitignore`, and let
CI/deploy rebuild it (the plan emits this as `untrack-and-gitignore`).

**Not bloat when:** the built output is committed on purpose — packages
installed straight from git (`"dep": "github:user/repo"`) need `dist/` in the
tree, and GitHub Pages sites serve committed output. Confirm before
untracking; see `false-positives.md` §11.

## 2. Zombie modules

**Signal:** module files unreachable from every entrypoint in the import graph
(`graph.orphans` in the report). They often import each other, forming dead
clusters — the `importers` field shows who dies together.

**Why it's bloat:** dead code still costs: it gets read, grepped, refactored,
type-checked, security-patched, and cited as evidence that a feature "is still
used". Every future change pays rent on it.

**Remedy:** `git rm` after REVIEW. Delete whole clusters at once — a partial
deletion leaves the survivors orphaned all over again.

**Not bloat when:** the file is loaded dynamically, referenced by string
(plugin registries, worker paths), or reached by a framework convention the
scanner missed. Check `false-positives.md` §1–§3 first; rescue with `--entry`
(fixes the whole subtree) or `--keep`.

## 3. Copy-paste `-old` / `-v2` files

**Signal:** basenames like `utils-old.ts`, `api.bak`, `Header copy.tsx`,
`index.orig` sitting next to their live siblings — the `backup-copy` junk
category. Git already remembers every version; these are manual snapshots made
in fear of it.

**Why it's bloat:** two sources of truth. Someone eventually edits the dead
one, greps match both, and reviewers cannot tell which file is load-bearing.

**Remedy:** delete. The history has it; `git log --follow` beats a `.bak`.

**Not bloat when:** the suffixed file is the *live* one and the unsuffixed
sibling is dead (it happens after messy migrations). Check which one the graph
reaches before choosing a victim.

## 4. Committed env and secret files

**Signal:** the `sensitive` junk category. Detection covers `.env*` including
backup-suffixed copies (`.env.bak`) — the committed-on-purpose
`.env.example`/`.env.template`/`.env.sample`/`.env.test` are excluded —
`*.pem`/`*.key` including backup-suffixed forms (`server.pem.bak`,
`private.key.orig`), `id_rsa*`/`id_ed25519*`, and `.netrc`. It deliberately
does NOT inspect content: `.npmrc` auth tokens, service-account JSON, and
`.netrc`-shaped files under other names pass the scan silently — spotting
those is your judgment during review.

**Why it's bloat:** it isn't, primarily — it's an incident. Everyone with
clone access has the secret, forever, via history. The bloat is the least of
the problems.

**Remedy:** rotate the credentials FIRST, then untrack and gitignore. History
still holds the bytes; scrubbing it (git-filter-repo / BFG) is a
force-push-level human decision, never an automated one. The plan emits these
as `review-sensitive` and nothing else — never any delete action.

**Not bloat when:** `.env.example`, `.env.template`, `.env.sample`, and
`.env.test` are documentation, not secrets — the scanner already excludes
them. Public certs can be fine; keys are not.

## 5. Duplicated asset copies

**Signal:** byte-identical tracked files (`duplicateGroups`, sha1-grouped) —
typically an image copied into three feature folders, or the same font under
`public/` and `src/assets/`.

**Why it's bloat:** `wastedBytes` on every clone, and the copies fork
silently — the day someone edits one, the others are stale and nobody knows
which is canonical.

**Remedy:** keep the survivor the plan names — chosen by reachability and
reference evidence (a reachable module or entrypoint outranks an unreferenced
copy), never by name order — delete the rest, update references. Deletion is
high-confidence only when the copy is provably referenced nowhere; a copy
whose reference status is unknown is medium at most — grep before deleting.

**Not bloat when:** tooling pins a copy to a magic location (a favicon that
must sit at a served root, a font a build step inlines by path). Dedupe
through the build config, not by breaking the convention.

## 6. Dependency graveyard

**Signal:** declared dependencies with no imports, no text hits, and no
implicit-use rule (each package's `unused` list in the report).

**Why it's bloat:** install time, `node_modules` weight, audit noise, upgrade
churn — and every unused dep is a supply-chain door nobody is watching.

**Remedy:** `<pm> remove`. Unused devDependencies are the safest removals;
unused runtime dependencies deserve a call-site scan first (runtime loading
can hide usage — that is why the plan rates them medium).

**Not bloat when:** the dep is used through a bin the catalog doesn't know,
config shorthand, a plugin host's peer requirement, or types-only wiring.
Check `false-positives.md` §4–§6 and §9 before removing.

## 7. Dual-declared dependencies

**Signal:** the same name in both `dependencies` and `devDependencies` of one
manifest (`dualDeclared`).

**Why it's bloat:** ambiguity about the real contract. The two ranges can
silently diverge, and what consumers get depends on which field wins in which
package manager.

**Remedy:** keep the side the evidence names (imported by shipped code →
`dependencies`; otherwise `devDependencies`), delete the other, reinstall.

**Not bloat when:** essentially never — this one is a plain mistake. The only
judgment is which side survives.

## 8. Workspace version skew

**Signal:** the same dependency declared with two or more distinct ranges
across workspace manifests (`workspaceSkew`, with dir → range pairs).

**Why it's bloat:** multiple installed copies, subtle type mismatches across
packages, and "works in app A, breaks in app B" bugs that cost afternoons.

**Remedy:** align on one range (the `align-versions` item lists every
dir → range), or centralize — pnpm `catalog:`, or hoisting the dep to the
root.

**Not bloat when:** the skew is a deliberate staged migration (one package
pinned older on purpose while the rest move). If so, it deserves a comment in
the manifest, not silence.

## 9. Lockfile multi-version drift

**Signal:** one package resolved at two or more versions in the lockfile
(`lockfileDuplicates`).

**Why it's bloat:** bigger installs and bundles — and for identity-sensitive
packages (react, zod, graphql) duplicate instances break `instanceof`,
context, and singleton state at runtime.

**Remedy:** `<pm> dedupe`, then fix the declared ranges that force the split
(usually the skew from §8).

**Not bloat when:** semver genuinely forbids convergence — a dependency
straddling a major with incompatible peer ranges. Dedupe cannot fix what the
constraint solver is required to split.

## 10. Overlapping package families

**Signal:** two or more same-purpose packages declared in one manifest —
lodash + underscore, moment + dayjs + date-fns, axios + got + node-fetch
(`overlaps`, each with a consolidation hint).

**Why it's bloat:** double the bundle for one capability, two idioms for
reviewers to hold, twice the upgrade and CVE surface.

**Remedy:** pick one (the finding's hint suggests which) and migrate call
sites incrementally. This is `consolidate-overlap` — a migration to propose,
never an automated deletion.

**Not bloat when:** a consolidation is already mid-flight, or the packages
serve genuinely different niches (node-fetch in build scripts, axios
interceptors in the app). Then say so where the next reader will look.

## 11. Giant binaries in git history

**Signal:** the report's `largeFiles` list, or a `.git` directory several
times larger than the checkout — archives, videos, and datasets that were
committed once, even if deleted since.

**Why it's bloat:** git stores history. Deleting the file today does not
shrink a single clone; every `git clone` still downloads every version ever
committed.

**Remedy:** for the working tree, delete or untrack via the plan like
anything else. For history, git-filter-repo or BFG plus Git LFS for future
large assets — **explicitly out of scope for automated action**: it rewrites
shared history and needs a coordinated force push, so it is always a human
decision.

**Not bloat when:** the binary is genuinely versioned product content (design
sources, golden fixtures, sample media under test). Consider LFS rather than
removal.

---

## Attribution discipline

When justifying a plan item, cite the pattern number and the concrete
evidence, e.g.:

> `dist/bundle.js` — #1 committed build artifact (`untrack-and-gitignore`,
> 1.2 MB); regenerated by `pnpm build`, last diverged from source 4 months ago.

If an item fits no pattern but the evidence is solid (an orphan with zero
importers in a repo with no dynamic imports), say "unreachable, no bloat
pattern" rather than forcing a label. Found a new pattern in the wild?
Report it:
https://github.com/JoseAntonioNuevo/repo-doctor/issues/new?template=bloat-pattern.yml
