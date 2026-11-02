/**
 * Lattice — retrieval (host half, M1).
 *
 * Three things, in this order:
 *   1. tokenizer: Latin words split on punctuation/case changes, CJK runs cut
 *      into overlapping bigrams (works without a dictionary, and handles mixed
 *      Chinese/English queries such as "1.20.1 药水效果");
 *   2. BM25 over weighted fields (title/feature 3x, summary/tags 2x, body 1x);
 *   3. dimension affinity: an entry is "applicable" when the query dimensions
 *      (detected from the workspace) either match, are unspecified by the
 *      entry (generic knowledge), or mismatch (cross-version reference).
 *
 * No embeddings in M1 — the ranker is deterministic so results are reproducible
 * and debuggable. Semantic recall can be layered on later without changing the
 * entry format.
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const CJK_TEST = /[\u3400-\u4dbf\u4e00-\u9fff]/;

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "what", "how", "when", "where", "which", "does", "did", "are", "was", "were", "have", "has", "had", "not", "but", "can", "will", "would", "should", "could", "you", "your", "its", "our", "their", "them", "they", "each", "any", "all", "use", "using", "能", "的", "了", "和", "是", "在", "我", "你", "他", "它", "吗", "呢", "吧", "呀", "这", "那", "有", "不",
]);

/**
 * Tokenize text for BM25.
 * Latin: lowercase words, split camelCase / snake_case, keep 2+ chars.
 * CJK: overlapping bigrams; a single CJK character stays a unigram.
 */
export function tokenize(text) {
  const tokens = [];
  const segments = String(text == null ? "" : text).split(/([\u3400-\u4dbf\u4e00-\u9fff]+)/u);
  for (const segment of segments) {
    if (segment === "") continue;
    if (CJK_TEST.test(segment)) {
      const chars = Array.from(segment);
      if (chars.length === 1) tokens.push(chars[0]);
      for (let index = 0; index < chars.length - 1; index += 1) tokens.push(chars[index] + chars[index + 1]);
      continue;
    }
    for (const chunk of segment.split(/[^A-Za-z0-9_.]+/u)) {
      if (chunk === "" || chunk === ".") continue;
      const parts = chunk
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[_\s]+/)
        .filter(Boolean);
      for (const part of parts) {
        const word = part.toLowerCase().replace(/^\.+|\.+$/g, "");
        if (word.length >= 2 && !STOP_WORDS.has(word)) tokens.push(word);
      }
    }
  }
  return tokens;
}

/** Fields fed into BM25 and their weights (title/feature/tags dominate). */
function weightedFields(entry) {
  const dimsText = Object.entries(entry.dims)
    .map(([name, value]) => `${name} ${Array.isArray(value) ? value.join(" ") : value}`)
    .join(" ");
  return [
    { text: entry.title, weight: 3 },
    { text: entry.feature, weight: 3 },
    { text: entry.summary, weight: 2 },
    { text: entry.tags.join(" "), weight: 2 },
    { text: dimsText, weight: 2 },
    { text: [entry.kind, entry.status, entry.confidence].join(" "), weight: 1.5 },
    { text: entry.body, weight: 1 },
  ];
}

/** Pre-compute term frequencies per entry. */
export function buildIndex(entries) {
  const documents = [];
  let totalLength = 0;
  for (const entry of entries) {
    const frequency = new Map();
    let length = 0;
    for (const field of weightedFields(entry)) {
      for (const token of tokenize(field.text)) {
        frequency.set(token, (frequency.get(token) || 0) + field.weight);
        length += 1;
      }
    }
    documents.push({ entry, frequency, length });
    totalLength += length;
  }
  const documentFrequency = new Map();
  for (const document of documents) {
    for (const token of document.frequency.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }
  const count = documents.length;
  return {
    documents,
    documentFrequency,
    averageLength: count === 0 ? 1 : Math.max(1, totalLength / count),
    count,
  };
}

const K1 = 1.2;
const B = 0.75;

/** BM25 score for every document that shares at least one query token. */
export function scoreQuery(index, query) {
  const tokens = Array.from(new Set(tokenize(query)));
  if (tokens.length === 0 || index.count === 0) return [];
  const rows = [];
  for (const document of index.documents) {
    let score = 0;
    const matched = [];
    for (const token of tokens) {
      const frequency = document.frequency.get(token) || 0;
      if (frequency === 0) continue;
      matched.push(token);
      const df = index.documentFrequency.get(token) || 0;
      const idf = Math.log(1 + (index.count - df + 0.5) / (df + 0.5));
      const lengthNorm = 1 - B + (B * document.length) / index.averageLength;
      score += idf * ((frequency * (K1 + 1)) / (frequency + K1 * lengthNorm));
    }
    if (score > 0) rows.push({ entry: document.entry, bm25: score, matched });
  }
  return rows;
}

// ── Dimension matching ───────────────────────────────────────────────────

/** Split a version-ish string into comparable parts: numbers, words, dots. */
export function versionParts(value) {
  return String(value)
    .toLowerCase()
    .replace(/^v/, "")
    .split(/[^0-9a-z]+/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

/** -1 / 0 / 1, comparing numeric segments numerically and words lexically. */
export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

function satisfy(value, operator, target) {
  const order = compareVersions(value, target);
  if (operator === ">") return order > 0;
  if (operator === ">=") return order >= 0;
  if (operator === "<") return order < 0;
  if (operator === "<=") return order <= 0;
  return order === 0;
}

/**
 * Does one entry dimension value satisfy one query value?
 * Query forms: exact ("1.20.1"), wildcard ("1.20.x"), range (">=1.21 <1.22"),
 * "*" (any), or a list of these.
 */
export function matchDimensionValue(entryValue, queryValue) {
  if (Array.isArray(entryValue)) return entryValue.some((item) => matchDimensionValue(item, queryValue));
  const entryText = String(entryValue == null ? "" : entryValue).trim();
  const queryText = String(queryValue == null ? "" : queryValue).trim();
  if (queryText === "" || queryText === "*") return true;
  if (entryText === "") return false;
  if (entryText === "*") return true;
  if (/x/i.test(queryText) && !/[<>]/.test(queryText)) {
    const prefix = queryText.replace(/x/gi, "").trim().toLowerCase();
    return prefix === "" ? true : entryText.toLowerCase().startsWith(prefix);
  }
  const range = /^((?:<=|>=|<|>)\s*[0-9A-Za-z._-]+)(?:\s+((?:<=|>=|<|>)\s*[0-9A-Za-z._-]+))?$/.exec(queryText);
  if (range !== null) {
    const clauses = range[0].split(/\s+/).filter(Boolean);
    return clauses.every((clause) => {
      const match = /^(>=|<=|>|<)\s*([0-9A-Za-z._-]+)$/.exec(clause);
      return match === null ? true : satisfy(entryText, match[1], match[2]);
    });
  }
  return entryText.toLowerCase() === queryText.toLowerCase();
}

/**
 * How well an entry's dims fit the query dims.
 * @param {object} entryDims
 * @param {object} queryDims   dimension name -> value | value[]
 * @param {"strict"|"prefer"} mode  strict excludes mismatches, prefer downweights them
 * @returns {{factor: number, applicable: boolean, matched: number, checked: number, notes: string[]}}
 */
export function dimensionAffinity(entryDims, queryDims, mode = "prefer") {
  const keys = Object.keys(queryDims || {}).filter((key) => {
    const value = queryDims[key];
    return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0) && String(value).trim() !== "";
  });
  if (keys.length === 0) return { factor: 1, applicable: true, matched: 0, checked: 0, notes: [] };
  const notes = [];
  let matched = 0;
  let checked = 0;
  let applicable = true;
  for (const key of keys) {
    const raw = queryDims[key];
    const queries = Array.isArray(raw) ? raw : [raw];
    const entryRaw = entryDims ? entryDims[key] : undefined;
    checked += 1;
    if (entryRaw === undefined) {
      notes.push(`${key}: unspecified by the entry (generic knowledge)`);
      continue;
    }
    const entryValues = Array.isArray(entryRaw) ? entryRaw : [entryRaw];
    const hit = queries.some((query) => entryValues.some((value) => matchDimensionValue(value, query)));
    if (hit) {
      matched += 1;
      continue;
    }
    applicable = false;
    notes.push(`${key}: ${entryValues.join("|")} does not match ${queries.join("|")}`);
  }
  if (!applicable && mode === "strict") return { factor: 0, applicable: false, matched, checked, notes };
  const fit = checked === 0 ? 1 : matched / checked;
  const factor = applicable ? 0.55 + 0.45 * fit : 0.4;
  return { factor, applicable, matched, checked, notes };
}

const STATUS_WEIGHTS = {
  verified: 1,
  draft: 0.85,
  stale: 0.6,
  deprecated: 0.35,
  superseded: 0.15,
};

/** Recency factor based on verified_on (falling back to updated/created). */
export function freshness(entry, now = Date.now(), halfLifeDays = 180) {
  const stamp = entry.verified_on || entry.updated || entry.created;
  if (!stamp) return 0.8;
  const parsed = Date.parse(stamp.length === 10 ? `${stamp}T00:00:00Z` : stamp);
  if (!Number.isFinite(parsed)) return 0.8;
  const ageDays = Math.max(0, (now - parsed) / 86400000);
  const halfLife = Math.max(1, Number(halfLifeDays) || 180);
  return Math.max(0.35, Math.pow(0.5, ageDays / halfLife));
}

/**
 * Rank entries for a query.
 * @returns {Array<{entry: object, score: number, bm25: number, applicable: boolean,
 *   dims: {factor: number, matched: number, checked: number, notes: string[]},
 *   statusWeight: number, freshness: number, matched: string[]}>}
 */
export function rankEntries(entries, query, options = {}) {
  const {
    dims = {},
    mode = "prefer",
    kinds = [],
    statuses = [],
    limit = 8,
    now = Date.now(),
    halfLifeDays = 180,
  } = options;
  const pool = entries.filter((entry) => {
    if (kinds.length > 0 && !kinds.includes(entry.kind)) return false;
    if (statuses.length > 0 && !statuses.includes(entry.status)) return false;
    return true;
  });
  const index = buildIndex(pool);
  const rows = scoreQuery(index, query);
  const results = [];
  for (const row of rows) {
    const affinity = dimensionAffinity(row.entry.dims, dims, mode);
    if (affinity.factor === 0) continue;
    const statusWeight = STATUS_WEIGHTS[row.entry.status] || 0.5;
    const fresh = freshness(row.entry, now, halfLifeDays);
    results.push({
      entry: row.entry,
      score: row.bm25 * affinity.factor * statusWeight * fresh,
      bm25: row.bm25,
      applicable: affinity.applicable,
      dims: affinity,
      statusWeight,
      freshness: fresh,
      matched: row.matched,
    });
  }
  results.sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id));
  return results.slice(0, Math.max(1, Math.min(50, Number(limit) || 8)));
}

export { STATUS_WEIGHTS };
