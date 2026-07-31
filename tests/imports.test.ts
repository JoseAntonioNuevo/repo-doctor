import { describe, expect, it } from "vitest";
import { extractImports, isModuleFile } from "../scripts/lib/imports.ts";

describe("isModuleFile", () => {
  it("accepts all eight JS/TS module extensions", () => {
    for (const ext of ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"]) {
      expect(isModuleFile(`src/deep/file.${ext}`), ext).toBe(true);
    }
  });

  it("rejects non-module and extensionless files", () => {
    for (const path of ["a.json", "style.css", "README.md", "Makefile", ".gitignore", "img.svg"]) {
      expect(isModuleFile(path), path).toBe(false);
    }
  });

  it("treats declaration files as modules and ignores extension case", () => {
    expect(isModuleFile("types/global.d.ts")).toBe(true);
    expect(isModuleFile("legacy/OLD.JS")).toBe(true);
  });
});

describe("extractImports", () => {
  it("extracts static, side-effect, and export-from specifiers sorted and deduped", () => {
    const source = `
import a from "./b.ts";
import { c, d } from "pkg";
import * as e from '../up.ts';
import "./side-effect.ts";
export { x } from "./b.ts";
export * from "@scope/lib";
`;
    const out = extractImports(source);
    expect(out.specifiers).toEqual(["../up.ts", "./b.ts", "./side-effect.ts", "@scope/lib", "pkg"]);
    expect(out.hasDynamicNonLiteral).toBe(false);
  });

  it("supports multi-line and type-only import clauses", () => {
    const source = 'import {\n  a,\n  b,\n} from "./multi.ts";\nimport type { T } from "./types-only.ts";';
    expect(extractImports(source).specifiers).toEqual(["./multi.ts", "./types-only.ts"]);
  });

  it("ignores commented-out imports", () => {
    const source = [
      '// import dead from "./line-dead.ts";',
      "/*",
      'import blockDead from "./block-dead.ts";',
      "*/",
      'import real from "./real.ts";',
    ].join("\n");
    expect(extractImports(source).specifiers).toEqual(["./real.ts"]);
  });

  it("does not treat comment markers inside string literals as comments", () => {
    // A naive stripper blanks the rest of the URL line (and the glob's `/*`),
    // swallowing the import that follows.
    const source =
      'const url = "https://example.com/x"; const glob = `src/**/*.ts ${x}`;\n' +
      'import real from "./real.ts";';
    expect(extractImports(source).specifiers).toEqual(["./real.ts"]);
  });

  it("extracts require and require.resolve call specifiers", () => {
    const source = 'const a = require("./a.cjs");\nconst bin = require.resolve("pkg/bin");';
    const out = extractImports(source);
    expect(out.specifiers).toEqual(["./a.cjs", "pkg/bin"]);
    expect(out.hasDynamicNonLiteral).toBe(false);
  });

  it("extracts literal dynamic imports without flagging dynamism", () => {
    const source =
      'const lazy = await import("./lazy.ts");\n' +
      'import("./with-options.ts", { with: { type: "json" } });';
    const out = extractImports(source);
    expect(out.specifiers).toEqual(["./lazy.ts", "./with-options.ts"]);
    expect(out.hasDynamicNonLiteral).toBe(false);
  });

  it("accepts an interpolation-free template literal argument as a literal import", () => {
    const out = extractImports("const m = await import(`./static.ts`);");
    expect(out.specifiers).toEqual(["./static.ts"]);
    expect(out.hasDynamicNonLiteral).toBe(false);
  });

  it("flags non-literal dynamic import() and require() without inventing specifiers", () => {
    const source =
      "const m = await import(`./plugins/${name}.ts`);\n" +
      "const r = require(path.join(dir, leaf));";
    const out = extractImports(source);
    expect(out.specifiers).toEqual([]);
    expect(out.hasDynamicNonLiteral).toBe(true);
  });

  it("reads triple-slash reference paths even though they live in comments", () => {
    const source =
      '/// <reference path="./globals.d.ts" />\n/// <reference types="node" />\nexport {};';
    expect(extractImports(source).specifiers).toEqual(["./globals.d.ts"]);
  });

  it("does not extract phantom specifiers from keyword strings in code", () => {
    // Reviewer scenario (a): scan.ts's own source produced a phantom ", "
    // specifier because the extraction regexes matched inside string contents.
    const source = 'for (const key of ["import", "require", "default"]) {\n  visit(key);\n}';
    const out = extractImports(source);
    expect(out.specifiers).toEqual([]);
    expect(out.hasDynamicNonLiteral).toBe(false);
  });

  it("does not invent a missing dep from prose inside a string literal", () => {
    // Reviewer scenario (b): the word "import" followed by a quoted name inside
    // an error message produced a phantom missing dep.
    const source = "const msg = \"failed to import 'left-pad' - is it installed?\";";
    const out = extractImports(source);
    expect(out.specifiers).toEqual([]);
    expect(out.hasDynamicNonLiteral).toBe(false);
  });

  it("ignores import/require/reference statements inside a codegen template literal", () => {
    // Reviewer scenario (c): a template literal containing generated module
    // source produced phantom unresolved specifiers.
    const source = [
      "const tpl = `",
      'import phantom from "phantom-pkg";',
      'export * from "./phantom.ts";',
      '/// <reference path="./phantom.d.ts" />',
      'const p = require("phantom-req");',
      'await import("phantom-dyn");',
      "`;",
      'import real from "./real.ts";',
    ].join("\n");
    const out = extractImports(source);
    expect(out.specifiers).toEqual(["./real.ts"]);
    expect(out.hasDynamicNonLiteral).toBe(false);
  });

  it("handles escaped quotes inside strings without leaking their contents", () => {
    const source =
      'const s = "say \\"import phantom from \'pkg\'\\" ok"; const t = require("./real.cjs");';
    const out = extractImports(source);
    expect(out.specifiers).toEqual(["./real.cjs"]);
    expect(out.hasDynamicNonLiteral).toBe(false);
  });

  it("still extracts a real import inside a template interpolation", () => {
    const source = "const html = `<b>${await import(\"./widget.ts\")}</b>`;";
    const out = extractImports(source);
    expect(out.specifiers).toEqual(["./widget.ts"]);
    expect(out.hasDynamicNonLiteral).toBe(false);
  });

  it("extracts script-block imports from an SFC source without matching markup text", () => {
    const source = [
      "<template>",
      "  <p>Learn how to import components and use them.</p>",
      '  <button :title="labels.importLabel">Do the import now</button>',
      "</template>",
      "",
      '<script setup lang="ts">',
      'import { ref } from "vue";',
      'import Widget from "./Widget.vue";',
      'const version = "1.0";',
      "</script>",
      "",
      "<style scoped>",
      ".import-note { color: red; }",
      "</style>",
    ].join("\n");
    const out = extractImports(source);
    expect(out.specifiers).toEqual(["./Widget.vue", "vue"]);
    expect(out.hasDynamicNonLiteral).toBe(false);
  });
});
