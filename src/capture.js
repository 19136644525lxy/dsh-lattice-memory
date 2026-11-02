/**
 * Semi-automatic capture (M6).
 *
 * Turns "a tool failed, and a later attempt of the same tool in the same agent
 * succeeded" into ONE pending candidate. Candidates live in
 * `<stateDir>/captures.json` until the model accepts or discards them with
 * `lattice_capture` — nothing reaches the library before that. With
 * `capture.mode = "draft"` the host stores the candidate as a draft entry
 * immediately instead of queueing it.
 *
 * This module is deliberately pure: it never touches the entry store, so the
 * accept path can reuse the same validation / secret scanning / near-duplicate
 * refusal as `lattice_record`.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./state.js";

export const CAPTURE_FILE = "captures.json";

export const CAPTURE_LIMITS = Object.freeze({
  maxPending: 5,
  errorChars: 320,
  /** Failures older than this are forgotten (a much later retry is not a fix). */
  forgetAfterMs: 30 * 60 * 1000,
});

function captureFile() {
  return join(stateDir(), CAPTURE_FILE);
}

function isCandidate(value) {
  return Boolean(value) && typeof value === "object"
    && typeof value.id === "string"
    && typeof value.tool === "string"
    && typeof value.title === "string";
}

function normalizeQueue(parsed) {
  const pending = parsed && Array.isArray(parsed.pending) ? parsed.pending.filter(isCandidate) : [];
  return { pending };
}

/** Pending candidates (never throws: a corrupt queue reads as empty). */
export function readCaptureQueue() {
  try {
    return normalizeQueue(JSON.parse(readFileSync(captureFile(), "utf8")));
  } catch (err) {
    return { pending: [] };
  }
}

export function writeCaptureQueue(queue) {
  const file = captureFile();
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(normalizeQueue(queue), null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return file;
}

export function listCandidates() {
  return readCaptureQueue().pending;
}

export function findCandidate(id) {
  const wanted = String(id ?? "").trim();
  return readCaptureQueue().pending.find((item) => item.id === wanted) ?? null;
}

export function removeCandidates(ids) {
  const drop = new Set((Array.isArray(ids) ? ids : [ids]).map((id) => String(id ?? "").trim()));
  const queue = readCaptureQueue();
  const before = queue.pending.length;
  queue.pending = queue.pending.filter((item) => !drop.has(item.id));
  if (queue.pending.length !== before) writeCaptureQueue(queue);
  return before - queue.pending.length;
}

/**
 * Append one candidate. Near-identical candidates (same tool + same first line
 * of the error) are merged instead of duplicated, and the queue is capped at
 * `maxPending` (oldest dropped) so a noisy session cannot unbounded-grow it.
 */
export function addCandidate(candidate, { maxPending = CAPTURE_LIMITS.maxPending } = {}) {
  const queue = readCaptureQueue();
  const stem = errorStem(candidate.errorText);
  const twin = queue.pending.find((item) => item.tool === candidate.tool && errorStem(item.errorText) === stem);
  if (twin) {
    // Refresh the payload with the newest occurrence so the panel shows the
    // latest failure/correction instead of the first one forever.
    twin.count = (twin.count ?? 1) + 1;
    twin.lastAt = candidate.createdAt;
    twin.title = candidate.title;
    twin.summary = candidate.summary;
    twin.body = candidate.body;
    twin.errorText = candidate.errorText;
    twin.evidence = candidate.evidence;
    twin.workspace = candidate.workspace;
    twin.reason = candidate.reason;
    twin.corrections = candidate.corrections;
    twin.failedAt = candidate.failedAt;
    twin.recoveredAt = candidate.recoveredAt;
    twin.attempts = candidate.attempts;
    writeCaptureQueue(queue);
    return twin;
  }
  queue.pending.push({ ...candidate, count: 1 });
  while (queue.pending.length > Math.max(1, maxPending)) queue.pending.shift();
  writeCaptureQueue(queue);
  return candidate;
}

/** First meaningful line of an error, used for title/summary and dedupe. */
export function errorStem(text) {
  const first = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";
  return first.slice(0, 120);
}

/** Best-effort text of a failed tool result (content parts, value, error). */
export function extractErrorText(result, errorChars = CAPTURE_LIMITS.errorChars) {
  if (!result || typeof result !== "object") return "";
  const parts = [];
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (part && typeof part.text === "string") parts.push(part.text);
      else if (part && typeof part.value === "string") parts.push(part.value);
    }
  }
  if (parts.length === 0 && typeof result.value === "string") parts.push(result.value);
  if (parts.length === 0 && result.error) {
    parts.push(String(result.error.message ?? result.error));
  }
  const text = parts.join("\n").replace(/[ \t]+$/gm, "").trim();
  return text.slice(0, errorChars);
}

function agentKey(exec) {
  try {
    const agent = exec && exec.agent;
    if (!agent) return "global";
    return String(agent.id ?? agent.name ?? "agent");
  } catch (err) {
    return "global";
  }
}

function toolName(exec) {
  try {
    return typeof exec?.name === "string" ? exec.name : "";
  } catch (err) {
    return "";
  }
}

/**
 * Watch tool results and report a failure-then-success pair.
 *
 * `tools/result` is an observation event (results are frozen, observers cannot
 * change them), which is exactly what capture needs: record failures without
 * ever touching the model-visible output.
 */
export function createCaptureTracker({ forgetAfterMs = CAPTURE_LIMITS.forgetAfterMs } = {}) {
  /** `${agentKey}::${tool}` -> { tool, errorText, at } */
  const failures = new Map();

  function forgetStale(now) {
    for (const [key, failure] of failures) {
      if (now - failure.at > forgetAfterMs) failures.delete(key);
    }
  }

  return {
    /** @returns {{tool: string, errorText: string, failedAt: number, recoveredAt: number} | null} */
    observe(exec, result, now = Date.now()) {
      const name = toolName(exec);
      if (name === "") return null;
      // Never capture our own tools: accepting a candidate would otherwise
      // record the capture tool's own failures, recursively.
      if (name.startsWith("lattice_")) return null;
      const key = `${agentKey(exec)}::${name}`;
      if (result && result.isError === true) {
        const text = extractErrorText(result);
        if (text === "") return null;
        forgetStale(now);
        failures.set(key, { tool: name, errorText: text, at: now });
        return null;
      }
      const failure = (() => {
        forgetStale(now);
        return failures.get(key);
      })();
      if (!failure) return null;
      failures.delete(key);
      return { tool: name, errorText: failure.errorText, failedAt: failure.at, recoveredAt: now };
    },

    /** Drop every remembered failure (used by the tests). */
    reset() {
      failures.clear();
    },
  };
}

function clip(text, max) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * Build the pending candidate shown by `lattice_capture list`.
 * The fix itself is intentionally left for the model: capture can prove that a
 * retry worked, not why.
 */
export function buildCandidate({ hit, dims = {}, workspace = "", now = Date.now() }) {
  const stem = errorStem(hit.errorText) || "unknown tool error";
  const title = `自动捕获：${hit.tool} 先失败、后成功（待补充修复步骤）`;
  const summary = clip(`${hit.tool}: ${stem}`, 160);
  const body = [
    `自动捕获（M6 半自动）：工具 \`${hit.tool}\` 在本轮里先失败、之后重试成功。`,
    "",
    "## 失败信息",
    "",
    "```",
    hit.errorText,
    "```",
    "",
    "## 待补充",
    "",
    "- 重试成功的原因 / 改变了什么（自动捕获无法判断）",
    "- 相关文件、命令或行号证据",
    "",
    "## 建议的验收口径",
    "",
    "- 接受后按实际情况改写标题与正文，再用 `lattice_verify` 补充证据并提升状态。",
  ].join("\n");
  const evidence = [`run:${hit.tool} (auto-captured failure-then-success at ${new Date(hit.recoveredAt).toISOString()})`];
  if (workspace.trim() !== "") evidence.push(`file:${workspace}`);
  return {
    id: `capture-${now}-${Math.random().toString(36).slice(2, 7)}`,
    kind: "gotcha",
    title,
    summary,
    body,
    feature: "debugging",
    dims: dims && typeof dims === "object" ? dims : {},
    evidence,
    tool: hit.tool,
    errorText: hit.errorText,
    workspace: String(workspace ?? ""),
    createdAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* M7: full-automatic capture — failure chains and user corrections    */
/* ------------------------------------------------------------------ */

/**
 * Phrases that usually mark a human correction ("no, it should be …").
 * Only used to ANNOTATE an already-open incident, never to invent one, so a
 * false positive costs a line of context instead of a bogus memory.
 */
const CORRECTION_HINTS = [
  "不对", "不是这样", "错了", "错误", "应该", "改成", "换成", "重新", "有问题",
  "注意", "其实", "正确", "别用", "不要用", "不能用", "换一种", "不是这个",
  "wrong", "incorrect", "should be", "instead", "doesn't work", "does not work", "fix",
];

export function looksLikeCorrection(text) {
  const value = String(text ?? "").toLowerCase();
  if (value.trim() === "") return false;
  return CORRECTION_HINTS.some((hint) => value.includes(hint));
}

/** Plain text of a DSH user message (string content or text content blocks). */
export function messageText(message) {
  try {
    const content = message && message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((block) => (block && typeof block.text === "string" ? block.text : ""))
        .filter((text) => text !== "")
        .join("\n");
    }
  } catch {
    /* malformed message */
  }
  return "";
}

/**
 * Per-session incident tracker for M7.
 *
 * - `recordTool` records every non-`lattice_*` tool outcome; a failure opens an
 *   incident (one per tool), a later success of that tool closes it. A success
 *   of ANY tool also closes incidents that a user correction pointed at.
 * - `userMessage` attaches a correction quote to the most recent open incident.
 * - `endTurn` closes what the turn proved: incidents whose tool succeeded later
 *   in the same turn, plus corrected incidents; unrecovered incidents are
 *   dropped (a failure nobody fixed is not a lesson).
 */
export function createSessionCaptureTracker({
  forgetAfterMs = CAPTURE_LIMITS.forgetAfterMs,
  maxIncidents = 3,
  maxAttempts = 12,
} = {}) {
  /** sessionKey -> { incidents: Map<tool, incident>, order: string[], attempts: [] } */
  const sessions = new Map();

  function stateFor(sessionKey, now) {
    let state = sessions.get(sessionKey);
    if (!state) {
      state = { incidents: new Map(), order: [], attempts: [] };
      sessions.set(sessionKey, state);
    }
    for (const [tool, incident] of state.incidents) {
      if (now - incident.at > forgetAfterMs) {
        state.incidents.delete(tool);
        state.order = state.order.filter((item) => item !== tool);
      }
    }
    if (state.attempts.length > maxAttempts) state.attempts = state.attempts.slice(-maxAttempts);
    return state;
  }

  function close(state, tool, incident, recoveredAt, reason) {
    state.incidents.delete(tool);
    state.order = state.order.filter((item) => item !== tool);
    return { ...incident, recoveredAt, reason };
  }

  return {
    /** @returns {{recovered: object[]}} incidents proven fixed by this result */
    recordTool({ sessionKey, tool, isError, errorText = "", now = Date.now() }) {
      const state = stateFor(sessionKey, now);
      const name = String(tool ?? "");
      if (name === "" || name.startsWith("lattice_")) return { recovered: [] };
      state.attempts.push({ tool: name, isError: Boolean(isError), at: now });
      if (isError) {
        const text = String(errorText ?? "").trim();
        if (text === "") return { recovered: [] };
        const existing = state.incidents.get(name);
        if (existing) {
          existing.errorText = text;
          existing.at = now;
          existing.count += 1;
          return { recovered: [] };
        }
        state.incidents.set(name, { tool: name, errorText: text, at: now, count: 1, corrections: [] });
        state.order.push(name);
        while (state.order.length > maxIncidents) {
          const oldest = state.order.shift();
          state.incidents.delete(oldest);
        }
        return { recovered: [] };
      }
      const recovered = [];
      if (state.incidents.has(name)) {
        const incident = state.incidents.get(name);
        recovered.push(close(state, name, incident, now, incident.corrections.length > 0 ? "user-correction" : "retry-success"));
      }
      for (const tool of [...state.order]) {
        const incident = state.incidents.get(tool);
        if (!incident || incident.corrections.length === 0) continue;
        recovered.push(close(state, tool, incident, now, "user-correction"));
      }
      return { recovered };
    },

    /** @returns {boolean} whether the text was attached to an open incident */
    userMessage({ sessionKey, text, now = Date.now() }) {
      const state = stateFor(sessionKey, now);
      if (!looksLikeCorrection(text)) return false;
      const tool = state.order[state.order.length - 1];
      const incident = tool ? state.incidents.get(tool) : undefined;
      if (!incident) return false;
      if (incident.corrections.length < 3) incident.corrections.push(clip(messageText({ content: text }), 240));
      return true;
    },

    /** @returns {object[]} incidents worth capturing when the turn ends */
    endTurn({ sessionKey, now = Date.now() }) {
      const state = sessions.get(sessionKey);
      if (!state) return [];
      const recovered = [];
      for (const tool of [...state.order]) {
        const incident = state.incidents.get(tool);
        if (!incident) continue;
        // A corrected incident is worth capturing even if no later success proved
        // the fix (the human explicitly said something was wrong).
        if (incident.corrections.length > 0) {
          recovered.push(close(state, tool, incident, now, "user-correction"));
          continue;
        }
        // No correction yet: the human usually corrects in a *later* turn, after
        // the assistant stops, so keep the incident alive until it goes stale.
        // A failure nobody corrected and nobody recovered is dropped after the
        // retention window instead of being memorized as a lesson.
        if (now - incident.at > forgetAfterMs) {
          state.incidents.delete(tool);
          state.order = state.order.filter((item) => item !== tool);
        }
      }
      state.attempts = [];
      return recovered;
    },

    reset() {
      sessions.clear();
    },
  };
}

/** Best-effort "which file/path is this about" from an error message. */
export function targetOf(errorText, maxLength = 54) {
  const text = typeof errorText === "string" ? errorText : "";
  const quoted = text.match(/["'`]([^"'`\r\n]{2,200})["'`]/);
  const absolute = text.match(/[A-Za-z]:\\[^\s"'`\r\n]+/);
  const unix = text.match(/(?:^|\s)(\/[^\s"'`\r\n]{3,200})/);
  const candidate = (quoted && quoted[1]) || (absolute && absolute[0]) || (unix && unix[1]) || "";
  if (candidate === "") return "";
  const normalized = candidate.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((part) => part !== "");
  const short = parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : normalized;
  return short.length > maxLength ? `…${short.slice(-(maxLength - 1))}` : short;
}

/** Candidate for an M7 incident (tool chain and/or user correction). */
export function buildIncidentCandidate({ incident, dims = {}, workspace = "", now = Date.now() }) {
  const stem = errorStem(incident.errorText) || "unknown tool error";
  const target = targetOf(incident.errorText);
  const about = target === "" ? "" : `「${target}」`;
  const corrected = incident.reason === "user-correction" && incident.corrections.length > 0;
  const title = corrected
    ? `自动捕获：用户纠正后 ${incident.tool} 才成功${target === "" ? "" : `（${target}）`}`
    : incident.reason === "turn-end"
      ? `自动捕获：${incident.tool}${about}本轮失败后找回`
      : `自动捕获：${incident.tool}${about}先失败、后成功`;
  const body = [
    `自动捕获（M7 全自动）：工具 \`${incident.tool}\` 在本轮里失败，${corrected ? "用户给出纠正后" : "之后重试"}成功。`,
    "",
    "## 失败信息",
    "",
    "```",
    incident.errorText,
    "```",
    "",
    "## 时间线",
    "",
    `- 失败：${new Date(incident.failedAt).toISOString()}`,
    `- ${corrected ? "用户纠正" : "恢复"}：${new Date(incident.recoveredAt).toISOString()}`,
    `- 尝试次数：${incident.attempts || 1}`,
    `- 工作区：${workspace.trim() === "" ? "（未识别）" : workspace}`,
  ];
  if (target !== "") body.push(`- 涉及目标：${target}`);
  if (corrected) {
    body.push("", "## 用户纠正", "");
    for (const correction of incident.corrections) body.push(`> ${correction}`, "");
  }
  body.push(
    "",
    "## 待补充",
    "",
    `- ${corrected ? "用户纠正后实际改了什么" : "重试成功的原因 / 改变了什么"}（自动捕获无法判断）`,
    "- 相关文件、命令或行号证据",
    "- 下次遇到同类错误时应采取的正确做法",
    "",
    "## 建议的验收口径",
    "",
    "- 按实际情况改写标题与正文，再用 `lattice_verify` 补充证据并提升状态。",
  );
  const evidence = [`run:${incident.tool} (auto-captured ${corrected ? "user-correction" : "failure-then-success"} at ${new Date(incident.recoveredAt).toISOString()})`];
  if (corrected) evidence.push("run:user-correction (quoted in the body)");
  if (workspace.trim() !== "") evidence.push(`file:${workspace}`);
  return {
    id: `capture-${now}-${Math.random().toString(36).slice(2, 7)}`,
    kind: "gotcha",
    title,
    summary: clip(`${incident.tool}${about}: ${stem}`, 160),
    body: body.join("\n"),
    feature: "debugging",
    dims: dims && typeof dims === "object" ? dims : {},
    evidence,
    tool: incident.tool,
    errorText: incident.errorText,
    corrections: incident.corrections,
    reason: incident.reason,
    workspace: String(workspace ?? ""),
    failedAt: incident.failedAt,
    recoveredAt: incident.recoveredAt,
    attempts: incident.attempts || 1,
    createdAt: now,
  };
}
