/**
 * Lattice backup (M8).
 *
 * A backup is a plain directory snapshot of the shared library: every
 * `entries/*.md`, `projects.json` and `.lattice-root.json`, plus a small
 * `manifest.json`. Keeping it as loose files means users can read, diff and
 * restore a backup by hand — no archive format to learn.
 *
 * Default location: `<library root>/backups` — backups live next to the memory
 * library they snapshot, so moving or copying the library directory carries its
 * backups along. Before setup (no library root yet) the fallback is
 * `$DSH_HOME/lattice/backups`. Users can point `backup.dir` at any absolute
 * path (or a path relative to the plugin root) from the panel or
 * `cordis.patch.yml`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "./state.js";

export const BACKUP_SCHEMA = "lattice-backup/1";
export const DEFAULT_KEEP = 10;
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The real directory behind the installed plugin package. With a `link:`
 * install this resolves to the project checkout; informational only, it is not
 * used as the backup default anymore.
 */
export function pluginPackageDir() {
  const home = path.dirname(stateDir());
  try {
    for (const name of fs.readdirSync(path.join(home, "profiles"))) {
      try {
        return fs.realpathSync(path.join(home, "profiles", name, "node_modules", "dsh-lattice-memory"));
      } catch (err) {
        /* try the next profile */
      }
    }
  } catch (err) {
    /* no profiles directory */
  }
  return PLUGIN_ROOT;
}

/** `<library root>/backups`, or `$DSH_HOME/lattice/backups` before setup. */
export function defaultBackupDir(root) {
  const base = typeof root === "string" ? root.trim() : "";
  return base === "" ? path.join(stateDir(), "backups") : path.join(base, "backups");
}

/** Resolve a user-supplied directory; relative paths hang off the plugin root. */
export function resolveBackupDir(value, root) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return defaultBackupDir(root);
  const expanded = raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")
    ? path.join(process.env.USERPROFILE || process.env.HOME || "", raw.replace(/^~[\\/]?/, ""))
    : raw;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(PLUGIN_ROOT, expanded);
}

/** Turn a user-supplied label into a filesystem-safe name segment. */
export function sanitizeLabel(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return "";
  const cleaned = raw
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return cleaned.slice(0, 40);
}

function pad(value, width) {
  return String(value).padStart(width, "0");
}

/** `lattice-YYYYMMDD-HHmmss` in local time. */
export function backupStamp(date = new Date()) {
  return [
    "lattice-",
    `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}`,
    "-",
    `${pad(date.getHours(), 2)}${pad(date.getMinutes(), 2)}${pad(date.getSeconds(), 2)}`,
  ].join("");
}

function readManifest(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    return null;
  }
}

/** Newest-first listing of the backups in a directory. */
export function listBackups(backupDir) {
  let names;
  try {
    names = fs.readdirSync(backupDir, { withFileTypes: true });
  } catch (error) {
    return [];
  }
  const rows = [];
  for (const dirent of names) {
    if (!dirent.isDirectory() || !/^lattice-\d{8}-\d{6}(?:-\d+)?(?:-.+)?$/.test(dirent.name)) continue;
    const dir = path.join(backupDir, dirent.name);
    const manifest = readManifest(dir);
    let stat = null;
    try {
      stat = fs.statSync(dir);
    } catch (error) {
      stat = null;
    }
    const label = manifest && typeof manifest.label === "string" && manifest.label !== ""
      ? manifest.label
      : dirent.name.replace(/^lattice-\d{8}-\d{6}(?:-\d+)?(?:-)?/, "");
    rows.push({
      name: dirent.name,
      label,
      dir,
      createdAt: manifest && typeof manifest.createdAt === "string" ? manifest.createdAt : stat ? stat.mtime.toISOString() : "",
      entryCount: manifest && typeof manifest.entryCount === "number" ? manifest.entryCount : null,
    });
  }
  rows.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return rows;
}

/** Keep the newest `keep` backups; returns the names that were deleted. */
export function pruneBackups(backupDir, keep = DEFAULT_KEEP) {
  const limit = Number.isFinite(keep) && keep >= 0 ? Math.floor(keep) : DEFAULT_KEEP;
  const rows = listBackups(backupDir);
  const removed = [];
  for (const row of rows.slice(limit)) {
    try {
      fs.rmSync(row.dir, { recursive: true, force: true });
      removed.push(row.name);
    } catch (error) {
      // Best effort: a locked directory stays until the next prune.
    }
  }
  return removed;
}

/**
 * Snapshot the library into `<backupDir>/lattice-<stamp>[-<label>]/`.
 * Returns `{ ok, dir, name, label, count, pruned, createdAt }` or throws with a
 * readable message (missing root, unwritable target, ...).
 */
export function createBackup({ root, backupDir, keep = DEFAULT_KEEP, name = "", now = new Date() }) {
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error("createBackup: the library root is not configured");
  }
  const entriesSrc = path.join(root, "entries");
  let names = [];
  try {
    names = fs.readdirSync(entriesSrc).filter((file) => file.toLowerCase().endsWith(".md"));
  } catch (error) {
    names = [];
  }

  const target = backupDir;
  fs.mkdirSync(target, { recursive: true });

  const label = sanitizeLabel(name);
  const base = label === "" ? backupStamp(now) : `${backupStamp(now)}-${label}`;
  let finalName = base;
  let suffix = 1;
  let finalDir = path.join(target, finalName);
  while (fs.existsSync(finalDir)) {
    suffix += 1;
    finalName = `${base}-${suffix}`;
    finalDir = path.join(target, finalName);
  }
  fs.mkdirSync(finalDir, { recursive: true });

  const entriesOut = path.join(finalDir, "entries");
  fs.mkdirSync(entriesOut, { recursive: true });
  for (const name of names) {
    fs.copyFileSync(path.join(entriesSrc, name), path.join(entriesOut, name));
  }
  for (const file of ["projects.json", ".lattice-root.json"]) {
    const source = path.join(root, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(finalDir, file));
  }

  const manifest = {
    schema: BACKUP_SCHEMA,
    createdAt: new Date(now.getTime()).toISOString(),
    sourceRoot: root,
    label,
    entryCount: names.length,
    entries: names.map((name) => name.replace(/\.md$/i, "")).sort(),
  };
  fs.writeFileSync(path.join(finalDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const pruned = pruneBackups(target, keep);
  return { ok: true, dir: finalDir, name: finalName, label, count: names.length, pruned, createdAt: manifest.createdAt };
}

/**
 * Copy one backup back over the library. Existing entries with the same file
 * name are overwritten; entries created after the backup are left untouched
 * (restore is additive-by-file, never a delete). Returns the counts.
 */
export function restoreBackup({ root, backupDir, name }) {
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error("restoreBackup: the library root is not configured");
  }
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("restoreBackup: pick a backup to restore");
  }
  const row = listBackups(backupDir).find((item) => item.name === name);
  if (!row) throw new Error(`restoreBackup: backup "${name}" was not found in ${backupDir}`);

  const entriesDir = path.join(root, "entries");
  fs.mkdirSync(entriesDir, { recursive: true });
  let restored = 0;
  let sourceEntries = [];
  try {
    sourceEntries = fs.readdirSync(path.join(row.dir, "entries")).filter((file) => file.toLowerCase().endsWith(".md"));
  } catch (error) {
    sourceEntries = [];
  }
  for (const file of sourceEntries) {
    fs.copyFileSync(path.join(row.dir, "entries", file), path.join(entriesDir, file));
    restored += 1;
  }
  let restoredMeta = 0;
  for (const file of ["projects.json", ".lattice-root.json"]) {
    const source = path.join(row.dir, file);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(root, file));
      restoredMeta += 1;
    }
  }
  return {
    ok: true,
    backup: row.name,
    label: row.label,
    entryCount: row.entryCount,
    restored,
    restoredMeta,
    backupCreatedAt: row.createdAt,
  };
}
