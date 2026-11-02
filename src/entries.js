/**
 * Lattice — entry model (host half).
 *
 * One entry = one Markdown file in `<library>/entries/<id>.md`. The YAML
 * frontmatter is the machine-readable part (retrieval, matrix, verification),
 * the body is the human-readable knowledge (steps, code, gotchas).
 *
 * M1 scope: model, validation, scan/read/write, stable serialization.
 * Writing goes through `saveEntry`, which refuses to overwrite an entry whose
 * content differs unless `overwrite` is set — drafts never silently clobber
 * verified knowledge.
 */
import fs from "node:fs";
import path from "node:path";
import { parseDocument, serializeDocument } from "./frontmatter.js";

export const ENTRIES_DIR = "entries";

export const ENTRY_KINDS = ["contract", "decision", "gotcha", "port", "checklist", "reference", "note"];
export const ENTRY_STATUSES = ["draft", "verified", "stale", "deprecated", "superseded"];
export const CONFIDENCE_LEVELS = ["low", "medium", "high"];

const ENTRY_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function text(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function textList(value) {
  if (Array.isArray(value)) return value.map(text).filter((item) => item !== "");
  if (typeof value === "string" && value.trim() !== "") return [value.trim()];
  return [];
}

export function isEntryId(value) {
  return typeof value === "string" && ENTRY_ID.test(value);
}

/** Slugify a title into a valid entry id (used by callers that omit an id). */
export function slugify(value) {
  const ascii = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return ascii === "" ? "entry" : ascii;
}

function normalizeDims(value) {
  const dims = {};
  if (value && typeof value === "object") {
    for (const [key, raw] of Object.entries(value)) {
      const name = text(key);
      if (name === "") continue;
      const values = textList(raw).filter((item) => item !== "*");
      if (values.length > 0) dims[name] = values.length === 1 ? values[0] : values;
      else if (raw === "*") dims[name] = "*";
    }
  }
  return dims;
}

/** Convert parsed frontmatter + body into a typed entry object. */
export function normalizeEntry(data, body, file) {
  const source = data && typeof data === "object" ? data : {};
  const applies = source.applies_when && typeof source.applies_when === "object" ? source.applies_when : {};
  return {
    id: text(source.id),
    kind: text(source.kind).toLowerCase(),
    title: text(source.title),
    summary: text(source.summary),
    feature: text(source.feature),
    tags: textList(source.tags),
    dims: normalizeDims(source.dims),
    status: text(source.status).toLowerCase(),
    confidence: text(source.confidence).toLowerCase(),
    verified_on: text(source.verified_on),
    evidence: textList(source.evidence),
    supersedes: textList(source.supersedes),
    related: textList(source.related),
    applies_when: {
      files: textList(applies.files),
      symbols: textList(applies.symbols),
    },
    created: text(source.created),
    updated: text(source.updated),
    body: String(body == null ? "" : body),
    file: typeof file === "string" ? file : null,
  };
}

/** Human-readable validation problems; an empty array means the entry is valid. */
export function validateEntry(entry) {
  const problems = [];
  if (!isEntryId(entry.id)) problems.push("id must match /^[a-z0-9][a-z0-9._-]*$/ and be at most 80 characters");
  if (entry.title === "") problems.push("title is required");
  if (entry.kind === "") problems.push(`kind is required (${ENTRY_KINDS.join(", ")})`);
  else if (!ENTRY_KINDS.includes(entry.kind)) problems.push(`unknown kind "${entry.kind}" (expected one of ${ENTRY_KINDS.join(", ")})`);
  if (entry.feature === "") problems.push("feature is required (the capability this entry is about)");
  if (entry.status === "") problems.push(`status is required (${ENTRY_STATUSES.join(", ")})`);
  else if (!ENTRY_STATUSES.includes(entry.status)) problems.push(`unknown status "${entry.status}" (expected one of ${ENTRY_STATUSES.join(", ")})`);
  if (entry.confidence !== "" && !CONFIDENCE_LEVELS.includes(entry.confidence)) {
    problems.push(`unknown confidence "${entry.confidence}" (expected one of ${CONFIDENCE_LEVELS.join(", ")})`);
  }
  if (entry.verified_on !== "" && !DATE.test(entry.verified_on)) problems.push("verified_on must be YYYY-MM-DD");
  for (const [dim, raw] of Object.entries(entry.dims)) {
    if (typeof raw !== "string" && !Array.isArray(raw)) problems.push(`dims.${dim} must be a string, a list or "*"`);
  }
  return problems;
}

/** Build the frontmatter object in a stable field order. */
function frontmatterOf(entry) {
  const data = {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
  };
  if (entry.summary !== "") data.summary = entry.summary;
  data.feature = entry.feature;
  if (entry.tags.length > 0) data.tags = entry.tags;
  data.dims = entry.dims;
  data.status = entry.status;
  if (entry.confidence !== "") data.confidence = entry.confidence;
  if (entry.verified_on !== "") data.verified_on = entry.verified_on;
  if (entry.evidence.length > 0) data.evidence = entry.evidence;
  if (entry.supersedes.length > 0) data.supersedes = entry.supersedes;
  if (entry.related.length > 0) data.related = entry.related;
  const applies = {};
  if (entry.applies_when.files.length > 0) applies.files = entry.applies_when.files;
  if (entry.applies_when.symbols.length > 0) applies.symbols = entry.applies_when.symbols;
  if (Object.keys(applies).length > 0) data.applies_when = applies;
  const stamp = new Date().toISOString();
  data.created = entry.created === "" ? stamp : entry.created;
  data.updated = stamp;
  return data;
}

/** Serialize an entry back into Markdown with YAML frontmatter. */
export function serializeEntry(entry) {
  const body = entry.body.trim() === "" ? `# ${entry.title}\n` : entry.body;
  return serializeDocument(frontmatterOf(entry), body);
}

export function entriesDir(root) {
  return path.join(root, ENTRIES_DIR);
}

export function entryFile(root, id) {
  return path.join(entriesDir(root), `${id}.md`);
}

const loadCache = new Map();

/** Drop every cached entries listing (used after bulk deletes). */
export function clearEntriesCache() {
  loadCache.clear();
}

/**
 * Cheap fingerprint of an entries directory: number of Markdown files, newest
 * mtime and newest size. Edits change the mtime, so the cache invalidates
 * itself without any write hook (M4).
 */
function dirFingerprint(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".md"));
  } catch (err) {
    return null;
  }
  let newest = 0;
  let largest = 0;
  for (const name of names) {
    try {
      const stat = fs.statSync(path.join(dir, name));
      newest = Math.max(newest, stat.mtimeMs);
      largest = Math.max(largest, stat.size);
    } catch (err) {
      // The file vanished between readdir and stat; the next call picks it up.
    }
  }
  return `${names.length}:${newest}:${largest}`;
}

/**
 * Read every valid entry of an explicit entries directory.
 * Results are memoized: the resident inject counts on being cheap to call on
 * every turn, while edits to the Markdown files still show up immediately.
 * @returns {{entries: object[], problems: {file: string, message: string}[]}}
 */
export function loadEntriesFromDir(dir) {
  const fingerprint = dirFingerprint(dir);
  if (fingerprint === null) return { entries: [], problems: [] };
  const cached = loadCache.get(dir);
  if (cached && cached.fingerprint === fingerprint) return cached.result;
  const entries = [];
  const problems = [];
  let names = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".md"))
      .sort();
  } catch (err) {
    return { entries, problems };
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const parsed = parseDocument(fs.readFileSync(file, "utf8"));
      const entry = normalizeEntry(parsed.data, parsed.body, file);
      if (entry.id === "") entry.id = name.replace(/\.md$/i, "");
      const issues = validateEntry(entry);
      if (issues.length > 0) {
        problems.push({ file, message: issues.join("; ") });
        continue;
      }
      entries.push(entry);
    } catch (err) {
      problems.push({ file, message: `cannot read entry: ${(err && err.message) || err}` });
    }
  }
  const result = { entries, problems };
  loadCache.set(dir, { fingerprint, result });
  return result;
}

/** Read every valid entry of a library (its `entries/` directory). */
export function loadEntries(root) {
  return loadEntriesFromDir(entriesDir(root));
}

/**
 * Read a library plus an optional per-project overlay: entries of the overlay
 * win by id, everything else is merged. Used by the M2 read paths when
 * `projectOverlay` is on and the workspace has a `<workspace>/.lattice` folder.
 * @returns {{entries: object[], problems: object[], overlay: number}}
 */
export function loadEntriesMerged(root, overlayRoot) {
  const shared = loadEntries(root);
  if (!overlayRoot) return { entries: shared.entries, problems: shared.problems, overlay: 0 };
  const overlay = loadEntries(overlayRoot);
  if (overlay.entries.length === 0) {
    return {
      entries: shared.entries,
      problems: [...shared.problems, ...overlay.problems],
      overlay: 0,
    };
  }
  const byId = new Map();
  for (const entry of shared.entries) byId.set(entry.id, entry);
  for (const entry of overlay.entries) byId.set(entry.id, entry);
  return {
    entries: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)),
    problems: [...shared.problems, ...overlay.problems],
    overlay: overlay.entries.length,
  };
}

/** Read one entry, preferring the project overlay over the shared library. */
export function getEntryMerged(root, overlayRoot, id) {
  const fromOverlay = overlayRoot ? getEntry(overlayRoot, id) : null;
  return fromOverlay === null ? getEntry(root, id) : fromOverlay;
}

/** Load the library and index it by id. */
export function loadEntryMap(root) {
  const loaded = loadEntries(root);
  const byId = new Map();
  for (const entry of loaded.entries) byId.set(entry.id, entry);
  return { entries: loaded.entries, byId, problems: loaded.problems };
}

export function getEntry(root, id) {
  if (!isEntryId(id)) return null;
  const file = entryFile(root, id);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = parseDocument(fs.readFileSync(file, "utf8"));
    const entry = normalizeEntry(parsed.data, parsed.body, file);
    if (entry.id === "") entry.id = id;
    return entry;
  } catch (err) {
    return null;
  }
}

/**
 * Write an entry file.
 * @returns {{ok: true, file: string, created: boolean} | {ok: false, code: string, message: string}}
 */
export function saveEntry(root, entry, options = {}) {
  const overwrite = options.overwrite === true;
  const problems = validateEntry(entry);
  if (problems.length > 0) return { ok: false, code: "invalid-entry", message: problems.join("; ") };
  const file = entryFile(root, entry.id);
  const exists = fs.existsSync(file);
  if (exists && !overwrite) {
    return { ok: false, code: "already-exists", message: `${entry.id} already exists at ${file}; pass overwrite=true to replace it` };
  }
  try {
    fs.mkdirSync(entriesDir(root), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, serializeEntry(entry), "utf8");
    fs.renameSync(temporary, file);
  } catch (err) {
    return { ok: false, code: "write-failed", message: `cannot write ${file}: ${(err && err.message) || err}` };
  }
  return { ok: true, file, created: !exists };
}
