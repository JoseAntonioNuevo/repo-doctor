/**
 * Import extraction for JS/TS module sources — and, best-effort, SFC sources
 * (.vue/.svelte/.astro) whose <script> blocks contain plain JS/TS.
 *
 * All matching runs against a *scrubbed* copy of the source: a character-level
 * state machine blanks comments and replaces every string and template-literal
 * body with an indexed placeholder token (`\x00S<n>\x00`) that cannot occur in
 * real code. An `import`/`require` keyword inside a string can therefore never
 * produce a phantom specifier; when a match's specifier position is a
 * placeholder, the original string is recovered from the index. Regex literals
 * are not modeled — a quote inside one can blank the rest of its line, which
 * never hides a real import in practice and keeps the machine simple.
 */

const MODULE_EXTS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"]);

/** True when the file extension marks a parseable JS/TS module. */
export function isModuleFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return MODULE_EXTS.has(base.slice(dot + 1).toLowerCase());
}

// import d from "x", import { a } from "x", export * from "x", export { a } from "x".
// Quotes, backticks, semicolons, and parens are excluded between the keyword and
// `from` so a match can span a multi-line clause but never a statement boundary
// or a call expression. In scrubbed text every quoted span is a placeholder, so
// the specifier capture is always a whole placeholder token.
const FROM_CLAUSE_RE = /(?<![\w$.])(?:import|export)\b[^"'`;()]*?\bfrom\s*(["'])([^"'\n]+)\1/g;
const SIDE_EFFECT_RE = /(?<![\w$.])import\s*(["'])([^"'\n]+)\1/g;
const CALL_HEAD_RE = /(?<![\w$.])(?:import|require(?:\s*\.\s*resolve)?)\s*\(\s*/g;
const QUOTED_ARG_RE = /^(["'])([^"'\n]*)\1\s*[,)]/;
const TEMPLATE_ARG_RE = /^`([^`$\n]*)`\s*[,)]/;
const REFERENCE_RE = /^\s*\/\/\/\s*<reference\s+path\s*=\s*(["'])([^"'\n]+)\1/;
const PLACEHOLDER_RE = /\x00S(\d+)\x00/g;

interface ScrubbedSource {
  /** Source with comments blanked and every string body replaced by `\x00S<n>\x00`. */
  code: string;
  /** Placeholder index -> raw string body (escape sequences kept verbatim). */
  values: string[];
  /** Paths from real `/// <reference path="…" />` line comments at line starts. */
  referencePaths: string[];
}

/**
 * One pass over the source. Comments are blanked (newlines preserved) so
 * commented-out imports never match; string and template-literal bodies become
 * indexed placeholders so their contents never look like code. Template
 * interpolations keep their `${…}` code — recursively scrubbed — which both
 * lets real imports inside interpolations match and marks the template itself
 * as non-literal for dynamic-import classification. A string left unterminated
 * at a newline (malformed code, or a JSX/markup apostrophe) is blanked to the
 * end of the line so prose can never leak into the code stream.
 */
function scrubSource(source: string): ScrubbedSource {
  const out: string[] = [];
  const values: string[] = [];
  const referencePaths: string[] = [];
  let i = 0;

  const placeholder = (body: string): string => {
    values.push(body);
    return `\x00S${values.length - 1}\x00`;
  };

  const scanString = (quote: string): void => {
    // i is at the opening quote.
    let body = "";
    let j = i + 1;
    while (j < source.length) {
      const ch = source[j];
      if (ch === "\\") {
        body += source.slice(j, j + 2);
        j += 2;
      } else if (ch === quote) {
        out.push(quote + placeholder(body) + quote);
        i = j + 1;
        return;
      } else if (ch === "\n") {
        break;
      } else {
        body += ch;
        j += 1;
      }
    }
    // Unterminated (newline or EOF): blank the whole span, no dangling quote.
    out.push(" ");
    i = j;
  };

  const scanTemplate = (): void => {
    // i is at the opening backtick.
    out.push("`");
    i += 1;
    let chunk = "";
    const flush = (): void => {
      if (chunk.length > 0) out.push(placeholder(chunk));
      chunk = "";
    };
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\") {
        chunk += source.slice(i, i + 2);
        i += 2;
      } else if (ch === "`") {
        flush();
        out.push("`");
        i += 1;
        return;
      } else if (ch === "$" && source[i + 1] === "{") {
        flush();
        out.push("${");
        i += 2;
        scanCode(true);
        if (source[i] === "}") {
          out.push("}");
          i += 1;
        }
      } else {
        chunk += ch;
        i += 1;
      }
    }
    flush(); // unterminated template at EOF
  };

  const scanCode = (insideInterpolation: boolean): void => {
    // One brace counter per call so nested `${…}` interpolations unwind correctly.
    let braceDepth = 0;
    while (i < source.length) {
      const ch = source[i];
      const next = source[i + 1];
      if (ch === "/" && next === "/") {
        // Reference directives live inside line comments — read them here,
        // where real comment context is known, so a directive-shaped line
        // inside a string or template can never register.
        const lineStart = source.lastIndexOf("\n", i - 1) + 1;
        let lineEnd = source.indexOf("\n", i);
        if (lineEnd === -1) lineEnd = source.length;
        const ref = REFERENCE_RE.exec(source.slice(lineStart, lineEnd));
        if (ref) referencePaths.push(ref[2]);
        out.push(" ");
        i = lineEnd; // the newline itself is emitted as ordinary code
      } else if (ch === "/" && next === "*") {
        out.push(" ");
        i += 2;
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
          if (source[i] === "\n") out.push("\n");
          i += 1;
        }
        if (i < source.length) i += 2;
      } else if (ch === "'" || ch === '"') {
        scanString(ch);
      } else if (ch === "`") {
        scanTemplate();
      } else if (insideInterpolation && ch === "{") {
        braceDepth += 1;
        out.push(ch);
        i += 1;
      } else if (insideInterpolation && ch === "}") {
        if (braceDepth === 0) return; // caller consumes the closing brace
        braceDepth -= 1;
        out.push(ch);
        i += 1;
      } else {
        out.push(ch);
        i += 1;
      }
    }
  };

  scanCode(false);
  return { code: out.join(""), values, referencePaths };
}

/**
 * Pull every import specifier out of one module source: static imports,
 * side-effect imports, export-from, require()/require.resolve(), dynamic
 * import() with a literal argument, and `/// <reference path="…" />`
 * directives. Deduped and sorted — source order is meaningless downstream.
 *
 * import()/require() whose first argument is anything other than one whole
 * string literal (or an interpolation-free template literal) sets
 * hasDynamicNonLiteral — the module graph cannot see through it, so orphan
 * confidence must drop.
 */
export function extractImports(source: string): {
  specifiers: string[];
  hasDynamicNonLiteral: boolean;
} {
  const { code, values, referencePaths } = scrubSource(source);
  const specifiers = new Set<string>(referencePaths);
  let hasDynamicNonLiteral = false;

  const recover = (text: string): string =>
    text.replace(PLACEHOLDER_RE, (_m, n: string) => values[Number(n)] ?? "");

  for (const re of [FROM_CLAUSE_RE, SIDE_EFFECT_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      const spec = recover(m[2]);
      if (spec.length > 0) specifiers.add(spec);
    }
  }

  CALL_HEAD_RE.lastIndex = 0;
  for (let m = CALL_HEAD_RE.exec(code); m !== null; m = CALL_HEAD_RE.exec(code)) {
    const arg = code.slice(m.index + m[0].length);
    const quoted = QUOTED_ARG_RE.exec(arg);
    const template = quoted ? null : TEMPLATE_ARG_RE.exec(arg);
    const raw = quoted?.[2] ?? template?.[1];
    if (raw != null) {
      const spec = recover(raw);
      if (spec.length > 0) specifiers.add(spec);
    } else {
      hasDynamicNonLiteral = true;
    }
  }

  return { specifiers: [...specifiers].sort(), hasDynamicNonLiteral };
}
