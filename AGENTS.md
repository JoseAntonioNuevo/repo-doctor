# Agent instructions — repo-doctor

This repository **is an agent skill**: `SKILL.md` + `scripts/` + `references/`.

## If you were pointed here to clean up a repository

Read `SKILL.md` and follow its workflow exactly. The one non-negotiable rule:
run the scan and plan scripts before proposing any deletion — never slim a
repo by gut feeling. All scripts are standalone CLIs:

```bash
npx tsx scripts/scan.ts --help
npx tsx scripts/plan.ts --help
npx tsx scripts/verify.ts --help
```

## If you are developing this repository itself

- Quality gate: `pnpm install --frozen-lockfile && pnpm test && pnpm
  typecheck` — all must pass before any commit or PR. CI
  (`.github/workflows/ci.yml`) runs the same.
- `scripts/` may import **Node.js builtins only** — no runtime npm
  dependencies, ever. Dev-only tooling lives in `devDependencies`.
- Pure logic goes in `scripts/lib/` with tests in `tests/`; the three
  top-level scripts are thin CLI wrappers.
- Keep `SKILL.md` tool-agnostic (standard `name`/`description` frontmatter
  only) and lean — detail belongs in `references/` or `--help` output.
- The demo artifacts in `examples/` are generated: edit
  `examples/make-demo.ts`, then regenerate `demo-report.json` and the plan
  files with the commands in its header comment.
- No production services deploy from this repository.
