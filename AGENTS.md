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

## Eve Engineering and OpenViking

This file is shared by the VPS and local Cursor. Do **not** put host IPs,
`/srv` paths, or “how to SSH this VPS” here. Wire MCP on each machine in
user config (`~/.cursor/mcp.json`), not in git.

**OpenViking** — account `(none)`. **No OpenViking account** for this repo — fail closed; do not invent a tenant. One product → one account.
Fail closed if unknown; never invent a tenant. Use the OpenViking MCP (or
`ov-write-safe` when MCP is down). Never store secrets, `.env`, tokens, or
PII in OV. After substantive work: secret-free `sessions/YYYY-MM-DD-slug.md`;
durable facts in `architecture/` or `decisions/`. Replace stale claims.

**Eve** is review-only local CI (hosted GitHub Actions is billing-disabled).
It never edits this repo. Jobs live in `engineering-quality.yaml`. When you
finish implementing, run Eve CI (`.githooks/eve-ci` on the workstation, or
the `eve_ci` MCP tool) and fix failures yourself; re-run. Do not ask Eve
to patch or open a PR. Semantic review is advisory.

Host-only notes belong in a gitignored `AGENTS.host.md` or user Cursor rules.
