/**
 * Lattice (dsh-lattice-memory) — write-path helpers (M3).
 *
 * Pure functions used by `lattice_record` / `lattice_verify` / `lattice_lint`:
 * secret scanning (so credentials never reach the shared library), near
 * duplicate detection (Jaccard over the same tokens the search index uses),
 * staleness windows and the lint report itself.
 */
import { tokenize } from "./search.js";

/**
 * Credential-ish shapes that must not be remembered. Deliberately narrow:
 * false positives annoy the author, false negatives leak tokens to every
 * workspace that shares the library.
 */
export const SECRET_RULES = [
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    name: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    name: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  },
  {
    name: "openai-key",
    pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    name: "password-assignment",
    pattern: /\b(?:password|passwd|secret)\s*[:=]\s*["']?[^\s"']{8,}/gi,
  },
  {
    name: "token-assignment",
    pattern: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|launch[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_./+-]{16,}/gi,
  },
  {
    name: "dsh-launch-token",
    pattern: /\bdsh[-_](?:launch|web)[-_]token[-_:=\s]+[A-Za-z0-9_-]{16,}/gi,
  },
];

const mask = (text) => {
  const head = text.slice(0, 6);
  return `${head}${"*".repeat(Math.min(Math.max(text.length - 6, 3), 12))}`;
};

/**
 * Scan free text for credentials.
 * @param {string} text
 * @returns {{rule: string, preview: string}[]} one hit per rule (first match)
 */
export function scanSecrets(text) {
  if (typeof text !== "string" || text.trim() === "") return [];
  const hits = [];
  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    const match = rule.pattern.exec(text);
    if (match === null) continue;
    hits.push({ rule: rule.name, preview: mask(match[0]) });
  }
  return hits;
}

/** Token set used for similarity: title + summary + feature (body is too noisy). */
export function similarityTokens(entry) {
  const text = [entry.title, entry.summary, entry.feature].filter((part) => typeof part === "string").join(" \n ");
  return new Set(tokenize(text));
}

/** Jaccard similarity of two entries' token sets, 0..1. */
export function similarity(a, b) {
  const left = similarityTokens(a);
  const right = similarityTokens(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Entries that look like `probe`, highest score first.
 * @returns {{id: string, title: string, score: number}[]}
 */
export function findSimilar(entries, probe, limit = 3) {
  return entries
    .filter((entry) => entry.id !== probe.id)
    .map((entry) => ({ id: entry.id, title: entry.title, score: Number(similarity(entry, probe).toFixed(3)) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

/** ISO calendar date (UTC) used for verified_on / supersedes checks. */
export function isoDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Whole days between an ISO date and now; NaN when unparsable. */
export function daysSince(dateString, now = new Date()) {
  const then = Date.parse(`${dateString}T00:00:00Z`);
  if (Number.isNaN(then)) return Number.NaN;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

/**
 * Verified entries whose verified_on is older than `staleDays`.
 * @returns {{id: string, title: string, verified_on: string, age_days: number}[]}
 */
export function staleCandidates(entries, staleDays, now = new Date()) {
  if (!Number.isFinite(staleDays) || staleDays <= 0) return [];
  const stale = [];
  for (const entry of entries) {
    if (entry.status !== "verified" || !entry.verified_on) continue;
    const age = daysSince(entry.verified_on, now);
    if (Number.isFinite(age) && age > staleDays) {
      stale.push({ id: entry.id, title: entry.title, verified_on: entry.verified_on, age_days: age });
    }
  }
  return stale.sort((left, right) => right.age_days - left.age_days);
}

/**
 * Whole-library health report.
 * @param {object[]} entries merged entries (library + overlay)
 * @param {{file: string, message: string}[]} problems files that failed validation
 * @param {{staleDays: number, similarityThreshold: number, now?: Date}} options
 */
export function lintReport(entries, problems, options = {}) {
  const now = options.now ?? new Date();
  const staleDays = options.staleDays ?? 180;
  const threshold = options.similarityThreshold ?? 0.85;

  const stale = staleCandidates(entries, staleDays, now);
  const missingEvidence = entries
    .filter((entry) => (entry.status === "verified" || entry.status === "draft") && entry.evidence.length === 0)
    .map((entry) => ({ id: entry.id, status: entry.status }));

  const duplicates = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const score = similarity(entries[i], entries[j]);
      if (score >= threshold) {
        duplicates.push({ a: entries[i].id, b: entries[j].id, score: Number(score.toFixed(3)) });
      }
    }
  }

  const secrets = [];
  for (const entry of entries) {
    const text = [entry.title, entry.summary, entry.body, ...entry.evidence].join("\n");
    const hits = scanSecrets(text);
    if (hits.length > 0) secrets.push({ id: entry.id, rules: hits.map((hit) => hit.rule) });
  }

  const notes = [];
  if (stale.length > 0) notes.push(`${stale.length} verified entr${stale.length === 1 ? "y is" : "ies are"} older than ${staleDays} days; re-verify with lattice_verify or accept the drift.`);
  if (missingEvidence.length > 0) notes.push(`${missingEvidence.length} entry file(s) have no evidence; facts without evidence rot silently.`);
  if (duplicates.length > 0) notes.push(`${duplicates.length} near-duplicate pair(s) at Jaccard ≥ ${threshold}; merge them or mark one superseded.`);
  if (secrets.length > 0) notes.push(`${secrets.length} entry file(s) contain credential-like strings; redact them now.`);
  if (problems.length > 0) notes.push(`${problems.length} entry file(s) failed validation and are invisible to retrieval.`);
  if (notes.length === 0) notes.push("no lint findings; the library is consistent.");

  return {
    entries: entries.length,
    problems,
    stale,
    missing_evidence: missingEvidence,
    duplicates,
    secrets,
    notes,
  };
}
