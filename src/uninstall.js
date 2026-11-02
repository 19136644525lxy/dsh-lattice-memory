/**
 * Lattice uninstall (M9).
 *
 * DSH's own plugin removal drops the bundle reference, but a `link:` install
 * plus manual `cordis.patch.yml` edits leave config behind. This module plans
 * and performs a *complete* cleanup:
 *
 *   - the `- id: lattice` row (with its `config:`) in the profile patch;
 *   - `dsh-lattice-memory` in the profile's `package.json`
 *     (`dependencies` / `dsh.profile.bundles`);
 *   - `node_modules/dsh-lattice-memory` — only the link/entry itself;
 *   - `<DSH_HOME>/lattice` state (root.json, boot.log, captures.json,
 *     background.bin, backups fallback …).
 *
 * The memory library (the user's data) is never touched.
 */
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./state.js";

const PACKAGE_NAME = "dsh-lattice-memory";

/** The profile that currently has this plugin, or "". */
export function findProfileDir() {
  const home = path.dirname(stateDir());
  const profiles = path.join(home, "profiles");
  try {
    for (const name of fs.readdirSync(profiles)) {
      const dir = path.join(profiles, name);
      try {
        fs.lstatSync(path.join(dir, "node_modules", PACKAGE_NAME));
        return dir;
      } catch (error) {
        /* keep looking */
      }
    }
  } catch (error) {
    /* no profiles directory */
  }
  return "";
}

/** True when a patch row registers this plugin (either by row id or package name). */
export function hasLatticePatchRow(text) {
  return text.split(/\r?\n/).some(
    (line) => /^- id:\s*lattice\s*$/.test(line.trimEnd()) || /^- name:\s*dsh-lattice-memory\s*$/.test(line.trimEnd()),
  );
}

/**
 * Remove every top-level `- id: lattice` / `- name: dsh-lattice-memory` row
 * together with its indented body (`config:` etc.). Pure function: takes the
 * YAML text, returns the new text (trailing blank lines normalised).
 */
export function stripLatticePatchRows(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    const isItem = line.startsWith("- ");
    if (skipping && isItem) skipping = false;
    if (skipping) continue;
    const trimmed = line.trimEnd();
    if (/^- id:\s*lattice\s*$/.test(trimmed) || /^- name:\s*dsh-lattice-memory\s*$/.test(trimmed)) {
      skipping = true;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "\n");
}

/** Remove the plugin from package.json; returns which fields changed. */
export function stripPackageRefs(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    return { changed: false, text, error: `package.json is not valid JSON: ${error.message}` };
  }
  const changes = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (manifest[field] && Object.prototype.hasOwnProperty.call(manifest[field], PACKAGE_NAME)) {
      delete manifest[field][PACKAGE_NAME];
      changes.push(field);
    }
  }
  const bundles = manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)
    ? manifest.dsh.profile.bundles
    : null;
  if (bundles) {
    const next = bundles.filter((name) => name !== PACKAGE_NAME);
    if (next.length !== bundles.length) {
      manifest.dsh.profile.bundles = next;
      changes.push("dsh.profile.bundles");
    }
  }
  return {
    changed: changes.length > 0,
    text: `${JSON.stringify(manifest, null, 2)}\n`,
    changes,
  };
}

/** Describe what a full uninstall would remove. */
export function planUninstall() {
  const profileDir = findProfileDir();
  const patchPath = profileDir === "" ? "" : path.join(profileDir, "cordis.patch.yml");
  const packagePath = profileDir === "" ? "" : path.join(profileDir, "package.json");
  const modulePath = profileDir === "" ? "" : path.join(profileDir, "node_modules", PACKAGE_NAME);
  let patch = false;
  if (patchPath !== "") {
    try {
      patch = hasLatticePatchRow(fs.readFileSync(patchPath, "utf8"));
    } catch (error) {
      patch = false;
    }
  }
  let packageRefs = false;
  if (packagePath !== "") {
    try {
      packageRefs = stripPackageRefs(fs.readFileSync(packagePath, "utf8")).changed;
    } catch (error) {
      packageRefs = false;
    }
  }
  let moduleExists = false;
  let moduleLink = false;
  if (modulePath !== "") {
    try {
      const stat = fs.lstatSync(modulePath);
      moduleExists = true;
      moduleLink = stat.isSymbolicLink();
    } catch (error) {
      moduleExists = false;
    }
  }
  const state = stateDir();
  return {
    profileDir,
    patch,
    packageRefs,
    moduleExists,
    moduleLink,
    stateDir: state,
    stateExists: fs.existsSync(state),
    libraryRoot: "",
  };
}

/**
 * Perform the cleanup. The memory library is never deleted; only the plugin
 * installation and its per-plugin state are. Returns a list of removed items.
 */
export function performUninstall({ removeState = true } = {}) {
  const plan = planUninstall();
  const removed = [];
  const skipped = [];

  if (plan.profileDir !== "" && plan.patch) {
    const patchPath = path.join(plan.profileDir, "cordis.patch.yml");
    try {
      const original = fs.readFileSync(patchPath, "utf8");
      fs.writeFileSync(patchPath, stripLatticePatchRows(original), "utf8");
      removed.push("cordis.patch.yml: lattice row");
    } catch (error) {
      skipped.push(`cordis.patch.yml: ${error.message}`);
    }
  }

  if (plan.profileDir !== "" && plan.packageRefs) {
    const packagePath = path.join(plan.profileDir, "package.json");
    try {
      const original = fs.readFileSync(packagePath, "utf8");
      const cleaned = stripPackageRefs(original);
      if (cleaned.changed) {
        fs.writeFileSync(packagePath, cleaned.text, "utf8");
        removed.push(`package.json: ${cleaned.changes.join(", ")}`);
      }
    } catch (error) {
      skipped.push(`package.json: ${error.message}`);
    }
  }

  if (plan.moduleExists) {
    const modulePath = path.join(plan.profileDir, "node_modules", PACKAGE_NAME);
    try {
      if (plan.moduleLink) {
        fs.unlinkSync(modulePath);
        removed.push("node_modules/dsh-lattice-memory (link removed, target kept)");
      } else {
        fs.rmSync(modulePath, { recursive: true, force: true });
        removed.push("node_modules/dsh-lattice-memory");
      }
    } catch (error) {
      skipped.push(`node_modules: ${error.message}`);
    }
  }

  if (removeState && fs.existsSync(plan.stateDir)) {
    try {
      fs.rmSync(plan.stateDir, { recursive: true, force: true });
      removed.push(`state: ${plan.stateDir}`);
    } catch (error) {
      skipped.push(`state: ${error.message}`);
    }
  }

  return { ok: true, removed, skipped, plan };
}
