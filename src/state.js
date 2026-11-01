/**
 * Lattice — plugin state (host half).
 *
 * Two locations must not be confused:
 *   - plugin state dir: `<DSH_HOME>/lattice/` — root.json (which library this
 *     DSH installation uses), caches and migrations live here;
 *   - library root:     the folder the user picks on first run — entries/,
 *     projects.json and the `.lattice-root.json` marker live here, and the
 *     folder is meant to be kept in git and shared across workspaces.
 *
 * DSH_HOME mirrors how DSH itself resolves its home directory (`~/.dsh`
 * unless the launcher overrides it).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MARKER_FILE = ".lattice-root.json";
export const ENTRIES_DIR = "entries";
export const PROJECTS_FILE = "projects.json";

/** DSH home directory (same fallback as the rest of DSH: `~/.dsh`). */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv && fromEnv.trim() !== "" ? path.resolve(fromEnv) : path.join(os.homedir(), ".dsh");
}

/** Plugin state directory (not the library). */
export function stateDir() {
  return path.join(dshHome(), "lattice");
}

/** `<state>/root.json` — remembers the library root chosen on first run. */
export function rootFile() {
  return path.join(stateDir(), "root.json");
}

/** Default library root offered by the first-run card ("使用默认位置"). */
export function defaultRoot() {
  return path.join(dshHome(), "lattice-library");
}

/** Read a JSON object; `null` on any failure (missing, torn, not an object). */
export function safeReadJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch (err) {
    return null;
  }
}

/** Atomic JSON write (tmp file + rename) so a crash never leaves a torn file. */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

/** The stored library root, if `root.json` holds a usable path. */
export function readStoredRoot() {
  const stored = safeReadJson(rootFile());
  if (!stored || typeof stored.root !== "string" || stored.root.trim() === "") {
    return { root: null, source: null, updatedAt: null };
  }
  return {
    root: path.resolve(stored.root),
    source: typeof stored.source === "string" ? stored.source : "stored",
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null,
  };
}

/** Persist the chosen library root into the plugin state dir. */
export function persistRoot(root, source) {
  writeJson(rootFile(), { root, source, updatedAt: new Date().toISOString() });
}

/**
 * Validate a user-supplied library root.
 * Accepts `~`, quoted paths, and relative paths (resolved against the host
 * process cwd). A missing directory is valid — it will be created; an
 * existing non-directory is not.
 * @returns {{ok: true, root: string, exists: boolean} | {ok: false, code: string, message: string}}
 */
export function validateRoot(candidate) {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    return { ok: false, code: "missing-path", message: "the library root path is empty" };
  }
  let raw = candidate.trim().replace(/^"(.*)"$/, "$1");
  if (raw === "~") raw = os.homedir();
  else if (raw.startsWith("~/") || raw.startsWith("~\\")) raw = path.join(os.homedir(), raw.slice(2));
  if (raw.trim() === "") {
    return { ok: false, code: "missing-path", message: "the library root path is empty" };
  }
  const root = path.resolve(process.cwd(), raw);
  let stats = null;
  try {
    stats = fs.statSync(root);
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: true, root, exists: false };
    return { ok: false, code: "unreadable", message: `cannot access ${root}: ${(err && err.message) || err}` };
  }
  if (!stats.isDirectory()) {
    return { ok: false, code: "not-directory", message: `${root} is not a directory` };
  }
  return { ok: true, root, exists: true };
}

/**
 * Inspect a folder without modifying it: is it already a Lattice library,
 * is it an unrelated non-empty folder, and how many entries does it hold.
 */
export function inspectLibraryRoot(root) {
  const snapshot = { root, exists: false, nonEmpty: false, isLibrary: false, entries: 0 };
  try {
    snapshot.exists = fs.statSync(root).isDirectory();
  } catch (err) {
    return snapshot;
  }
  snapshot.isLibrary = safeReadJson(path.join(root, MARKER_FILE)) !== null;
  try {
    snapshot.nonEmpty = fs.readdirSync(root).length > 0;
  } catch (err) {
    /* unreadable folder keeps nonEmpty=false; ensureLibraryRoot will surface the error */
  }
  try {
    snapshot.entries = fs
      .readdirSync(path.join(root, ENTRIES_DIR))
      .filter((name) => name.endsWith(".md"))
      .length;
  } catch (err) {
    /* no entries/ yet */
  }
  return snapshot;
}

/**
 * Initialize the library layout inside `root` (idempotent, never deletes):
 * `entries/`, `projects.json`, and the `.lattice-root.json` marker that lets
 * the next run tell "an existing Lattice library" from "an unrelated folder".
 */
export function ensureLibraryRoot(root) {
  const entriesDir = path.join(root, ENTRIES_DIR);
  fs.mkdirSync(entriesDir, { recursive: true });
  const markerPath = path.join(root, MARKER_FILE);
  if (!fs.existsSync(markerPath)) {
    writeJson(markerPath, { schema: 1, name: "lattice", createdAt: new Date().toISOString() });
  }
  const projectsPath = path.join(root, PROJECTS_FILE);
  if (!fs.existsSync(projectsPath)) {
    writeJson(projectsPath, { projects: {} });
  }
  // Writable probe: surfaces a read-only folder as a clear error now, not at
  // the first record attempt.
  const probe = path.join(root, `.lattice-write-probe-${process.pid}`);
  fs.writeFileSync(probe, "ok", "utf8");
  fs.rmSync(probe, { force: true });
  return { root, markerPath, entriesDir, projectsPath };
}
