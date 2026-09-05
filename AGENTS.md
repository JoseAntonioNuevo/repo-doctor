# repo-doctor

Public agent skill with no production services or OpenViking tenant. Do not write its memory under `hermes` or another account; continue from repository evidence.

## Using it on a repo

Read `SKILL.md`. Run scan/plan scripts before proposing deletions.

```bash
npx tsx scripts/scan.ts --help
npx tsx scripts/plan.ts --help
npx tsx scripts/verify.ts --help
```

## Developing this repo

```bash
pnpm install --frozen-lockfile && pnpm test && pnpm typecheck
```

- `scripts/` import Node builtins only. Logic in `scripts/lib/`; tests in `tests/`.
- Keep `SKILL.md` lean and tool-agnostic. Detail in `references/` or `--help`.
- Demo artifacts are generated from `examples/make-demo.ts`.
