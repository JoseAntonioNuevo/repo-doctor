# Changelog

## 0.2.0

- Require Node.js 22.13+ and ship committed dependency-free MJS executables.
- Replace v1 artifacts with repository-bound scan, approval plan, and verify
  schemas. Version-1 artifacts are rejected and must be regenerated.
- Add exact `--approve`, keep precedence, protected paths, deferred dependency
  fixpoints, scoped diagnostics, and nested project/workspace discovery.
- Harden TypeScript/package/Vite resolution, dependency evidence scoping, and
  npm/pnpm/Yarn/Bun lockfile handling.
- Make verification static-only by default. Repository installs/scripts require
  `--run-gates --trust-repo`, frozen installs, a scrubbed environment, bounded
  output, and process-tree timeouts.
- Harden artifact paths against symlink redirection, collisions, tracked
  destinations, unsafe external writes, and partial direct truncation.

### Migration

Delete old `.repo-doctor/` v1 artifacts, run the 0.2.0 scan, review a new draft
plan, and regenerate it with exact approvals. Add explicit trusted-gate flags
only when executing the target repository is acceptable.
