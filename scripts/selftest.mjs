#!/usr/bin/env node
/**
 * Lattice — dependency-free self-test (M1–M6).
 *
 * Run with Node 20+:  node scripts/selftest.mjs
 *
 * Exercises the pure modules (frontmatter codec, entry model, BM25 + CJK
 * tokenizer, dimension matching, matrix/gaps, resident brief, overlay merge,
 * write-loop guards, projects.json overrides, preset detection, entry cache,
 * portable export/import planning, semi-automatic capture) against an isolated
 * temp library. It does not need DSH and never touches `~/.dsh` or the real
 * library.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument, serializeDocument, parseYaml, stringifyYaml } from "../src/frontmatter.js";
import {
  normalizeEntry,
  validateEntry,
  serializeEntry,
  saveEntry,
  loadEntries,
  loadEntriesFromDir,
  loadEntriesMerged,
  entryFile,
} from "../src/entries.js";
import {
  tokenize,
  buildIndex,
  scoreQuery,
  rankEntries,
  matchDimensionValue,
  compareVersions,
  dimensionAffinity,
} from "../src/search.js";
import { buildMatrix, findGaps, chooseKeys } from "../src/matrix.js";
import { buildBrief, estimateTokens } from "../src/brief.js";
import { scanSecrets, similarity, findSimilar, staleCandidates, lintReport } from "../src/write.js";
import { matchProject, normalizePathKey } from "../src/projects.js";
import { detectProject } from "../src/detect.js";
import { exportJson, exportSkill, exportAgents, filterEntries, planImport } from "../src/portable.js";
import {
  buildCandidate,
  buildIncidentCandidate,
  createCaptureTracker,
  createSessionCaptureTracker,
  errorStem,
} from "../src/capture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-selftest-"));
const library = path.join(temporary, "library");
let passed = 0;

function check(name, run) {
  run();
  passed += 1;
  console.log(`ok ${passed} — ${name}`);
}

function fixtureEntry(overrides) {
  return normalizeEntry(
    {
      id: "potion-duration-forge-1-20-1",
      kind: "contract",
      title: "药水持续时间必须用 Attribute 修饰符",
      summary: "1.20.1 Forge 下通过 AttributeInstance 修改 duration，不能直接改 NBT。",
      feature: "药水持续时间",
      tags: ["potion", "attribute", "forge"],
      dims: { game: "minecraft", mcver: "1.20.1", loader: "forge" },
      status: "verified",
      confidence: "high",
      verified_on: "2026-10-30",
      evidence: ["file:src/main/java/com/example/PotionHandler.java"],
      ...overrides,
    },
    "## 做法\n\n调用 `AttributeInstance#addModifier`。\n",
  );
}

try {
  check("yaml codec round-trips nested maps, lists and CJK strings", () => {
    const data = {
      id: "example",
      title: "中文标题：带冒号的标题",
      dims: { mcver: "1.20.1", loaders: ["forge", "fabric"] },
      tags: ["a", "b c"],
      flag: true,
      count: 3,
      ratio: 0.5,
      empty: null,
    };
    const yaml = stringifyYaml(data);
    assert.deepEqual(parseYaml(yaml), data);
  });

  check("document codec preserves body and frontmatter", () => {
    const text = serializeDocument({ id: "x", title: "t" }, "## body\n\nline");
    const parsed = parseDocument(text);
    assert.equal(parsed.data.id, "x");
    assert.equal(parsed.data.title, "t");
    assert.equal(parsed.body.trim(), "## body\n\nline");
  });

  check("entry serialization round-trips through parseDocument", () => {
    const entry = fixtureEntry({});
    const text = serializeEntry(entry);
    const parsed = parseDocument(text);
    const back = normalizeEntry(parsed.data, parsed.body);
    assert.equal(back.id, entry.id);
    assert.equal(back.kind, "contract");
    assert.equal(back.feature, entry.feature);
    assert.deepEqual(back.tags, entry.tags);
    assert.deepEqual(back.dims, entry.dims);
    assert.equal(back.status, "verified");
    assert.equal(back.verified_on, "2026-10-30");
    assert.deepEqual(back.evidence, entry.evidence);
    assert.ok(back.body.includes("AttributeInstance"));
    assert.deepEqual(validateEntry(back), []);
  });

  check("validation rejects unknown kind and bad id", () => {
    const bad = fixtureEntry({ kind: "unknown-kind", id: "Bad Id" });
    const problems = validateEntry(bad);
    assert.ok(problems.some((item) => item.includes("id must match")));
    assert.ok(problems.some((item) => item.includes("unknown kind")));
  });

  check("tokenizer splits camelCase/snake_case and emits CJK bigrams", () => {
    const tokens = tokenize("PotionEffect potion_effect 药水效果 1.20.1");
    assert.ok(tokens.includes("potion"));
    assert.ok(tokens.includes("effect"));
    assert.ok(tokens.includes("药水"));
    assert.ok(tokens.includes("水效"));
    assert.ok(tokens.includes("效果"));
    assert.ok(tokens.includes("1.20.1"));
  });

  check("version comparison and dimension wildcards/ranges", () => {
    assert.equal(compareVersions("1.20.1", "1.20.2"), -1);
    assert.equal(compareVersions("1.21.4", "1.21.4"), 0);
    assert.equal(compareVersions("1.20.1", "1.20"), 1);
    assert.ok(matchDimensionValue("1.20.1", "1.20.x"));
    assert.ok(!matchDimensionValue("1.20.1", ">=1.21"));
    assert.ok(matchDimensionValue("1.21.4", ">=1.21 <1.22"));
    assert.ok(!matchDimensionValue("1.22.0", ">=1.21 <1.22"));
    assert.ok(matchDimensionValue("forge", "forge"));
    assert.ok(matchDimensionValue(["forge", "fabric"], "fabric"));
    assert.ok(matchDimensionValue("anything", "*"));
  });

  check("dimension affinity: generic entry neutral, mismatch downweighted/strict-excluded", () => {
    const generic = dimensionAffinity({}, { mcver: "1.20.1" }, "prefer");
    assert.ok(generic.applicable);
    assert.ok(generic.factor > 0.5);
    const mismatch = dimensionAffinity({ mcver: "1.20.1" }, { mcver: "1.21.4" }, "prefer");
    assert.ok(!mismatch.applicable);
    assert.ok(mismatch.factor > 0);
    const strict = dimensionAffinity({ mcver: "1.20.1" }, { mcver: "1.21.4" }, "strict");
    assert.equal(strict.factor, 0);
    assert.ok(!strict.applicable);
  });

  check("BM25 ranks the version-relevant entry first", () => {
    const potion = fixtureEntry({});
    const unrelated = fixtureEntry({
      id: "node-build-cache",
      kind: "gotcha",
      title: "pnpm store 缓存导致旧构建",
      summary: "删除 node_modules/.cache 后重装。",
      feature: "构建缓存",
      tags: ["pnpm"],
      dims: { platform: "node" },
      status: "verified",
    });
    const index = buildIndex([potion, unrelated]);
    const rows = scoreQuery(index, "药水效果 持续时间");
    assert.equal(rows[0].entry.id, potion.id);
    const ranked = rankEntries([potion, unrelated], "药水持续时间", {
      dims: { game: "minecraft", mcver: "1.20.1", loader: "forge" },
      mode: "strict",
      limit: 5,
    });
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].entry.id, potion.id);
    assert.ok(ranked[0].applicable);
  });

  check("strict mode excludes cross-version entries, prefer keeps them flagged", () => {
    const potion = fixtureEntry({});
    const query = "药水持续时间";
    const strict = rankEntries([potion], query, {
      dims: { mcver: "1.21.4", loader: "neoforge" },
      mode: "strict",
    });
    assert.equal(strict.length, 0);
    const prefer = rankEntries([potion], query, {
      dims: { mcver: "1.21.4", loader: "neoforge" },
      mode: "prefer",
    });
    assert.equal(prefer.length, 1);
    assert.equal(prefer[0].applicable, false);
    assert.equal(prefer[0].dims.matched, 0);
  });

  check("saveEntry writes, loadEntries reads, duplicates are refused", () => {
    fs.mkdirSync(library, { recursive: true });
    const entry = fixtureEntry({});
    const saved = saveEntry(library, entry);
    assert.equal(saved.ok, true);
    assert.equal(saved.created, true);
    assert.ok(fs.existsSync(entryFile(library, entry.id)));
    const loaded = loadEntries(library);
    assert.equal(loaded.problems.length, 0);
    assert.equal(loaded.entries.length, 1);
    assert.equal(loaded.entries[0].id, entry.id);
    const duplicate = saveEntry(library, entry);
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.code, "already-exists");
    const replaced = saveEntry(library, fixtureEntry({}), { overwrite: true });
    assert.equal(replaced.ok, true);
    assert.equal(loaded.entries.length, 1);
  });

  check("invalid files are reported, not silently dropped", () => {
    fs.writeFileSync(path.join(library, "entries", "broken.md"), "---\nid: broken\n---\nno kind\n", "utf8");
    const loaded = loadEntries(library);
    assert.equal(loaded.entries.length, 1);
    assert.equal(loaded.problems.length, 1);
    assert.ok(loaded.problems[0].file.endsWith("broken.md"));
  });

  // ── M2: matrix, gaps, resident brief, overlay ──────────────────────────

  check("chooseKeys uses the known dimension order and caps the width", () => {
    const keys = chooseKeys([fixtureEntry({})], []);
    assert.deepEqual(keys, ["game", "mcver", "loader"]);
    assert.deepEqual(chooseKeys([fixtureEntry({})], ["mcver", "loader"]), ["mcver", "loader"]);
  });

  check("matrix groups one feature by dimension signature with best status", () => {
    const forge = fixtureEntry({});
    const neoforge = fixtureEntry({
      id: "potion-duration-neoforge-1-21",
      dims: { game: "minecraft", mcver: "1.21.4", loader: "neoforge" },
      status: "draft",
      verified_on: "2026-11-01",
    });
    const matrix = buildMatrix([forge, neoforge], { keys: ["mcver", "loader"] });
    assert.equal(matrix.features, 1);
    assert.equal(matrix.total_entries, 2);
    assert.equal(matrix.rows[0].cells.length, 2);
    const verified = matrix.rows[0].cells.find((cell) => cell.signature.includes("1.20.1"));
    assert.equal(verified.best_status, "verified");
    const draft = matrix.rows[0].cells.find((cell) => cell.signature.includes("1.21.4"));
    assert.equal(draft.best_status, "draft");
  });

  check("gaps list features without an applicable entry, generic ones count as covered", () => {
    const forge = fixtureEntry({});
    const missing = findGaps([forge], { dims: { mcver: "1.21.4", loader: "neoforge" } });
    assert.equal(missing.features, 1);
    assert.equal(missing.covered, 0);
    assert.equal(missing.gaps.length, 1);
    assert.equal(missing.gaps[0].feature, "药水持续时间");
    assert.ok(missing.gaps[0].ids.includes(forge.id));
    const generic = fixtureEntry({ id: "generic-gotcha", kind: "gotcha", feature: "通用", dims: {} });
    const partly = findGaps([forge, generic], { dims: { mcver: "1.21.4" } });
    assert.equal(partly.features, 2);
    assert.equal(partly.covered, 1);
    assert.equal(partly.gaps.length, 1);
  });

  check("brief selects only applicable entries and respects the token budget", () => {
    const forge = fixtureEntry({});
    const neoforge = fixtureEntry({
      id: "potion-duration-neoforge-1-21",
      dims: { game: "minecraft", mcver: "1.21.4", loader: "neoforge" },
      status: "draft",
    });
    const brief = buildBrief([forge, neoforge], {
      dims: { mcver: "1.20.1", loader: "forge" },
      topK: 8,
      maxTokens: 1500,
    });
    assert.ok(brief.text.includes(forge.id));
    assert.ok(!brief.text.includes("potion-duration-neoforge-1-21"));
    assert.ok(!brief.text.includes("1.21.4"));
    assert.ok(brief.count >= 1);
    assert.ok(brief.tokens <= 1500);
  });

  check("brief reports a coverage gap when nothing applies", () => {
    const brief = buildBrief([fixtureEntry({})], { dims: { mcver: "1.22.0" }, topK: 8, maxTokens: 1500 });
    assert.ok(brief.text.includes("coverage gap"));
    assert.equal(brief.count, 0);
  });

  check("token estimate counts CJK characters individually", () => {
    assert.equal(estimateTokens("药水"), 2);
    assert.ok(estimateTokens("abcdefgh") > 0);
  });

  check("overlay entries win by id and merge over the shared library", () => {
    const overlayRoot = path.join(temporary, "overlay");
    fs.mkdirSync(path.join(overlayRoot, "entries"), { recursive: true });
    const shared = fixtureEntry({ summary: "shared version" });
    assert.equal(saveEntry(library, shared, { overwrite: true }).ok, true);
    assert.equal(saveEntry(overlayRoot, fixtureEntry({ summary: "overlay version" })).ok, true);
    const merged = loadEntriesMerged(library, overlayRoot);
    assert.equal(merged.overlay, 1);
    assert.equal(merged.entries.length, 1);
    assert.equal(merged.entries[0].summary, "overlay version");
    const sharedOnly = loadEntriesMerged(library, null);
    assert.equal(sharedOnly.overlay, 0);
    assert.equal(sharedOnly.entries[0].summary, "shared version");
  });

  check("secret scan catches tokens and leaves ordinary prose alone", () => {
    assert.deepEqual(scanSecrets("just a note about potions"), []);
    const hits = scanSecrets("key AKIAIOSFODNN7EXAMPLE");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].rule, "aws-access-key");
    assert.ok(!hits[0].preview.includes("EXAMPLE"), "preview must mask the credential");
  });

  check("jaccard similarity separates distinct entries and finds near-duplicates", () => {
    const left = fixtureEntry({ title: "药水持续时间必须走 Attribute", summary: "1.20.1 Forge 的药水持续时间要改成属性修饰符" });
    const clone = fixtureEntry({ id: "clone", title: "药水持续时间必须走 Attribute 修饰符", summary: "1.20.1 Forge 的药水持续时间要改成属性修饰符" });
    const other = fixtureEntry({ id: "other", title: "实体注册与刷怪蛋", summary: "1.21 注册刷怪蛋的步骤" });
    assert.ok(similarity(left, clone) >= 0.8);
    assert.ok(similarity(left, other) < 0.2);
    const similar = findSimilar([left, other], clone);
    assert.equal(similar[0].id, left.id);
  });

  check("stale candidates only flag verified entries past the window", () => {
    const now = new Date("2026-11-02T00:00:00Z");
    const old = fixtureEntry({ id: "old", status: "verified", verified_on: "2026-01-01" });
    const fresh = fixtureEntry({ id: "fresh", status: "verified", verified_on: "2026-10-30" });
    const draft = fixtureEntry({ id: "draft", status: "draft", verified_on: "" });
    const stale = staleCandidates([old, fresh, draft], 180, now);
    assert.deepEqual(stale.map((item) => item.id), ["old"]);
  });

  check("lintReport surfaces stale, missing evidence and duplicates", () => {
    const now = new Date("2026-11-02T00:00:00Z");
    const old = fixtureEntry({ id: "old", status: "verified", verified_on: "2026-01-01", title: "旧条目：药水效果", summary: "1.20.1 药水效果写法" });
    const noEvidence = fixtureEntry({ id: "no-evidence", status: "verified", verified_on: "2026-10-30", evidence: [], title: "没有证据的条目", summary: "一条没有证据的条目" });
    const dupA = fixtureEntry({ id: "dup-a", title: "同一件事的两种说法", summary: "完全一样的内容描述" });
    const dupB = fixtureEntry({ id: "dup-b", title: "同一件事的两种说法", summary: "完全一样的内容描述" });
    const report = lintReport([old, noEvidence, dupA, dupB], [], { staleDays: 180, similarityThreshold: 0.85, now });
    assert.deepEqual(report.stale.map((item) => item.id), ["old"]);
    assert.deepEqual(report.missing_evidence.map((item) => item.id), ["no-evidence"]);
    assert.equal(report.duplicates.length, 1);
    assert.ok(report.notes.length > 0);
  });

  check("entry cache is reused across calls and invalidated on change", () => {
    const cacheRoot = path.join(temporary, "cache-check");
    const dir = path.join(cacheRoot, "entries");
    fs.mkdirSync(dir, { recursive: true });
    const first = loadEntriesFromDir(dir);
    assert.equal(first.entries.length, 0);
    assert.equal(loadEntriesFromDir(dir), first, "second read must hit the cache");
    assert.equal(saveEntry(cacheRoot, fixtureEntry({})).ok, true);
    const afterWrite = loadEntriesFromDir(dir);
    assert.notEqual(afterWrite, first, "a new file must invalidate the cache");
    assert.equal(afterWrite.entries.length, 1);
    const file = entryFile(cacheRoot, "potion-duration-forge-1-20-1");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("AttributeInstance", "AttributeMap"), "utf8");
    const afterEdit = loadEntriesFromDir(dir);
    assert.notEqual(afterEdit, afterWrite, "an edit must invalidate the cache");
    assert.ok(afterEdit.entries[0].body.includes("AttributeMap"));
  });

  check("workspace presets are detected from project metadata", () => {
    const mc = path.join(temporary, "fixture-mcmod");
    fs.mkdirSync(mc, { recursive: true });
    fs.writeFileSync(path.join(mc, "gradle.properties"), "minecraft_version=1.20.1\nforge_version=47.2.0\n", "utf8");
    const mcDetected = detectProject(mc);
    assert.equal(mcDetected.preset, "minecraft-mod");
    assert.equal(mcDetected.dims.mcver, "1.20.1");
    assert.equal(mcDetected.dims.loader, "forge");

    const py = path.join(temporary, "fixture-python");
    fs.mkdirSync(py, { recursive: true });
    fs.writeFileSync(path.join(py, "pyproject.toml"), '[project]\nname = "demo"\n', "utf8");
    assert.equal(detectProject(py).preset, "python");

    const node = path.join(temporary, "fixture-node");
    fs.mkdirSync(node, { recursive: true });
    fs.writeFileSync(path.join(node, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }), "utf8");
    assert.equal(detectProject(node).preset, "node-package");

    const rust = path.join(temporary, "fixture-rust");
    fs.mkdirSync(rust, { recursive: true });
    fs.writeFileSync(path.join(rust, "Cargo.toml"), '[package]\nname = "demo"\n', "utf8");
    assert.equal(detectProject(rust).preset, "rust");

    const empty = path.join(temporary, "fixture-empty");
    fs.mkdirSync(empty, { recursive: true });
    assert.equal(detectProject(empty).preset, "generic");
  });

  check("projects.json overrides pin a workspace (absolute beats relative, longest wins)", () => {
    const projects = {
      "Fixture-Python": { preset: "python", dims: { platform: "python", runtime: "cpython" } },
      "C:\\src\\demo": { dims: { platform: "node" } },
      "c:\\src\\demo\\mods\\demo": { preset: "minecraft-mod", dims: { mcver: "1.20.1", loader: "forge" } },
    };
    assert.equal(normalizePathKey("C:\\Src\\Demo\\"), "c:/src/demo");
    const hit = matchProject(projects, "C:\\src\\demo\\mods\\demo\\src");
    assert.equal(hit.preset, "minecraft-mod");
    assert.equal(hit.dims.mcver, "1.20.1");
    const shorter = matchProject(projects, "C:\\src\\demo\\other");
    assert.equal(shorter.preset, "");
    assert.equal(shorter.dims.platform, "node");
    const byName = matchProject(projects, "/home/me/work/fixture-python");
    assert.equal(byName.preset, "python");
    assert.equal(matchProject(projects, "D:\\elsewhere"), null);
  });

  check("portable export renders JSON, SKILL.md and AGENTS.md artifacts", () => {
    const entries = [
      fixtureEntry({ id: "port-a", feature: "药水持续时间" }),
      fixtureEntry({ id: "port-b", feature: "attribute 计算", title: "属性顺序", summary: "顺序影响结果" }),
    ];
    const filtered = filterEntries(entries, { feature: "药水" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, "port-a");

    const json = exportJson(entries, { source: "C:\\Lattice" });
    assert.equal(json.schema, "lattice-export/1");
    assert.equal(json.count, 2);
    assert.ok(Array.isArray(json.entries));
    assert.equal(json.entries[0].body.includes("AttributeInstance"), true);

    const skill = exportSkill(entries, { source: "C:\\Lattice" });
    assert.ok(skill.startsWith("---\nname: lattice-memory\n"));
    assert.ok(skill.includes("## 药水持续时间"));
    assert.ok(skill.includes("### "));

    const agents = exportAgents(entries);
    assert.ok(agents.startsWith("## Project memory (Lattice"));
    assert.ok(agents.includes("port-a"));

    const roundTrip = exportJson(entries);
    const plan = planImport([], JSON.stringify(roundTrip));
    assert.equal(plan.candidates, 2);
    assert.equal(plan.toAdd.length, 2);
    assert.deepEqual(plan.conflicts, []);

    const duplicated = planImport(entries, roundTrip);
    assert.equal(duplicated.toAdd.length, 0);
    assert.equal(duplicated.conflicts.length, 2);
    assert.ok(duplicated.conflicts.every((item) => item.reason === "id-exists"));

    const nearDup = planImport(
      [fixtureEntry({ id: "existing", title: "药水时长", summary: "药水持续时间要用 Attribute" })],
      { entries: [{ id: "clone", kind: "contract", title: "药水时长", feature: "药水持续时间", summary: "药水持续时间要用 Attribute", status: "draft" }] },
    );
    assert.equal(nearDup.toAdd.length, 0);
    assert.equal(nearDup.conflicts[0].reason, "near-duplicate");

    const secrets = planImport([], {
      entries: [
        {
          id: "leaky",
          kind: "note",
          title: "token",
          feature: "x",
          status: "draft",
          body: "api_key = sk-abcdefghijklmnopqrstuvwxyz0123456789",
        },
      ],
    });
    assert.equal(secrets.toAdd.length, 0);
    assert.equal(secrets.conflicts[0].reason, "credentials");

    const invalid = planImport([], { entries: [{ id: "Bad Id", kind: "note", title: "t", feature: "f", status: "draft" }] });
    assert.equal(invalid.toAdd.length, 0);
    assert.equal(invalid.problems.length, 1);
  });

  check("capture tracker pairs a failure with the later retry and builds a draft candidate", () => {
    const tracker = createCaptureTracker();
    const failed = { isError: true, content: [{ type: "text", text: "Error: HTTP 404 /lattice-panel/version" }] };
    const ok = { isError: false, content: [{ type: "text", text: "ok" }] };
    const exec = { name: "bash", agent: { id: "agent-a" } };

    assert.equal(tracker.observe(exec, failed), null);
    const hit = tracker.observe(exec, ok);
    assert.equal(hit.tool, "bash");
    assert.ok(hit.errorText.includes("404"));
    assert.equal(errorStem(hit.errorText).startsWith("Error"), true);

    const candidate = buildCandidate({ hit, dims: { mcver: "1.20.1" }, workspace: "C:\\proj" });
    assert.equal(candidate.kind, "gotcha");
    assert.equal(candidate.feature, "debugging");
    assert.equal(candidate.dims.mcver, "1.20.1");
    assert.equal(candidate.evidence.length, 2);
    assert.ok(candidate.title.includes("bash"));
    assert.ok(candidate.body.includes("404"));

    // another agent's retry does not pair with agent-a's failure
    assert.equal(tracker.observe({ name: "bash", agent: { id: "agent-b" } }, ok), null);
    // Lattice's own tools are ignored so accepting can never capture itself
    assert.equal(tracker.observe({ name: "lattice_capture", agent: { id: "agent-a" } }, failed), null);
    // a failure older than the window is forgotten before the retry
    const stale = createCaptureTracker({ forgetAfterMs: 10 });
    stale.observe(exec, failed, 1000);
    assert.equal(stale.observe(exec, ok, 5000), null);
  });

  check("M7 session tracker folds a human correction into the failure chain", () => {
    const tracker = createSessionCaptureTracker();
    const failed = { sessionKey: "s1", tool: "read", isError: true, errorText: "Error: file not found", now: 1000 };
    const okAfter = { sessionKey: "s1", tool: "read", isError: false, now: 2000 };

    assert.deepEqual(tracker.recordTool(failed).recovered, []);
    // a correction attached to the open incident
    assert.equal(tracker.userMessage({ sessionKey: "s1", text: "不对，应该用 package.json", now: 1500 }), true);
    // plain chatter is not a correction
    assert.equal(tracker.userMessage({ sessionKey: "s1", text: "继续", now: 1600 }), false);

    const recovered = tracker.recordTool(okAfter).recovered;
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].tool, "read");
    assert.equal(recovered[0].reason, "user-correction");
    assert.equal(recovered[0].corrections.length, 1);

    const candidate = buildIncidentCandidate({ incident: recovered[0], dims: { mcver: "1.20.1" }, workspace: "C:\\proj" });
    assert.equal(candidate.kind, "gotcha");
    assert.ok(candidate.title.includes("用户纠正"));
    assert.ok(candidate.body.includes("不对，应该用 package.json"));
    assert.equal(candidate.evidence.length, 3);

    // a failure nobody corrected survives the turn boundary (corrections usually
    // arrive in later turns) and can still be folded into a later fix
    const t2 = createSessionCaptureTracker();
    t2.recordTool({ sessionKey: "s2", tool: "edit", isError: true, errorText: "Error: old_string not found", now: 1000 });
    assert.deepEqual(t2.endTurn({ sessionKey: "s2", now: 2000 }), []);
    assert.equal(t2.userMessage({ sessionKey: "s2", text: "不对，先读文件再改", now: 2500 }), true);
    const t2Recovered = t2.recordTool({ sessionKey: "s2", tool: "edit", isError: false, now: 3000 }).recovered;
    assert.equal(t2Recovered.length, 1);
    assert.equal(t2Recovered[0].reason, "user-correction");

    // stale failures (past the retention window) are dropped at the turn boundary
    const t2b = createSessionCaptureTracker();
    t2b.recordTool({ sessionKey: "s2b", tool: "edit", isError: true, errorText: "Error: old_string not found", now: 1000 });
    const pastWindow = 1000 + 30 * 60 * 1000 + 1;
    assert.deepEqual(t2b.endTurn({ sessionKey: "s2b", now: pastWindow }), []);
    assert.equal(t2b.userMessage({ sessionKey: "s2b", text: "应该先读文件", now: pastWindow + 1 }), false);

    // turn end keeps corrected incidents even without a later successful retry,
    // and keeps sessions isolated
    const t3 = createSessionCaptureTracker();
    t3.recordTool({ sessionKey: "s3", tool: "edit", isError: true, errorText: "Error: old_string not found", now: 1000 });
    assert.equal(t3.userMessage({ sessionKey: "s3", text: "应该先读文件再改", now: 1500 }), true);
    const ended = t3.endTurn({ sessionKey: "s3", now: 2000 });
    assert.equal(ended.length, 1);
    assert.equal(ended[0].reason, "user-correction");
    assert.equal(ended[0].corrections.length, 1);
    assert.deepEqual(t3.endTurn({ sessionKey: "other", now: 2000 }), []);
    assert.deepEqual(t3.endTurn({ sessionKey: "s3", now: 2100 }), []);
  });

  console.log(`\nall ${passed} checks passed (${path.relative(process.cwd(), here) || "."})`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
