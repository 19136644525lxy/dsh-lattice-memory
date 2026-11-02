/**
 * Lattice — matrix and gap analysis (host half, M2).
 *
 * The matrix answers "which versions/environments does this feature actually
 * have knowledge for?" — one row per feature, one cell per dimension
 * signature. The gap analysis answers the complementary question: "this
 * workspace's dimensions are not covered by any entry for that feature".
 *
 * Both are pure functions over loaded entries so they can be tested without a
 * filesystem and reused by the tools, the prompt section and future UIs.
 */
import { dimensionAffinity } from "./search.js";

/** Preferred dimension order for columns; unknown keys keep their own order. */
export const DIM_KEY_ORDER = [
  "game",
  "mcver",
  "loader",
  "host",
  "platform",
  "runtime",
  "sdk",
  "product",
  "branch",
];

/** Status strength, used to pick the "best" cell status in a matrix row. */
const STATUS_RANK = {
  verified: 5,
  draft: 4,
  stale: 3,
  deprecated: 2,
  superseded: 1,
};

/** Display one dimension value (lists joined with `|`). */
export function displayValue(dims, key) {
  const value = dims ? dims[key] : undefined;
  if (value === undefined || value === null) return "";
  return Array.isArray(value) ? value.join("|") : String(value);
}

/** Stable cell signature: `mcver=1.20.1|loader=forge` (empty keys -> ""). */
export function signatureOf(dims, keys) {
  return (keys || [])
    .map((key) => `${key}=${displayValue(dims, key)}`)
    .filter((part) => !part.endsWith("="))
    .join("|");
}

/** The dimensions of one entry, limited to `keys` (missing keys dropped). */
export function pickDims(dims, keys) {
  const picked = {};
  for (const key of keys || []) {
    const value = dims ? dims[key] : undefined;
    if (value !== undefined && value !== null && displayValue(dims, key) !== "") picked[key] = value;
  }
  return picked;
}

/**
 * Choose the dimension keys a matrix is built from.
 * Explicit request wins; otherwise the most informative keys present in the
 * entries (known order first), capped so the table stays readable.
 */
export function chooseKeys(entries, requested, cap = 4) {
  const wanted = (Array.isArray(requested) ? requested : [])
    .map((key) => String(key).trim().toLowerCase())
    .filter((key) => key !== "");
  if (wanted.length > 0) return wanted;
  const seen = new Set();
  for (const entry of entries || []) {
    for (const key of Object.keys(entry.dims || {})) seen.add(key);
  }
  const known = DIM_KEY_ORDER.filter((key) => seen.has(key));
  const unknown = [...seen].filter((key) => !DIM_KEY_ORDER.includes(key)).sort();
  return [...known, ...unknown].slice(0, Math.max(1, cap));
}

/** Feature filter used by every M2 view: case-insensitive substring. */
export function scopeByFeature(entries, feature) {
  const needle = typeof feature === "string" ? feature.trim().toLowerCase() : "";
  if (needle === "") return entries || [];
  return (entries || []).filter((entry) => String(entry.feature || "").toLowerCase().includes(needle));
}

function betterStatus(left, right) {
  if (left === undefined) return right;
  return (STATUS_RANK[right] || 0) > (STATUS_RANK[left] || 0) ? right : left;
}

/**
 * Build a feature × dimension-signature matrix.
 * @returns {{keys: string[], features: number, total_entries: number,
 *   rows: Array<{feature: string, entries: number, cells: Array<{signature: string,
 *     dims: object, count: number, best_status: string, ids: string[]}>}>}}
 */
export function buildMatrix(entries, options = {}) {
  const scope = scopeByFeature(entries, options.feature);
  const keys = chooseKeys(scope.length > 0 ? scope : entries, options.keys);
  const groups = new Map();
  for (const entry of scope) {
    const feature = String(entry.feature || "(no feature)");
    if (!groups.has(feature)) groups.set(feature, []);
    groups.get(feature).push(entry);
  }
  const rows = [];
  for (const [feature, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const cells = new Map();
    for (const entry of group) {
      const signature = signatureOf(entry.dims, keys) || "(no dims)";
      const cell = cells.get(signature) || {
        signature,
        dims: signature === "(no dims)" ? {} : pickDims(entry.dims, keys),
        count: 0,
        best_status: undefined,
        ids: [],
      };
      cell.count += 1;
      cell.ids.push(entry.id);
      cell.best_status = betterStatus(cell.best_status, entry.status);
      cells.set(signature, cell);
    }
    rows.push({
      feature,
      entries: group.length,
      cells: [...cells.values()].sort((a, b) => a.signature.localeCompare(b.signature)),
    });
  }
  return { keys, features: rows.length, total_entries: scope.length, rows };
}

/**
 * Find features with no entry applicable to `dims` (the workspace's dimensions),
 * plus the dimension signatures they do cover — the actionable "missing cell"
 * list behind the matrix.
 * @returns {{dims: object, features: number, covered: number,
 *   gaps: Array<{feature: string, entries: number, ids: string[], covered: string[]}>}}
 */
export function findGaps(entries, options = {}) {
  const dims = options.dims && typeof options.dims === "object" ? options.dims : {};
  const scope = scopeByFeature(entries, options.feature);
  const keys = chooseKeys(scope.length > 0 ? scope : entries, options.keys);
  const groups = new Map();
  for (const entry of scope) {
    const feature = String(entry.feature || "(no feature)");
    if (!groups.has(feature)) groups.set(feature, []);
    groups.get(feature).push(entry);
  }
  const gaps = [];
  let covered = 0;
  for (const [feature, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const applicable = group.filter((entry) => dimensionAffinity(entry.dims, dims, "prefer").applicable);
    if (applicable.length > 0) {
      covered += 1;
      continue;
    }
    const signatures = [...new Set(group.map((entry) => signatureOf(entry.dims, keys) || "(no dims)"))].sort();
    gaps.push({
      feature,
      entries: group.length,
      ids: group.map((entry) => entry.id),
      covered: signatures,
    });
  }
  return { dims, features: groups.size, covered, gaps };
}
