/**
 * Static knowledge catalogs for the dependency analyzer.
 *
 * Curated, not exhaustive: each entry earns its place by rescuing a real
 * false positive (bins) or flagging a real consolidation win (families).
 * See CONTRIBUTING.md for how to add entries.
 */

/**
 * CLI binary name -> npm package that provides it.
 *
 * A dependency used only from package.json scripts is never imported, so the
 * import graph alone would flag it unused. When one of these bin names appears
 * as a word in any manifest's scripts, the owning package counts as used.
 * Most bins match their package name; the map exists for the ones that do not
 * (tsc, changeset, svelte-kit…) and to pin exactly which script tokens count
 * as usage evidence at all.
 */
export const BIN_TO_PACKAGE: Record<string, string> = {
  astro: "astro",
  changeset: "@changesets/cli",
  commitlint: "@commitlint/cli",
  concurrently: "concurrently",
  "cross-env": "cross-env",
  cypress: "cypress",
  "drizzle-kit": "drizzle-kit",
  esbuild: "esbuild",
  eslint: "eslint",
  husky: "husky",
  jest: "jest",
  "lint-staged": "lint-staged",
  next: "next",
  nodemon: "nodemon",
  nx: "nx",
  playwright: "playwright",
  prettier: "prettier",
  prisma: "prisma",
  rimraf: "rimraf",
  rollup: "rollup",
  storybook: "storybook",
  "svelte-kit": "@sveltejs/kit",
  tailwindcss: "tailwindcss",
  "ts-node": "ts-node",
  tsc: "typescript",
  tsup: "tsup",
  tsx: "tsx",
  turbo: "turbo",
  vercel: "vercel",
  vite: "vite",
  vitest: "vitest",
  webpack: "webpack",
  wrangler: "wrangler",
};

/**
 * Same-purpose package families. Declaring two or more members of one family
 * in a single manifest is a consolidation opportunity, never an automatic
 * removal — call sites must migrate first, so the planner emits these at low
 * confidence with the family's hint as evidence.
 */
export const OVERLAP_FAMILIES: { family: string; packages: string[]; hint: string }[] = [
  {
    family: "utility belts",
    packages: ["lodash", "lodash-es", "underscore", "ramda"],
    hint: "pick one utility belt; most underscore/ramda call sites have direct lodash equivalents — lodash-es tree-shakes best in bundlers.",
  },
  {
    family: "date libraries",
    packages: ["moment", "dayjs", "date-fns", "luxon"],
    hint: "pick one date library; date-fns and dayjs are the lightest — migrate call sites incrementally.",
  },
  {
    family: "HTTP clients",
    packages: ["axios", "got", "superagent", "node-fetch", "isomorphic-fetch", "ky", "request"],
    hint: "standardize on built-in fetch (Node 18+) or a single client; these overlap almost entirely and request is deprecated.",
  },
  {
    family: "class names",
    packages: ["classnames", "clsx"],
    hint: "classnames and clsx are API-compatible — keep clsx (smaller) and swap the import.",
  },
  {
    family: "unique ids",
    packages: ["uuid", "nanoid", "shortid", "cuid", "ulid"],
    hint: "keep one id generator; crypto.randomUUID() already covers plain uuid call sites without any dependency.",
  },
  {
    family: "test runners",
    packages: ["jest", "vitest", "mocha", "ava", "jasmine"],
    hint: "one test runner per repo — a second one doubles config, CI time, and flake surface.",
  },
  {
    family: "terminal colors",
    packages: ["chalk", "kleur", "picocolors", "colors", "ansi-colors"],
    hint: "keep one color library; picocolors is the smallest drop-in for chalk-style call sites.",
  },
  {
    family: "CLI arg parsers",
    packages: ["commander", "yargs", "minimist", "meow", "arg"],
    hint: "keep one argument parser; node:util parseArgs handles simple CLIs with no dependency at all.",
  },
  {
    family: "env loaders",
    packages: ["dotenv", "dotenv-flow", "dotenv-safe"],
    hint: "plain dotenv covers most setups — the -flow/-safe variants fork its precedence rules and confuse each other.",
  },
  {
    family: "deletion utils",
    packages: ["rimraf", "del"],
    hint: "rimraf and del both wrap recursive deletion; node:fs rm(path, { recursive: true, force: true }) usually replaces both.",
  },
  {
    family: "state management",
    packages: ["redux", "zustand", "mobx", "jotai", "recoil"],
    hint: "multiple state managers fragment an app's data flow — consolidate on one store and migrate feature by feature.",
  },
  {
    family: "schema validation",
    packages: ["joi", "yup", "zod", "ajv", "superstruct"],
    hint: "pick one schema validator; zod covers most joi/yup/superstruct patterns with better TypeScript inference.",
  },
];
