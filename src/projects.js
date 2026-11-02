/**
 * Lattice — `projects.json` overrides (M4).
 *
 * The library root may carry a `projects.json` that pins a workspace to
 * explicit dimensions (and optionally a preset), overriding what the metadata
 * detector guesses:
 *
 *   {
 *     "projects": {
 *       "F:\\src\\my-mod": { "preset": "minecraft-mod", "dims": { "mcver": "1.20.1", "loader": "forge" } },
 *       "other-repo":      { "dims": { "platform": "android" } }
 *     }
 *   }
 *
 * Absolute keys match the workspace itself or any folder below it (the longest
 * prefix wins); relative keys match one path segment or the folder name.
 * Matching is case-insensitive and accepts `/` or `\` separators (Windows).
 */
import path from "node:path";
import { PROJECTS_FILE, safeReadJson } from "./state.js";

/** Read the `projects` map of a library; `{}` when the file is missing or torn. */
export function readProjects(root) {
  const data = safeReadJson(path.join(root, PROJECTS_FILE));
  return data && data.projects && typeof data.projects === "object" ? data.projects : {};
}

/** Normalize a path for comparison: forward slashes, no trailing slash, lowercase. */
export function normalizePathKey(value) {
  return String(value == null ? "" : value)
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function isAbsoluteKey(key) {
  return /^[a-z]:\//.test(key) || key.startsWith("/");
}

/**
 * Match a workspace against the override map.
 * @returns {{key: string, preset: string, dims: object} | null}
 */
export function matchProject(projects, workspace) {
  if (!projects || typeof projects !== "object") return null;
  const target = normalizePathKey(workspace);
  if (target === "") return null;
  const segments = target.split("/");
  let best = null;
  for (const [rawKey, rawValue] of Object.entries(projects)) {
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) continue;
    const key = normalizePathKey(rawKey);
    if (key === "") continue;
    const absolute = isAbsoluteKey(key);
    let matched = false;
    let length = 0;
    if (absolute) {
      if (target === key || target.startsWith(`${key}/`)) {
        matched = true;
        length = key.length;
      }
    } else if (segments.includes(key)) {
      matched = true;
      length = key.length;
    }
    if (!matched) continue;
    if (best !== null && length <= best.length) continue;
    best = {
      key: rawKey,
      length,
      preset: typeof rawValue.preset === "string" ? rawValue.preset.trim().toLowerCase() : "",
      dims: rawValue.dims && typeof rawValue.dims === "object" && !Array.isArray(rawValue.dims) ? rawValue.dims : {},
    };
  }
  if (best === null) return null;
  return { key: best.key, preset: best.preset, dims: best.dims };
}
