# repo-doctor 🧹

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/JoseAntonioNuevo/repo-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/JoseAntonioNuevo/repo-doctor/actions/workflows/ci.yml)
[![Node >= 22.13](https://img.shields.io/badge/node-%3E%3D22.13-blue.svg)](package.json)
[![Agent Skill](https://img.shields.io/badge/agent%20skill-SKILL.md-8A2BE2)](SKILL.md)

An agent skill and standalone CLI for finding dead modules, committed junk,
duplicate files, unreferenced assets, unused dependencies, undeclared
workspace imports, version skew, and lockfile drift without deleting by guess.

Repo Doctor 0.2.0 is deliberately conservative: the scan records evidence,
the plan starts every concrete mutation as pending, a reviewer approves exact
item IDs, and verification accepts only the reviewed mutations.

## Requirements and installation

- Node.js `>=22.13`
- Git
- No runtime npm dependencies
- A clean Git baseline before generating a mutation-capable plan

```bash
git clone https://github.com/JoseAntonioNuevo/repo-doctor.git ~/skills/repo-doctor
REPO_DOCTOR_ROOT="$HOME/skills/repo-doctor"
node "$REPO_DOCTOR_ROOT/bin/repo-doctor-scan.mjs" --help
```

Clone it into your agent's skills directory if that agent supports skill
discovery. The directory must be named `repo-doctor` so `SKILL.md` and the
installation path agree.

## Safety model

The v2 workflow binds three things:

1. `report.json` records the Git repository identity, baseline HEAD, index,
   tracked-file inventory, scan options, analysis health, and diagnostics.
2. `plan.json` hashes the exact report bytes and records exact file hashes or
   manifest fields/ranges for every possible mutation. Items remain `pending`
   until their exact IDs are approved.
3. `verify.json` proves that every disappearance and dependency edit was
   authorized, protected files remained unchanged, and no new orphan,
   unresolved import, missing declaration, or degraded analysis capability
   appeared.

Artifacts are bounded, non-symlink regular files. Outputs are written through
an exclusive same-directory temporary file and atomic rename. Repo Doctor
rejects symlinked parents, tracked artifact destinations, path collisions, and
paths outside the target unless `--allow-output-outside-cwd` is explicit.

Version-1 reports and plans are not accepted. Re-run scan and plan with 0.2.0.

## Workflow

Set the installation and target once. Both values are quoted, so paths with
spaces are safe.

```bash
REPO_DOCTOR_ROOT="$HOME/skills/repo-doctor"
TARGET_REPO="/path/to/target repo"
```

### 1. Scan

```bash
node "$REPO_DOCTOR_ROOT/bin/repo-doctor-scan.mjs" --cwd "$TARGET_REPO"
```

The scanner reads Git-tracked state, including sparse-checkout files from the
index. It discovers declared workspaces, independent nested projects, and
unmanaged manifests; resolves TypeScript/JavaScript aliases, `baseUrl`,
multi-level `extends`, package `imports`/`exports`, literal dynamic imports,
and Vite globs; and records scoped diagnostics when analysis is incomplete.

Useful scan flags:

| Flag | Default | Meaning |
|---|---|---|
| `--out` | `.repo-doctor/report.json` | v2 report path |
| `--ignore <regex>` | — | Exclude a tracked path from every analysis capability; repeatable |
| `--entry <path>` | — | Add a dynamically/framework-loaded graph root; repeatable |
| `--large-count` | `20` | Number of largest files to report |
| `--min-dup-bytes` | `1` | Smallest duplicate candidate |
| `--concurrency` | `8` | Concurrent tracked-file reads |

### 2. Generate and review a draft plan

```bash
node "$REPO_DOCTOR_ROOT/bin/repo-doctor-plan.mjs" --cwd "$TARGET_REPO"
```

Read `.repo-doctor/plan.md` and the guides in
[`references/false-positives.md`](references/false-positives.md) and
[`references/bloat-patterns.md`](references/bloat-patterns.md).

- `proposed`: concrete high-confidence mutation, still pending approval.
- `manual`: concrete medium-risk mutation requiring deeper review.
- `review-only`: advisory finding without an executable mutation.
- `deferred`: requires an approved file cleanup and a fresh scan first.
- `blocked`: sensitive or affected by incomplete/ambiguous analysis.

Keep known-live items and approve exact IDs by regenerating the plan:

```bash
node "$REPO_DOCTOR_ROOT/bin/repo-doctor-plan.mjs" \
  --cwd "$TARGET_REPO" \
  --keep '^migrations/' \
  --approve 'delete-file:src/obsolete.ts'
```

`--keep` wins over `--approve`. `--allow-delete <exact-path>` is the explicit
exception for a reviewed entrypoint/reachable file. Sensitive paths can never
be approved or allowed; rotate/remediate them separately, then create a new
baseline.

### 3. Apply only approved mutations

Use Git-aware operations on a branch:

```bash
git switch -c repo-doctor/cleanup
git rm -- src/obsolete.ts
git rm --cached -- dist/app.js
```

Do not apply deferred dependency changes in this pass. After approved orphan
files are removed, run scan and plan again; the fresh graph may then prove a
dependency unused.

### 4. Static verification (default)

```bash
node "$REPO_DOCTOR_ROOT/bin/repo-doctor-verify.mjs" --cwd "$TARGET_REPO"
```

Static verification executes no target code and reports
`STATIC VERIFY PASSED`. Verify-time `--ignore` and `--entry` may only repeat
values already bound into the baseline; additions are rejected because they
would change the measurement.

### 5. Trusted gates (explicit opt-in)

```bash
node "$REPO_DOCTOR_ROOT/bin/repo-doctor-verify.mjs" \
  --cwd "$TARGET_REPO" \
  --run-gates --trust-repo
```

Trusted mode performs a frozen install for each discovered JavaScript project
and runs declared `typecheck`, `check`, `lint`, `build`, `test`, and `validate`
scripts. Root scripts take precedence over member scripts with the same name.

| Manager | Frozen install |
|---|---|
| pnpm | `pnpm install --frozen-lockfile` |
| npm | `npm ci` |
| Yarn Classic | `yarn install --frozen-lockfile` |
| Yarn Berry | `yarn install --immutable` |
| Bun | `bun install --frozen-lockfile` |

Repo Doctor never defaults an unknown project to npm. Non-JavaScript or
unsupported projects stay static-only unless you provide a trusted custom
`--gate`.

Gate processes receive a minimal environment, ephemeral home, and `CI=true`.
Use repeatable `--pass-env NAME` or the explicit `--inherit-env` escape hatch.
Only names are recorded. Environment scrubbing is not a sandbox; run untrusted
repositories in a disposable VM or container.

## Project and dependency behavior

- Only members matched by tracked workspace declarations belong to a
  workspace. A nested manifest with its own tracked manager/lockfile is a
  standalone project; an unmatched manifest without a boundary is unmanaged
  and dependency mutation is blocked.
- Dependency evidence is scoped to its owning package/project. Sibling scripts
  and configs do not rescue another package's declaration.
- Resolved graph edges—not raw string reinterpretation—distinguish aliases,
  private `#imports`, workspace packages, external packages, and builtins.
- Undeclared workspace imports are missing internal declarations; they are not
  silently treated as available through the workspace or hoisting.
- A sole unused dev dependency in a complete scope can be proposed at high
  confidence. Runtime dependencies are manual; peer/optional and multi-field
  declarations are review-only or manual. Dynamic loading reduces certainty.
- External missing dependencies never receive an invented version range.
- Lockfile parsing reports `parsed`, `unsupported`, or `invalid`; corrupt or
  unknown lockfiles never become an empty successful result.

## Lockfile support

Repo Doctor detects tracked npm, pnpm, Yarn, and Bun lockfiles. Duplicate
version analysis supports npm lockfile v1-v3 and shrinkwrap, supported pnpm
dialects, Yarn Classic, Yarn Berry, aliases, scoped packages, and CRLF input.
Bun is supported for manager/gate selection; unsupported Bun lock dialects
are explicit diagnostics and block lockfile advice.

## Exit codes

- `0`: requested report/plan written, or verification passed.
- `1`: authorization, protected-state, graph/dependency/health regression, or
  selected gate failure.
- `2`: usage error, legacy/malformed artifact, unsafe path, wrong/stale
  repository binding, unsupported automatic gate, or missing trust.

## Development

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm check:generated
```

The committed `bin/*.mjs` files are deterministic Node 22 ESM bundles. CI
rebuilds them and fails if the generated files differ. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CHANGELOG.md`](CHANGELOG.md).

## Limitations

- Module reachability currently targets JavaScript/TypeScript and supported
  component-file script blocks. Other repositories still receive Git
  inventory, junk, duplicate, asset, and static authorization checks.
- Static analysis cannot prove arbitrary computed loaders, runtime plugin
  registries, CMS references, reflection, or generated code. Affected scopes
  become uncertain, deferred, or blocked instead of producing high-confidence
  deletion advice.
- Repo Doctor does not automatically edit or delete target files. The plan is
  an auditable authorization document, not a mutation engine.

MIT licensed.
