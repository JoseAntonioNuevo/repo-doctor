import { describe, expect, it } from "vitest";
import {
  analyzeDeps,
  loadManifests,
  specifierToPackage,
  type DepsInput,
} from "../scripts/lib/deps.ts";
import type { PackageManifest } from "../scripts/lib/types.ts";

/** Build manifests from an in-memory { path: manifestObject } tree (no filesystem). */
function manifestsOf(files: Record<string, object>): PackageManifest[] {
  return loadManifests(".", Object.keys(files), (p) => JSON.stringify(files[p])).manifests;
}

function analyze(opts: {
  files: Record<string, object>;
  imports?: Record<string, string[]>;
  text?: Record<string, string>;
  workspaceNames?: string[];
}): ReturnType<typeof analyzeDeps> {
  const input: DepsInput = {
    manifests: manifestsOf(opts.files),
    importsByFile: new Map(Object.entries(opts.imports ?? {})),
    textFiles: Object.entries(opts.text ?? {}).map(([path, content]) => ({ path, content })),
    workspacePkgNames: new Set(opts.workspaceNames ?? []),
  };
  return analyzeDeps(input);
}

function report(result: ReturnType<typeof analyzeDeps>, dir: string) {
  const match = result.packages.find((p) => p.dir === dir);
  if (!match) throw new Error(`no PackageReport for dir "${dir}"`);
  return match;
}

function usage(result: ReturnType<typeof analyzeDeps>, dir: string, name: string) {
  const match = report(result, dir).deps.find((d) => d.name === name);
  if (!match) throw new Error(`no DepUsage for "${name}" in "${dir}"`);
  return match;
}

describe("specifierToPackage", () => {
  it("maps deep imports to the owning package", () => {
    expect(specifierToPackage("react")).toBe("react");
    expect(specifierToPackage("lodash/fp")).toBe("lodash");
    expect(specifierToPackage("@scope/pkg/deep/module.js")).toBe("@scope/pkg");
  });

  it("returns null for relative and absolute specifiers", () => {
    expect(specifierToPackage("./util.ts")).toBeNull();
    expect(specifierToPackage("../lib/util.ts")).toBeNull();
    expect(specifierToPackage("/abs/path.js")).toBeNull();
  });

  it("returns null for Node builtins with and without the node: prefix", () => {
    expect(specifierToPackage("fs")).toBeNull();
    expect(specifierToPackage("node:fs")).toBeNull();
    expect(specifierToPackage("fs/promises")).toBeNull();
    expect(specifierToPackage("node:test")).toBeNull();
  });

  it("returns null for malformed and protocol specifiers", () => {
    expect(specifierToPackage("")).toBeNull();
    expect(specifierToPackage("@scope")).toBeNull();
    expect(specifierToPackage("https://cdn.example.com/x.js")).toBeNull();
  });
});

describe("loadManifests", () => {
  it("parses tracked manifests outside node_modules with '.' for the root", () => {
    const manifests = manifestsOf({
      "package.json": { name: "root", dependencies: { react: "^18.3.1" } },
      "apps/web/package.json": { name: "web" },
      "node_modules/lodash/package.json": { name: "lodash" },
      "apps/web/node_modules/x/package.json": { name: "x" },
    });
    expect(manifests.map((m) => m.dir)).toEqual([".", "apps/web"]);
    expect(manifests[0].fields.dependencies).toEqual({ react: "^18.3.1" });
    expect(manifests[0].fields.devDependencies).toEqual({});
  });

  it("skips an unparseable manifest with a warning and keeps the rest", () => {
    const { manifests, warnings } = loadManifests(".", ["package.json", "apps/web/package.json"], (p) =>
      p === "package.json" ? "{ not json" : '{"name":"web"}',
    );
    expect(manifests.map((m) => m.dir)).toEqual(["apps/web"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("package.json");
  });

  it("falls back to the directory when a manifest has no name", () => {
    const manifests = manifestsOf({
      "package.json": {},
      "packages/lib/package.json": { version: "1.0.0" },
    });
    expect(manifests.map((m) => m.name)).toEqual([".", "packages/lib"]);
  });

  it("drops non-string ranges instead of crashing", () => {
    const manifests = manifestsOf({
      "package.json": { dependencies: { good: "^1.0.0", bad: 42 } },
    });
    expect(manifests[0].fields.dependencies).toEqual({ good: "^1.0.0" });
  });
});

describe("analyzeDeps", () => {
  it("attributes imports to the manifest whose dir is the longest prefix", () => {
    const result = analyze({
      files: {
        "package.json": { name: "root", dependencies: { lodash: "^4.17.21" } },
        "apps/web/package.json": { name: "web", dependencies: { lodash: "^4.17.21" } },
      },
      imports: { "apps/web/src/app.ts": ["lodash"] },
    });
    expect(usage(result, "apps/web", "lodash").usedBy).toEqual(["apps/web/src/app.ts"]);
    expect(report(result, ".").unused).toEqual(["lodash"]);
  });

  it("counts a whole-word case-sensitive text mention as usage", () => {
    const result = analyze({
      files: { "package.json": { name: "root", dependencies: { zod: "^3.23.0", ky: "^1.2.0" } } },
      text: {
        "docs/api.md": "input parsing uses zod schemas",
        "docs/astro.md": "zodiac signs and ZOD are not matches",
        "docs/sky.md": "the sky is blue",
      },
    });
    expect(usage(result, ".", "zod").textHits).toEqual(["docs/api.md"]);
    expect(report(result, ".").unused).toEqual(["ky"]);
  });

  it("does not credit a package for mentions of its hyphenated sibling (lodash vs lodash-es)", () => {
    const result = analyze({
      files: {
        "package.json": {
          name: "root",
          dependencies: { lodash: "^4.17.21", "lodash-es": "^4.17.21" },
        },
      },
      imports: { "src/app.ts": ["lodash-es"] },
      text: { "docs/notes.md": "we import lodash-es everywhere" },
    });
    expect(usage(result, ".", "lodash-es").textHits).toEqual(["docs/notes.md"]);
    expect(usage(result, ".", "lodash").textHits).toEqual([]);
    expect(report(result, ".").unused).toEqual(["lodash"]);
  });

  it("still counts subpath mentions like lodash/fp for the base package", () => {
    const result = analyze({
      files: { "package.json": { name: "root", dependencies: { lodash: "^4.17.21" } } },
      text: { "docs/fp.md": "prefer lodash/fp for composition" },
    });
    expect(usage(result, ".", "lodash").textHits).toEqual(["docs/fp.md"]);
    expect(report(result, ".").unused).toEqual([]);
  });

  it("caps recorded text hits at five files", () => {
    const text: Record<string, string> = {};
    for (let i = 1; i <= 7; i += 1) text[`docs/${i}.md`] = "mentions zod";
    const result = analyze({
      files: { "package.json": { name: "root", dependencies: { zod: "^3.23.0" } } },
      text,
    });
    expect(usage(result, ".", "zod").textHits).toEqual([
      "docs/1.md",
      "docs/2.md",
      "docs/3.md",
      "docs/4.md",
      "docs/5.md",
    ]);
  });

  it("matches scoped package names in text files despite the @ prefix", () => {
    const result = analyze({
      files: { "package.json": { name: "root", devDependencies: { "@acme/tokens": "^2.0.0" } } },
      text: { "tailwind.config.js": 'module.exports = { presets: [require("@acme/tokens")] }' },
    });
    expect(usage(result, ".", "@acme/tokens").textHits).toEqual(["tailwind.config.js"]);
    expect(report(result, ".").unused).toEqual([]);
  });

  it("pairs @types packages with their used base package, mangled scopes included", () => {
    const result = analyze({
      files: {
        "package.json": {
          name: "root",
          dependencies: { "@babel/core": "^7.24.0" },
          devDependencies: { "@types/babel__core": "^7.20.0" },
        },
      },
      imports: { "src/build.ts": ["@babel/core"] },
    });
    expect(usage(result, ".", "@types/babel__core").implicitReason).toBe(
      "types for used package @babel/core",
    );
    expect(report(result, ".").unused).toEqual([]);
  });

  it("always keeps @types/node and @types for Node builtins", () => {
    const result = analyze({
      files: {
        "package.json": {
          name: "root",
          devDependencies: { "@types/assert": "^1.5.0", "@types/node": "^26.0.0" },
        },
      },
    });
    expect(usage(result, ".", "@types/node").implicitReason).toBe("types for the Node.js runtime");
    expect(usage(result, ".", "@types/assert").implicitReason).toBe(
      'types for Node.js builtin "assert"',
    );
  });

  it("flags @types packages whose base package is unused", () => {
    const result = analyze({
      files: { "package.json": { name: "root", devDependencies: { "@types/express": "^4.17.0" } } },
    });
    expect(report(result, ".").unused).toEqual(["@types/express"]);
  });

  it("rescues CLI-only deps whose bin name appears in package scripts", () => {
    const result = analyze({
      files: {
        "package.json": {
          name: "root",
          scripts: { build: "tsc -p .", release: "changeset publish" },
          devDependencies: {
            typescript: "^5.5.0",
            "@changesets/cli": "^2.27.0",
            prisma: "^5.15.0",
          },
        },
      },
    });
    expect(usage(result, ".", "typescript").implicitReason).toBe(
      'bin "tsc" appears in package.json scripts',
    );
    expect(usage(result, ".", "@changesets/cli").implicitReason).toBe(
      'bin "changeset" appears in package.json scripts',
    );
    expect(report(result, ".").unused).toEqual(["prisma"]);
  });

  it("does not leak script evidence from a sibling manifest", () => {
    const result = analyze({
      files: {
        "package.json": { name: "root", devDependencies: { turbo: "^2.0.0" } },
        "apps/web/package.json": { name: "web", scripts: { dev: "turbo dev" } },
      },
    });
    expect(usage(result, ".", "turbo").implicitReason).toBeNull();
    expect(report(result, ".").unused).toEqual(["turbo"]);
  });

  it("resolves eslint config shorthand for plain and scoped configs", () => {
    const result = analyze({
      files: {
        "package.json": {
          name: "root",
          devDependencies: { "eslint-config-airbnb": "^19.0.0", "@acme/eslint-config": "^1.0.0" },
        },
      },
      text: { ".eslintrc.json": '{ "extends": ["airbnb", "@acme"] }' },
    });
    expect(usage(result, ".", "eslint-config-airbnb").implicitReason).toBe(
      'eslint config .eslintrc.json references "airbnb"',
    );
    expect(usage(result, ".", "@acme/eslint-config").implicitReason).toBe(
      'eslint config .eslintrc.json references "@acme"',
    );
  });

  it("ignores shorthand tokens mentioned outside config files", () => {
    const result = analyze({
      files: {
        "package.json": { name: "root", devDependencies: { "eslint-config-airbnb": "^19.0.0" } },
      },
      text: { "README.md": "we loosely follow the airbnb style" },
    });
    expect(report(result, ".").unused).toEqual(["eslint-config-airbnb"]);
  });

  it("resolves babel preset shorthand inside babel configs", () => {
    const result = analyze({
      files: {
        "package.json": { name: "root", devDependencies: { "babel-preset-solid": "^1.8.0" } },
      },
      text: { ".babelrc": '{ "presets": ["solid"] }' },
    });
    expect(usage(result, ".", "babel-preset-solid").implicitReason).toBe(
      'babel config .babelrc references "solid"',
    );
  });

  it("keeps prettier plugins only while a prettier config exists", () => {
    const files = {
      "package.json": { name: "root", devDependencies: { "prettier-plugin-tailwindcss": "^0.6.0" } },
    };
    const withConfig = analyze({ files, text: { ".prettierrc": "{}" } });
    expect(usage(withConfig, ".", "prettier-plugin-tailwindcss").implicitReason).toBe(
      "prettier plugin and config .prettierrc are package-scoped",
    );
    const withoutConfig = analyze({ files });
    expect(report(withoutConfig, ".").unused).toEqual(["prettier-plugin-tailwindcss"]);
  });

  it("treats react as used when the manifest owns .jsx/.tsx modules (automatic JSX runtime)", () => {
    const result = analyze({
      files: { "package.json": { name: "root", dependencies: { react: "^18.3.1" } } },
      imports: { "src/App.tsx": ["./util.ts"] },
    });
    expect(usage(result, ".", "react").implicitReason).toBe("JSX runtime");
    expect(report(result, ".").unused).toEqual([]);
  });

  it("scopes the JSX-runtime rule to the manifest owning the jsx files", () => {
    const result = analyze({
      files: {
        "package.json": { name: "root", dependencies: { react: "^18.3.1" } },
        "apps/web/package.json": { name: "web", dependencies: { react: "^18.3.1" } },
      },
      imports: { "apps/web/src/App.jsx": [] },
    });
    expect(usage(result, "apps/web", "react").implicitReason).toBe("JSX runtime");
    expect(usage(result, ".", "react").implicitReason).toBeNull();
    expect(report(result, ".").unused).toEqual(["react"]);
  });

  it("does not treat workspace-looking declarations as used without graph evidence", () => {
    const result = analyze({
      files: {
        "package.json": {
          name: "root",
          dependencies: { "@acme/ui": "workspace:*", "@acme/utils": "^1.0.0" },
        },
      },
      workspaceNames: ["@acme/utils"],
    });
    expect(usage(result, ".", "@acme/ui").implicitReason).toBeNull();
    expect(usage(result, ".", "@acme/utils").implicitReason).toBeNull();
    expect(report(result, ".").unused).toEqual(["@acme/ui", "@acme/utils"]);
  });

  it("reports imported-but-undeclared packages, hoisted ones with their source", () => {
    const result = analyze({
      files: {
        "package.json": { name: "root", dependencies: { lodash: "^4.17.21" } },
        "packages/api/package.json": { name: "api" },
      },
      imports: { "packages/api/src/index.ts": ["lodash", "left-pad", "node:fs", "./local.ts"] },
    });
    expect(report(result, "packages/api").missing).toMatchObject([
      { name: "left-pad", importers: ["packages/api/src/index.ts"], declaredIn: null, kind: "external" },
      { name: "lodash", importers: ["packages/api/src/index.ts"], declaredIn: ".", kind: "external" },
    ]);
  });

  it("resolves hoisting evidence to the nearest declaring ancestor", () => {
    const result = analyze({
      files: {
        "package.json": { name: "root", dependencies: { chalk: "^5.3.0" } },
        "packages/mid/package.json": { name: "mid", dependencies: { chalk: "^4.1.2" } },
        "packages/mid/leaf/package.json": { name: "leaf" },
      },
      imports: { "packages/mid/leaf/src/run.ts": ["chalk"] },
    });
    expect(report(result, "packages/mid/leaf").missing).toMatchObject([
      { name: "chalk", importers: ["packages/mid/leaf/src/run.ts"], declaredIn: "packages/mid", kind: "external" },
    ]);
  });

  it("reports undeclared workspace imports as missing internal declarations", () => {
    const result = analyze({
      files: { "package.json": { name: "root" } },
      imports: { "src/app.ts": ["@acme/ui"] },
      workspaceNames: ["@acme/ui"],
    });
    expect(report(result, ".").missing).toMatchObject([
      { name: "@acme/ui", kind: "workspace", suggestedRange: "workspace:*" },
    ]);
  });

  it("reports deps declared in both dependencies and devDependencies", () => {
    const result = analyze({
      files: {
        "package.json": {
          name: "root",
          dependencies: { react: "^18.3.1" },
          devDependencies: { react: "^18.3.1" },
        },
      },
      imports: { "src/app.tsx": ["react"] },
    });
    expect(report(result, ".").dualDeclared).toEqual(["react"]);
  });

  it("reports version skew across workspace manifests with every declaring dir", () => {
    const result = analyze({
      files: {
        "package.json": {
          name: "root",
          dependencies: { react: "^18.2.0", typescript: "^5.5.0" },
        },
        "apps/web/package.json": {
          name: "web",
          dependencies: { react: "^18.3.1", typescript: "^5.5.0" },
        },
      },
    });
    expect(result.workspaceSkew).toEqual([
      { name: "react", ranges: { ".": "^18.2.0", "apps/web": "^18.3.1" }, projectRoot: "." },
    ]);
  });

  it("produces identical output regardless of input ordering", () => {
    const files = {
      "package.json": { name: "root", dependencies: { lodash: "^4.17.21", react: "^18.2.0" } },
      "apps/web/package.json": { name: "web", dependencies: { react: "^18.3.1" } },
    };
    const imports = {
      "apps/web/src/a.ts": ["react", "lodash"],
      "src/index.ts": ["lodash"],
    };
    const text = { "docs/a.md": "react notes", "docs/b.md": "lodash notes" };
    const forward = analyze({ files, imports, text });
    const backward = analyzeDeps({
      manifests: [...manifestsOf(files)].reverse(),
      importsByFile: new Map(Object.entries(imports).reverse()),
      textFiles: Object.entries(text)
        .map(([path, content]) => ({ path, content }))
        .reverse(),
      workspacePkgNames: new Set(),
    });
    expect(backward).toEqual(forward);
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
  });
});
