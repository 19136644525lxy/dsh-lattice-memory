/**
 * Lattice — portable export and import (M5).
 *
 * Export turns library entries into three artifacts:
 *   - JSON: machine-readable, re-importable (schema `lattice-export/1`);
 *   - SKILL.md: a DSH skill page so another harness/user can load the same
 *     knowledge through the skills channel;
 *   - AGENTS.md snippet: an instruction excerpt for a project's AGENTS.md.
 *
 * Import accepts the JSON shape (or a bare array) and plans a merge against
 * the library: new entries are added, existing ids, near-duplicates, invalid
 * records and credential-like text are reported as conflicts instead of being
 * silently overwritten. `applyImport` writes the accepted entries.
 */
import { entryFile, normalizeEntry, saveEntry, validateEntry } from "./entries.js";
import { findSimilar, isoDate, scanSecrets } from "./write.js";

export const EXPORT_SCHEMA = "lattice-export/1";

/** Keep only entries matching the (all optional) export filters. */
export function filterEntries(entries, { ids, feature = "", kind = "", status = "" } = {}) {
  const idSet = Array.isArray(ids) ? new Set(ids) : null;
  const featureNeedle = feature.trim().toLowerCase();
  return entries.filter((entry) => {
    if (idSet && !idSet.has(entry.id)) return false;
    if (featureNeedle && !entry.feature.toLowerCase().includes(featureNeedle)) return false;
    if (kind && entry.kind !== kind) return false;
    if (status && entry.status !== status) return false;
    return true;
  });
}

/** Portable, frontmatter+body shape (no absolute paths, no cache fields). */
export function entryToPortable(entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    summary: entry.summary,
    feature: entry.feature,
    tags: entry.tags.slice(),
    dims: { ...entry.dims },
    status: entry.status,
    confidence: entry.confidence,
    verified_on: entry.verified_on,
    evidence: entry.evidence.slice(),
    supersedes: entry.supersedes.slice(),
    related: entry.related.slice(),
    applies_when: {
      files: entry.applies_when.files.slice(),
      symbols: entry.applies_when.symbols.slice(),
    },
    created: entry.created,
    body: entry.body,
  };
}

/** Turn a portable record back into a normalized library entry. */
export function portableToEntry(record) {
  if (!record || typeof record !== "object") return null;
  return normalizeEntry(record, typeof record.body === "string" ? record.body : "");
}

export function exportJson(entries, { source = "", overlay = 0, now = new Date() } = {}) {
  return {
    schema: EXPORT_SCHEMA,
    exported_at: now.toISOString(),
    source,
    overlay_entries: overlay,
    count: entries.length,
    entries: entries.map(entryToPortable),
  };
}

function dimLine(entry) {
  const parts = [];
  for (const [key, value] of Object.entries(entry.dims)) {
    parts.push(`${key}=${Array.isArray(value) ? value.join("|") : value}`);
  }
  return parts.length > 0 ? parts.join(" ") : "";
}

function renderEntrySection(entry) {
  const meta = [`kind=${entry.kind}`, `status=${entry.status}`];
  if (entry.confidence !== "") meta.push(`confidence=${entry.confidence}`);
  if (entry.verified_on !== "") meta.push(`verified=${entry.verified_on}`);
  const dims = dimLine(entry);
  if (dims) meta.push(dims);
  const lines = [`### ${entry.title}`, "", `<!-- ${entry.id} · ${meta.join(" · ")} -->`, ""];
  if (entry.summary !== "") lines.push(entry.summary, "");
  if (entry.body.trim() !== "") lines.push(entry.body.trim(), "");
  if (entry.evidence.length > 0) lines.push("Evidence: " + entry.evidence.join("; "), "");
  return lines.join("\n");
}

function groupByFeature(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.feature.trim() === "" ? "(unspecified)" : entry.feature;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** SKILL.md artifact: valid frontmatter (name/description) + one section per feature. */
export function exportSkill(entries, { source = "", now = new Date() } = {}) {
  const date = isoDate(now);
  const header = [
    "---",
    "name: lattice-memory",
    `description: Portable project memory exported from Lattice (${entries.length} entries, ${date})${source ? ` — library: ${source}` : ""}.`,
    "---",
    "",
    "# Lattice project memory",
    "",
    "Version-aware project knowledge exported from a shared Lattice library. Load this skill to reuse verified contracts, gotchas and porting notes across projects.",
    "",
  ];
  const sections = groupByFeature(entries).map(([feature, group]) => {
    const blocks = [`## ${feature}`, "", ...group.map((entry) => renderEntrySection(entry))];
    return blocks.join("\n");
  });
  return header.join("\n") + "\n" + sections.join("\n");
}

/** AGENTS.md snippet: plain Markdown, no frontmatter, safe to paste. */
export function exportAgents(entries, { source = "", now = new Date() } = {}) {
  const date = isoDate(now);
  const header = [
    `## Project memory (Lattice, ${entries.length} entries, exported ${date})`,
    "",
    "These notes were exported from a shared Lattice library. Relevant entries apply to the versions/environments noted in each item; entries from other versions are cross-version references, not rules.",
    "",
  ];
  const sections = groupByFeature(entries).map(([feature, group]) => {
    const blocks = [`### ${feature}`, "", ...group.map((entry) => renderEntrySection(entry))];
    return blocks.join("\n");
  });
  return header.join("\n") + "\n" + sections.join("\n");
}

/** Parse an import payload (object, JSON string, or bare array). */
export function parseImportPayload(payload) {
  const problems = [];
  let data = payload;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch (err) {
      return { entries: [], problems: ["payload is not valid JSON"] };
    }
  }
  if (Array.isArray(data)) data = { entries: data };
  if (!data || typeof data !== "object" || !Array.isArray(data.entries)) {
    return { entries: [], problems: ["payload must be a lattice export object with an entries array, or a bare array"] };
  }
  if (typeof data.schema === "string" && data.schema !== "" && data.schema !== EXPORT_SCHEMA) {
    problems.push(`payload schema is ${data.schema} (expected ${EXPORT_SCHEMA}); importing anyway`);
  }
  const entries = [];
  data.entries.forEach((record, index) => {
    const entry = portableToEntry(record);
    if (entry === null) {
      problems.push(`entries[${index}] is not an object`);
      return;
    }
    const errors = validateEntry(entry);
    if (errors.length > 0) {
      problems.push(`entries[${index}] (${entry.id || "no id"}): ${errors.join("; ")}`);
      return;
    }
    entries.push(entry);
  });
  return { entries, problems };
}

/**
 * Plan an import against existing entries. Never writes: returns what would be
 * added and why every other candidate is rejected.
 */
export function planImport(existing, payload, { similarityThreshold = 0.85 } = {}) {
  const parsed = parseImportPayload(payload);
  const byId = new Map(existing.map((entry) => [entry.id, entry]));
  const toAdd = [];
  const conflicts = [];
  for (const entry of parsed.entries) {
    if (byId.has(entry.id)) {
      conflicts.push({ id: entry.id, reason: "id-exists", detail: `library already has "${entry.id}"`, title: entry.title });
      continue;
    }
    const secrets = scanSecrets([entry.title, entry.summary, entry.body].join("\n"));
    if (secrets.length > 0) {
      conflicts.push({ id: entry.id, reason: "credentials", detail: `contains ${secrets.map((s) => s.rule).join(", ")}`, title: entry.title });
      continue;
    }
    const similar = findSimilar([...existing, ...toAdd], entry, 1);
    if (similar.length > 0 && similar[0].score >= similarityThreshold) {
      conflicts.push({
        id: entry.id,
        reason: "near-duplicate",
        detail: `similar to "${similar[0].id}" (score ${similar[0].score})`,
        title: entry.title,
      });
      continue;
    }
    toAdd.push(entry);
    byId.set(entry.id, entry);
  }
  return { candidates: parsed.entries.length, toAdd, conflicts, problems: parsed.problems };
}

/** Apply a previously planned import. */
export function applyImport(root, plan, existingDirectories = new Set()) {
  const written = [];
  for (const entry of plan.toAdd) {
    saveEntry(root, entry, { overwrite: false });
    written.push({ id: entry.id, file: entryFile(root, entry.id) });
  }
  return written;
}
