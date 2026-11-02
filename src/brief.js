/**
 * Lattice — resident brief (host half, M2).
 *
 * The prompt section should not dump the library into every request. It
 * selects a handful of entries that are actually applicable to the *current
 * agent's workspace* (dimension affinity), ranks them by confidence/status/
 * freshness, and renders a terse index the model can use to decide what to
 * `lattice_get` — all within a token budget.
 *
 * Dimension-agnostic entries (generic knowledge) are kept; entries that
 * mismatch the workspace dimensions are excluded from the resident brief (they
 * remain reachable through `lattice_search`, where they are flagged
 * `applicable=false` as cross-version references).
 */
import { dimensionAffinity, freshness, STATUS_WEIGHTS } from "./search.js";

const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/** Cheap token estimate: CJK characters count 1, Latin roughly 4 chars/token. */
export function estimateTokens(text) {
  let cjk = 0;
  let latin = 0;
  for (const char of String(text == null ? "" : text)) {
    if (CJK_CHAR.test(char)) cjk += 1;
    else latin += 1;
  }
  return cjk + Math.ceil(latin / 4);
}

/** Compact dimension rendering: `mcver=1.20.1, loader=forge` (first `limit`). */
export function shortDims(dims, limit = 3) {
  const parts = Object.entries(dims || {})
    .slice(0, limit)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("|") : value}`);
  return parts.join(", ");
}

/** One line per resident entry: id, title, feature, kind/status, dims. */
export function renderResidentLine(entry) {
  const dims = shortDims(entry.dims);
  const meta = [entry.feature, `${entry.kind}/${entry.status}`];
  if (entry.verified_on !== "") meta.push(`verified ${entry.verified_on}`);
  if (dims !== "") meta.push(dims);
  return `- [${entry.id}] ${entry.title} (${meta.join("; ")})`;
}

/**
 * Rank the entries that may live in the prompt section.
 * @returns {Array<{entry: object, score: number, dimensions: object}>}
 */
export function selectResident(entries, options = {}) {
  const {
    dims = {},
    topK = 8,
    perFeature = 2,
    now = Date.now(),
    halfLifeDays = 180,
  } = options;
  const candidates = [];
  for (const entry of entries || []) {
    const affinity = dimensionAffinity(entry.dims, dims, "prefer");
    if (!affinity.applicable) continue;
    const statusWeight = STATUS_WEIGHTS[entry.status] || 0.5;
    const score = affinity.factor * statusWeight * freshness(entry, now, halfLifeDays);
    candidates.push({ entry, score, dimensions: affinity });
  }
  candidates.sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id));
  const selected = [];
  const used = new Map();
  for (const candidate of candidates) {
    const count = used.get(candidate.entry.feature) || 0;
    if (count >= perFeature) continue;
    used.set(candidate.entry.feature, count + 1);
    selected.push(candidate);
    if (selected.length >= Math.max(1, Math.min(50, Number(topK) || 8))) break;
  }
  return selected;
}

/**
 * Build the resident index text for the prompt section.
 * @returns {{text: string, count: number, applicable: number, total: number, tokens: number}}
 */
export function buildBrief(entries, options = {}) {
  const {
    dims = {},
    topK = 8,
    maxTokens = 1500,
    halfLifeDays = 180,
    now = Date.now(),
    overlayCount = 0,
  } = options;
  const total = (entries || []).length;
  const workspaceDims = shortDims(dims);
  const headerParts = [`Lattice shared memory: ${total} entr${total === 1 ? "y" : "ies"} in the library`];
  headerParts.push(workspaceDims === "" ? "workspace dimensions: not detected" : `workspace dimensions: ${workspaceDims}`);
  if (overlayCount > 0) headerParts.push(`${overlayCount} project-overlay entr${overlayCount === 1 ? "y" : "ies"}`);
  const header = `${headerParts.join("; ")}.`;
  const footer =
    "Call lattice_search for keyword lookups, lattice_get(id) for an entry's full text, lattice_gaps to see which dimensions lack knowledge. Only applicable entries are listed above; entries from other versions appear in search results with applicable=false.";

  const selected = selectResident(entries, { dims, topK, now, halfLifeDays });
  const lines = [];
  let tokens = estimateTokens(header) + estimateTokens(footer);
  for (const candidate of selected) {
    const line = renderResidentLine(candidate.entry);
    const cost = estimateTokens(line);
    if (tokens + cost > maxTokens) break;
    lines.push(line);
    tokens += cost;
  }

  const body = [];
  if (lines.length > 0) {
    body.push("Applicable memories for this workspace (auto-selected, highest confidence first):", ...lines);
  } else if (total > 0) {
    body.push(
      "No applicable memory for this workspace's dimensions — treat this as a coverage gap; call lattice_gaps to see what is missing, and do not reuse cross-version knowledge blindly.",
    );
  } else {
    body.push(`The library has no entries yet; record the first one after verifying it. Entries live in <library>/entries.`);
  }
  body.push(footer);
  const text = [header, ...body].join("\n");
  return { text, count: lines.length, applicable: selected.length, total, tokens: estimateTokens(text) };
}
