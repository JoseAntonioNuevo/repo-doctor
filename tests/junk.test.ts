import { describe, expect, it } from "vitest";
import { findJunk } from "../scripts/lib/junk.ts";
import type { FileInfo, JunkCategory } from "../scripts/lib/types.ts";

function file(path: string, bytes = 100): FileInfo {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return {
    path,
    bytes,
    hash: `h-${path}`,
    ext: dot > 0 ? base.slice(dot + 1).toLowerCase() : "",
    symlink: false,
  };
}

function categoryOf(path: string): JunkCategory | undefined {
  return findJunk([file(path)])[0]?.category;
}

describe("junk categories", () => {
  it("flags files under build output directories at any depth", () => {
    for (const p of [
      "dist/index.js",
      "packages/app/build/main.js",
      ".next/server/page.js",
      "coverage/index.html",
      "node_modules/left-pad/index.js",
    ]) {
      expect(categoryOf(p), p).toBe("build-artifact");
    }
  });

  it("flags cache directories and the .eslintcache file", () => {
    for (const p of [".turbo/turbo-build.json", "packages/web/.cache/data.bin", ".eslintcache"]) {
      expect(categoryOf(p), p).toBe("cache");
    }
  });

  it("does not treat a file merely NAMED like a build/cache/editor directory as junk", () => {
    const clean = ["build", "tools/dist", "scripts/out", ".turbo", "conf/.vscode", "docs/coverage"];
    expect(findJunk(clean.map((p) => file(p)))).toEqual([]);
  });

  it("flags log files including rotated package-manager debug logs", () => {
    for (const p of ["server.log", "logs/yarn-error.log", "npm-debug.log.1234567890"]) {
      expect(categoryOf(p), p).toBe("log");
    }
  });

  it("flags OS and editor droppings", () => {
    for (const p of [
      "assets/.DS_Store",
      "photos/Thumbs.db",
      "desktop.ini",
      "src/.index.ts.swp",
      "notes.txt~",
      ".idea/workspace.xml",
      ".vscode/launch.json",
    ]) {
      expect(categoryOf(p), p).toBe("os-or-editor");
    }
  });

  it("flags backup-copy suffixes on the basename before its extension", () => {
    for (const p of ["src/utils-old.ts", "config_bak.json", "api.orig.ts", "README-backup"]) {
      expect(categoryOf(p), p).toBe("backup-copy");
    }
  });

  it("flags numbered-copy basenames and backup extensions", () => {
    for (const p of ["images/logo (1).png", "schema.sql.bak", "src/merge.rej", "app.ts.orig"]) {
      expect(categoryOf(p), p).toBe("backup-copy");
    }
  });

  it("does not flag names that merely contain a backup word", () => {
    const clean = ["src/gold.ts", "lib/backup-manager.ts", "lib/tmpdir.ts", "src/oldest.ts"];
    expect(findJunk(clean.map((p) => file(p)))).toEqual([]);
  });

  it("flags committed .env files", () => {
    for (const p of [".env", "apps/web/.env.local", ".env.production"]) {
      expect(categoryOf(p), p).toBe("sensitive");
    }
  });

  it("exempts the documented .env templates", () => {
    const templates = [".env.example", ".env.template", ".env.sample", ".env.test"];
    expect(findJunk(templates.map((p) => file(p)))).toEqual([]);
  });

  it("flags key material as sensitive", () => {
    for (const p of [
      "certs/server.pem",
      "secrets/private.key",
      "deploy/id_rsa",
      "keys/id_ed25519",
      "id_ed25519.pub",
      ".netrc",
    ]) {
      expect(categoryOf(p), p).toBe("sensitive");
    }
  });

  it("keeps backups of key material sensitive, never a deletable backup-copy", () => {
    for (const p of [
      "server.pem.bak",
      "certs/server.key.orig",
      "tls/cert.pem.old",
      "deploy/id_rsa.bak",
      ".env.bak",
      ".env.local.orig",
    ]) {
      expect(categoryOf(p), p).toBe("sensitive");
    }
  });

  it("does not mistake code or docs whose name merely contains key/pem for secrets", () => {
    const clean = ["src/keyboard.ts", "src/app.key.ts", "docs/monkey.pem.md", "lib/pemdas.ts"];
    expect(findJunk(clean.map((p) => file(p)))).toEqual([]);
  });

  it("flags archives and binaries by extension", () => {
    for (const p of ["release.zip", "data.tar", "vendor.tgz", "tools/setup.exe", "lib/parser.jar"]) {
      expect(categoryOf(p), p).toBe("binary-or-archive");
    }
  });

  it("flags minified files, bundles, and source maps as generated", () => {
    for (const p of [
      "public/app.min.js",
      "assets/styles.min.css",
      "static/vendor.bundle.js",
      "src/index.js.map",
    ]) {
      expect(categoryOf(p), p).toBe("generated");
    }
  });
});

describe("first matching category wins", () => {
  it("classifies a minified file inside dist/ as build-artifact, not generated", () => {
    expect(categoryOf("dist/app.min.js")).toBe("build-artifact");
  });

  it("classifies a log inside coverage/ as build-artifact, not log", () => {
    expect(categoryOf("coverage/lcov.log")).toBe("build-artifact");
  });

  it("classifies a log inside a cache directory as cache, not log", () => {
    expect(categoryOf(".cache/install.log")).toBe("cache");
  });

  it("classifies a .bak file inside .vscode/ as os-or-editor, not backup-copy", () => {
    expect(categoryOf(".vscode/settings.json.bak")).toBe("os-or-editor");
  });

  it("classifies a secret inside build output as sensitive — secrets outrank location", () => {
    expect(categoryOf("dist/.env")).toBe("sensitive");
    expect(categoryOf("coverage/server.pem")).toBe("sensitive");
  });

  it("classifies backups of secret files as sensitive — that rule precedes backup-copy", () => {
    expect(categoryOf("deploy/id_rsa.bak")).toBe("sensitive");
    expect(categoryOf(".env.bak")).toBe("sensitive");
    expect(categoryOf("server.pem.bak")).toBe("sensitive");
  });
});

describe("output shape", () => {
  it("leaves ordinary source and config files alone", () => {
    const clean = [
      "src/index.ts",
      "README.md",
      "package.json",
      "outputs/data.json",
      "distro/setup.ts",
    ];
    expect(findJunk(clean.map((p) => file(p)))).toEqual([]);
  });

  it("sorts findings by path", () => {
    const out = findJunk([file("z.log"), file("a.log"), file("m.log")]);
    expect(out.map((f) => f.path)).toEqual(["a.log", "m.log", "z.log"]);
  });

  it("reports each file once with its bytes and a named pattern", () => {
    const findings = findJunk([file("packages/app/dist/index.js", 4096)]);
    expect(findings).toHaveLength(1);
    expect(findings[0].bytes).toBe(4096);
    expect(findings[0].pattern).toContain("dist");
  });
});
