/**
 * Lattice — minimal YAML frontmatter codec (host half).
 *
 * The plugin must run with zero build steps and zero runtime dependencies,
 * so this is a deliberately small YAML subset rather than a full parser:
 *
 *   - mappings (`key: value`) and one level of nesting (`key:` + indented map);
 *   - inline arrays (`tags: [a, b]`) and block arrays (`- item` lines);
 *   - scalars: strings (plain, "double", 'single'), numbers, booleans, null.
 *
 * It is exactly the subset the entry schema writes, and anything it cannot
 * represent (anchors, multi-document, flow maps) is treated as an opaque
 * string, which keeps hand-edited entries safe instead of losing data.
 */

/** Split an inline flow array body on top-level commas, respecting quotes. */
function splitFlow(body) {
  const parts = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote !== null) {
      current += ch;
      if (ch === quote && body[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/** Parse one YAML scalar. Unknown shapes stay strings. */
export function parseScalar(raw) {
  const value = String(raw).trim();
  if (value === "") return "";
  if (value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitFlow(value.slice(1, -1)).map(parseScalar);
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value);
    } catch (err) {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** Index of the `:` that separates a mapping key from its value. */
function keyColon(text) {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === ":") {
      const next = text[i + 1];
      if (next === undefined || next === " " || next === "\t") return i;
    }
  }
  return -1;
}

function nextContentLine(state) {
  for (let index = state.i; index < state.lines.length; index += 1) {
    const raw = state.lines[index];
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    return { index, indent: raw.length - raw.trimStart().length, text: trimmed };
  }
  return null;
}

function parseMapping(state, parentIndent) {
  const map = {};
  while (state.i < state.lines.length) {
    const raw = state.lines[state.i];
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      state.i += 1;
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    if (indent <= parentIndent) break;
    if (trimmed.startsWith("- ")) {
      state.i += 1;
      continue;
    }
    const colon = keyColon(trimmed);
    if (colon === -1) {
      state.i += 1;
      continue;
    }
    const key = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();
    state.i += 1;
    if (rest !== "") {
      map[key] = parseScalar(rest);
      continue;
    }
    const peek = nextContentLine(state);
    if (peek !== null && peek.indent > indent && peek.text.startsWith("- ")) {
      map[key] = parseArray(state, indent);
    } else if (peek !== null && peek.indent > indent) {
      map[key] = parseMapping(state, indent);
    } else {
      map[key] = null;
    }
  }
  return map;
}

function parseArray(state, parentIndent) {
  const items = [];
  while (state.i < state.lines.length) {
    const raw = state.lines[state.i];
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      state.i += 1;
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    if (indent <= parentIndent) break;
    if (!trimmed.startsWith("- ")) break;
    const rest = trimmed.slice(2).trim();
    state.i += 1;
    if (rest === "") {
      const peek = nextContentLine(state);
      if (peek !== null && peek.indent > indent) items.push(parseMapping(state, indent));
      else items.push(null);
      continue;
    }
    const colon = keyColon(rest);
    if (colon > 0 && !rest.startsWith("[") && !rest.startsWith('"') && !rest.startsWith("'")) {
      // `- key: value` starts a mapping item; the remaining keys are indented under it.
      const item = {};
      item[rest.slice(0, colon).trim()] = parseScalar(rest.slice(colon + 1).trim());
      const peek = nextContentLine(state);
      if (peek !== null && peek.indent > indent) {
        Object.assign(item, parseMapping(state, indent));
      }
      items.push(item);
      continue;
    }
    items.push(parseScalar(rest));
  }
  return items;
}

/** Parse a frontmatter block (the text between the two `---` lines). */
export function parseYaml(text) {
  const lines = String(text).split(/\r?\n/);
  const state = { lines, i: 0 };
  return parseMapping(state, -1);
}

/** Characters that force quoting in a scalar. */
const NEEDS_QUOTES = /[#:[\]{},"'|>&*!%@`]/;

function stringifyScalar(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value !== "string") return JSON.stringify(String(value));
  const text = value;
  const looksSpecial =
    text !== text.trim() ||
    NEEDS_QUOTES.test(text) ||
    text === "" ||
    /^(true|false|null|~|-?\d+(\.\d+)?)$/.test(text) ||
    text.startsWith("- ");
  return looksSpecial ? JSON.stringify(text) : text;
}

/** Serialize a mapping back into YAML (deterministic key order = insertion order). */
export function stringifyYaml(data, indent = 0) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined) continue;
    if (value === null) {
      lines.push(`${pad}${key}: null`);
      continue;
    }
    if (Array.isArray(value)) {
      lines.push(`${pad}${key}: [${value.map(stringifyScalar).join(", ")}]`);
      continue;
    }
    if (typeof value === "object") {
      const nested = stringifyYaml(value, indent + 2);
      if (nested === "") {
        lines.push(`${pad}${key}: {}`);
        continue;
      }
      lines.push(`${pad}${key}:`);
      lines.push(nested);
      continue;
    }
    lines.push(`${pad}${key}: ${stringifyScalar(value)}`);
  }
  return lines.join("\n");
}

/**
 * Split a Markdown document into frontmatter text and body.
 * @returns {{frontmatter: string | null, body: string}}
 */
export function splitDocument(text) {
  const normalized = String(text).replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(normalized);
  if (match === null) return { frontmatter: null, body: normalized };
  return { frontmatter: match[1], body: normalized.slice(match[0].length) };
}

/** Parse a Markdown document into `{data, body}`. */
export function parseDocument(text) {
  const parts = splitDocument(text);
  const data = parts.frontmatter === null ? {} : parseYaml(parts.frontmatter);
  return { data: data || {}, body: parts.body };
}

/** Serialize `{data, body}` into a Markdown document with frontmatter. */
export function serializeDocument(data, body) {
  const yaml = stringifyYaml(data);
  const content = String(body == null ? "" : body).replace(/\s+$/, "");
  return `---\n${yaml}\n---\n\n${content}\n`;
}
