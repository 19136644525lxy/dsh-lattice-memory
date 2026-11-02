/**
 * Lattice (dsh-lattice-memory) — host half.
 *
 * Cross-project, version-aware project memory for DSH. Current scope (M0–M8):
 *   - bundle skeleton + schemastery Config;
 *   - library root state (`<DSH_HOME>/lattice/root.json`) and validation;
 *   - first-run onboarding: web routes for the client card + `lattice_setup`;
 *   - tools: lattice_status / lattice_profile / lattice_setup / lattice_search /
 *     lattice_get / lattice_list / lattice_matrix / lattice_gaps / lattice_brief /
 *     lattice_record / lattice_verify / lattice_lint / lattice_export /
 *     lattice_import / lattice_capture / lattice_check_update;
 *   - resident brief injection: a token-budgeted index of the entries that are
 *     applicable to the calling agent's workspace, so the model sees the
 *     memory without having to remember to search;
 *   - optional project overlay (`<workspace>/.lattice`) merged over the shared
 *     library;
 *   - write path: draft recording with evidence, secret scanning, near-duplicate
 *     refusal, promotion to verified, and a lint report (stale / duplicates /
 *     missing evidence / leaked credentials);
 *   - portable export (JSON / SKILL.md / AGENTS.md snippet) and merge-planned
 *     import with dry-run;
 *   - automatic capture (M7): tool failures are paired with their later fix and
 *     with human corrections from `session/event`; recovered incidents become
 *     `lattice_capture` candidates (or drafts, per `capture.mode`);
 *   - panel routes for the settings UI: entries browse/search, entry detail,
 *     matrix grid, export, import and background image;
 *   - update check: `lattice_check_update` / panel route read the GitHub raw
 *     `package.json` and compare versions (report only; installation stays manual).
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  defaultRoot,
  dshHome,
  ensureLibraryRoot,
  inspectLibraryRoot,
  persistRoot,
  readStoredRoot,
  stateDir,
  validateRoot,
} from "./state.js";
import { detectProject } from "./detect.js";
import {
  CONFIDENCE_LEVELS,
  ENTRY_KINDS,
  ENTRY_STATUSES,
  clearEntriesCache,
  getEntryMerged,
  isEntryId,
  loadEntries,
  loadEntriesMerged,
  normalizeEntry,
  saveEntry,
  slugify,
} from "./entries.js";
import { rankEntries } from "./search.js";
import { parseDocument } from "./frontmatter.js";
import { buildMatrix, findGaps } from "./matrix.js";
import { buildBrief } from "./brief.js";
import { findSimilar, isoDate, lintReport, scanSecrets } from "./write.js";
import { matchProject, readProjects } from "./projects.js";
import { exportAgents, exportJson, exportSkill, filterEntries, planImport } from "./portable.js";
import {
  BACKGROUND_LIMITS,
  clearBackground,
  readBackgroundBytes,
  readBackgroundMeta,
  saveBackgroundDataUrl,
} from "./background.js";
import {
  CAPTURE_LIMITS,
  addCandidate,
  buildIncidentCandidate,
  createSessionCaptureTracker,
  extractErrorText,
  listCandidates,
  messageText,
  removeCandidates,
} from "./capture.js";
import {
  DEFAULT_KEEP,
  PLUGIN_ROOT,
  createBackup,
  defaultBackupDir,
  listBackups,
  pluginInstallDir,
  pluginPackageDir,
  resolveBackupDir,
  restoreBackup,
} from "./backup.js";

export const name = "dsh-lattice-memory";

/** Mount as soon as the tool registry exists; other services are optional. */
export const inject = ["tools"];

const SECTION_NAME = "dsh-lattice-memory";
const API_PANEL = "/lattice-panel";
const PANEL_ENDPOINTS = ["version", "state", "setup", "entries", "entry", "matrix", "export", "import", "compose", "background", "captures", "clear", "delete", "backup", "restore", "pick-directory", "update"];
const PANEL_VERSION = "0.1.0-m5";
const API_STATE = API_PANEL + "/state";
const API_SETUP = API_PANEL + "/setup";
const API_VERSION = API_PANEL + "/version";
const API_ENTRIES = API_PANEL + "/entries";
const API_ENTRY = API_PANEL + "/entry";
const API_MATRIX = API_PANEL + "/matrix";
const API_EXPORT = API_PANEL + "/export";
const API_IMPORT = API_PANEL + "/import";
const API_COMPOSE = API_PANEL + "/compose";
const API_BACKGROUND = API_PANEL + "/background";
const API_CAPTURES = API_PANEL + "/captures";
const API_CLEAR = API_PANEL + "/clear";
const API_DELETE = API_PANEL + "/delete";
const API_BACKUP = API_PANEL + "/backup";
const API_RESTORE = API_PANEL + "/restore";
const API_PICK_DIRECTORY = API_PANEL + "/pick-directory";
const API_UPDATE = API_PANEL + "/update";
const BODY_LIMIT = 8 * 1024;
const PANEL_BODY_LIMIT = 256 * 1024;
const UPDATE_TIMEOUT_MS = 8000;

/** Defaults kept in one place: schema defaults, direct-call defaults, docs. */
const DEFAULTS = Object.freeze({
  topK: 8,
  maxTokens: 1500,
  staleDays: 180,
  similarityThreshold: 0.85,
  repo: "19136644525lxy/dsh-lattice-memory",
  branch: "main",
});

/**
 * Loader-row Config. Users tune it from their profile's cordis.patch.yml:
 *
 *   - id: lattice
 *     config:
 *       root: "D:/Lattice"
 *
 * A `root` set here wins over the onboarding result. Everything else carries
 * defaults, so an empty config is valid.
 */
export const Config = z
  .object({
    root: z
      .string()
      .default("")
      .description("Absolute library root. Empty = use the folder picked in the first-run card."),
    onboarding: z
      .boolean()
      .default(true)
      .description("Show the first-run setup card in the web UI while no library root is configured."),
    debug: z
      .boolean()
      .default(false)
      .description("Write onboarding route diagnostics to <stateDir>/route-debug.log."),
    inject: z
      .object({
        enabled: z.boolean().default(true).description("Inject a small resident index of applicable entries into the prompt."),
        topK: z.number().step(1).min(1).default(DEFAULTS.topK).description("Maximum entries in the resident index."),
        maxTokens: z.number().step(1).min(0).default(DEFAULTS.maxTokens).description("Token budget of the resident index."),
      })
      .default({}),
    projectOverlay: z
      .boolean()
      .default(false)
      .description("Also read <workspace>/.lattice overlay entries (they win over the shared library by id)."),
    staleDays: z
      .number()
      .step(1)
      .min(0)
      .default(DEFAULTS.staleDays)
      .description("Days after verified_on before an entry is reported stale."),
    readOnly: z
      .boolean()
      .default(false)
      .description("Refuse all writes: lattice_record/lattice_verify report read-only and change nothing."),
    record: z
      .object({
        requireEvidence: z
          .boolean()
          .default(true)
          .description("Refuse lattice_record/lattice_verify calls that carry no evidence."),
      })
      .default({}),
    lint: z
      .object({
        similarityThreshold: z
          .number()
          .step(0.01)
          .min(0)
          .max(1)
          .default(DEFAULTS.similarityThreshold)
          .description("Jaccard similarity at or above which two entries count as near-duplicates."),
      })
      .default({}),
    capture: z
      .object({
        enabled: z
          .boolean()
          .default(true)
          .description("Watch tool results, human corrections and turn ends to propose memory candidates (M6/M7)."),
        mode: z
          .union([z.const("notify"), z.const("draft"), z.const("auto")])
          .default("notify")
          .description(
            'notify = queue candidates until lattice_capture accepts them; draft/auto = write a draft entry immediately. In "auto" mode the failure -> fix chain plus any human correction is captured at turn end.',
          ),
        maxPending: z
          .number()
          .step(1)
          .min(1)
          .default(CAPTURE_LIMITS.maxPending)
          .description("How many pending capture candidates to keep (oldest dropped)."),
        detectUserCorrections: z
          .boolean()
          .default(true)
          .description("Attach human correction messages to the open tool-failure incident of the same session (M7)."),
        incidentMinutes: z
          .number()
          .step(1)
          .min(1)
          .default(10)
          .description("How long a failure stays open waiting for the fix that proves it recoverable (M7)."),
      })
      .default({}),
    backup: z
      .object({
        dir: z
          .string()
          .default("")
          .description(
            "Backup destination. Empty = <plugin root>/backups; relative paths resolve against the plugin root.",
          ),
        keep: z
          .number()
          .step(1)
          .min(1)
          .default(DEFAULT_KEEP)
          .description("How many newest backups to keep in the destination directory (older ones are pruned)."),
      })
      .default({}),
    update: z
      .object({
        repo: z
          .string()
          .default(DEFAULTS.repo)
          .description("GitHub owner/repo that hosts the plugin (used by lattice_check_update and the panel)."),
        branch: z
          .string()
          .default(DEFAULTS.branch)
          .description("Branch whose package.json is read for the version check."),
      })
      .default({}),
  })
  .description("Lattice configuration.");

/**
 * Normalize the Loader-validated config (also used when the host mounts the
 * plugin directly, bypassing schema validation).
 */
function resolveConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const injected = value.inject && typeof value.inject === "object" ? value.inject : {};
  const wholeNumber = (input, fallback, minimum) => {
    const number = Number(input);
    return Number.isFinite(number) && number >= minimum ? Math.floor(number) : fallback;
  };
  return {
    root: typeof value.root === "string" ? value.root.trim() : "",
    onboarding: value.onboarding !== false,
    debug: value.debug === true,
    inject: {
      enabled: injected.enabled !== false,
      topK: wholeNumber(injected.topK, DEFAULTS.topK, 1),
      maxTokens: wholeNumber(injected.maxTokens, DEFAULTS.maxTokens, 0),
    },
    projectOverlay: value.projectOverlay === true,
    staleDays: wholeNumber(value.staleDays, DEFAULTS.staleDays, 0),
    readOnly: value.readOnly === true,
    record: {
      requireEvidence: !(value.record && typeof value.record === "object" && value.record.requireEvidence === false),
    },
    lint: {
      similarityThreshold: (() => {
        const threshold = Number(value.lint && typeof value.lint === "object" ? value.lint.similarityThreshold : undefined);
        return Number.isFinite(threshold) && threshold >= 0 && threshold <= 1 ? threshold : DEFAULTS.similarityThreshold;
      })(),
    },
    capture: {
      enabled: !(value.capture && typeof value.capture === "object" && value.capture.enabled === false),
      mode: (() => {
        const mode = value.capture && typeof value.capture === "object" ? String(value.capture.mode ?? "") : "";
        return mode === "draft" || mode === "auto" ? mode : "notify";
      })(),
      maxPending: wholeNumber(
        value.capture && typeof value.capture === "object" ? value.capture.maxPending : undefined,
        CAPTURE_LIMITS.maxPending,
        1,
      ),
      detectUserCorrections: !(
        value.capture && typeof value.capture === "object" && value.capture.detectUserCorrections === false
      ),
      incidentMinutes: wholeNumber(
        value.capture && typeof value.capture === "object" ? value.capture.incidentMinutes : undefined,
        10,
        1,
      ),
    },
    backup: {
      dir:
        value.backup && typeof value.backup === "object" && typeof value.backup.dir === "string"
          ? value.backup.dir.trim()
          : "",
      keep: wholeNumber(
        value.backup && typeof value.backup === "object" ? value.backup.keep : undefined,
        DEFAULT_KEEP,
        1,
      ),
    },
    update: {
      repo: (() => {
        const repo = value.update && typeof value.update === "object" ? String(value.update.repo ?? "").trim() : "";
        return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : DEFAULTS.repo;
      })(),
      branch: (() => {
        const branch =
          value.update && typeof value.update === "object" ? String(value.update.branch ?? "").trim() : "";
        return branch === "" ? DEFAULTS.branch : branch;
      })(),
    },
  };
}

/** The library root in effect: explicit config first, onboarding result second. */
function resolveActiveRoot(config) {
  if (config.root !== "") {
    const checked = validateRoot(config.root);
    if (checked.ok) return { root: checked.root, source: "config" };
  }
  const stored = readStoredRoot();
  if (stored.root !== null) {
    const checked = validateRoot(stored.root);
    if (checked.ok) return { root: checked.root, source: stored.source ?? "stored" };
  }
  return { root: null, source: null };
}

/** The per-project overlay root of a workspace, when the feature is enabled. */
function overlayRootOf(config, workspace) {
  if (!config.projectOverlay || typeof workspace !== "string" || workspace.trim() === "") return null;
  return join(workspace.trim(), ".lattice");
}

/** Entries a read path should see: shared library plus optional overlay. */
function loadLibrary(config, workspace, toolName) {
  const root = activeRootOrThrow(config, toolName);
  const overlayRoot = overlayRootOf(config, workspace);
  return { root, overlayRoot, ...loadEntriesMerged(root, overlayRoot) };
}

/** The calling agent's workspace directory (sync; used by the prompt section). */
function workspaceFromContext(context) {
  try {
    const cwd = context && context.agent && context.agent.session && context.agent.session.header
      ? context.agent.session.header.cwd
      : undefined;
    return typeof cwd === "string" && cwd.trim() !== "" ? cwd : process.cwd();
  } catch (err) {
    return process.cwd();
  }
}

/** Snapshot used by both the `lattice_status` tool and GET /lattice/state. */
function stateSnapshot(config) {
  const active = resolveActiveRoot(config);
  const library = active.root === null ? null : inspectLibraryRoot(active.root);
  return {
    ok: true,
    dshHome: dshHome(),
    stateDir: stateDir(),
    defaultRoot: defaultRoot(),
    configured: active.root !== null,
    root: active.root ?? "",
    rootSource: active.source ?? "",
    isLibrary: library === null ? false : library.isLibrary,
    entries: library === null ? 0 : library.entries,
    onboarding: config.onboarding,
    background: readBackgroundMeta(),
    config,
  };
}

/**
 * Perform first-run setup: validate, initialize (idempotent), remember.
 * @returns {{ok: true, root: string, source: string, created: boolean, tookOver: boolean, entries: number}
 *   | {ok: false, code: string, message: string}}
 */
function applySetup(config, request) {
  const input = request && typeof request === "object" ? request : {};
  const action = typeof input.action === "string" ? input.action : input.useDefault === true ? "default" : "set";
  const candidate = action === "default" ? defaultRoot() : input.path;
  if (typeof candidate !== "string" || candidate.trim() === "") {
    return {
      ok: false,
      code: "missing-path",
      message: "path is required; pass the folder the user picked, or use_default=true for the default location",
    };
  }
  const checked = validateRoot(candidate);
  if (!checked.ok) return { ok: false, code: checked.code, message: checked.message };
  const before = inspectLibraryRoot(checked.root);
  let library;
  try {
    library = ensureLibraryRoot(checked.root);
  } catch (err) {
    return {
      ok: false,
      code: "initialize-failed",
      message: `cannot initialize ${checked.root}: ${(err && err.message) || err}`,
    };
  }
  persistRoot(checked.root, action === "default" ? "default" : "user");
  const after = inspectLibraryRoot(checked.root);
  return {
    ok: true,
    root: checked.root,
    source: action === "default" ? "default" : "user",
    created: !before.isLibrary,
    tookOver: before.isLibrary,
    entries: after.entries,
  };
}

/** The configured library root, or a model-readable error. */
function activeRootOrThrow(config, toolName) {
  const active = resolveActiveRoot(config);
  if (active.root === null) {
    throw new Error(
      `${toolName}: the Lattice library is not configured yet. Ask the user to finish the first-run card, or call lattice_setup with the folder they picked.`,
    );
  }
  return active.root;
}

/** Parse a "a,b,c" parameter into a lowercase list. */
function parseCsv(value) {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== "");
}

/** Stable short suffix for auto-generated ids: re-recording the same title yields the same id (and collides visibly). */
function hashSuffix(text) {
  let hash = 5381;
  for (const char of String(text)) hash = ((hash * 33) ^ char.codePointAt(0)) >>> 0;
  return hash.toString(36).padStart(6, "0").slice(-6);
}

/** Parse the `dims` JSON parameter; `null` means "detect from the workspace". */
function parseDimsJson(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    throw new Error(`invalid dims JSON: ${(err && err.message) || err}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error('dims must be a JSON object such as {"mcver":"1.20.1","loader":"forge"}');
  }
  const dims = {};
  for (const [key, raw] of Object.entries(parsed)) {
    if (raw === null || raw === undefined) continue;
    const values = Array.isArray(raw) ? raw.map((item) => String(item).trim()).filter(Boolean) : [String(raw).trim()];
    if (values.length === 0 || (values.length === 1 && values[0] === "")) continue;
    dims[String(key)] = values.length === 1 ? values[0] : values;
  }
  return dims;
}

/** Compact JSON hit shape: enough to decide, not the whole body. */
function hitJson(hit) {
  const entry = hit.entry;
  return {
    id: entry.id,
    title: entry.title,
    kind: entry.kind,
    status: entry.status,
    confidence: entry.confidence,
    feature: entry.feature,
    dims: entry.dims,
    verified_on: entry.verified_on,
    score: Number(hit.score.toFixed(4)),
    bm25: Number(hit.bm25.toFixed(4)),
    applicable: hit.applicable,
    dim_notes: hit.dims.notes,
    summary: entry.summary === "" ? "" : entry.summary.slice(0, 240),
    file: entry.file,
  };
}

/**
 * Resident prompt section: short, stable, cheap to re-render per step.
 * Renders a token-budgeted index of the entries applicable to the calling
 * agent's workspace (M2), or the first-run hint while unconfigured.
 */
function renderPromptSection(config, context) {
  let active;
  try {
    active = resolveActiveRoot(config);
  } catch (err) {
    active = { root: null, source: null };
  }
  if (active.root === null) {
    return [
      "Lattice (dsh-lattice-memory) is installed but has no shared memory library yet.",
      "First-run setup: the Lattice card in the web UI lets the user pick the library folder; programmatic setup is `lattice_setup` (path=...), and `use_default=true` uses the default location.",
      "Until a root is configured, do not claim to have recalled project memory — there is none.",
    ].join("\n");
  }
  try {
    const workspace = workspaceFromContext(context);
    const detected = detectForWorkspace(config, workspace);
    const loaded = loadEntriesMerged(active.root, overlayRootOf(config, workspace));
    const lines = [];
    lines.push(`Lattice is active; shared library: ${active.root} (${loaded.entries.length} valid entries).`);
    if (config.inject.enabled) {
      const brief = buildBrief(loaded.entries, {
        dims: detected.dims,
        topK: config.inject.topK,
        maxTokens: config.inject.maxTokens,
        halfLifeDays: config.staleDays,
        overlayCount: loaded.overlay,
      });
      lines.push(brief.text);
    } else {
      lines.push(
        "Resident index is disabled (inject.enabled=false): call lattice_profile, then lattice_search before version-sensitive work.",
      );
    }
    if (loaded.problems.length > 0) {
      lines.push(`${loaded.problems.length} entry file(s) failed validation and were skipped; inspect <library>/entries.`);
    }
    if (config.capture.enabled) {
      try {
        const pending = listCandidates();
        if (pending.length > 0) {
          lines.push(
            `Memory capture (M7): ${pending.length} pending candidate(s) from recent tool failures / human corrections — nothing is stored yet. Call lattice_capture(action="list") to inspect them, then action="accept" (optionally with title/kind/feature/summary/body/evidence) or action="discard".`,
          );
        }
      } catch (err) {
        /* the notice must never break the prompt */
      }
    }
    return lines.join("\n");
  } catch (err) {
    return `Lattice is active at ${active.root}, but the resident brief could not be built (${(err && err.message) || err}); call lattice_search directly.`;
  }
}

/** Projection for defineTool's `output.render` (canonical value is structured). */
const textRender = (render) => (_args, value) => [{ type: "text", text: render(value) }];

// ── Tools ────────────────────────────────────────────────────────────────

function setupTool(config) {
  return defineTool({
    name: "lattice_setup",
    description:
      "Configure the shared Lattice memory library root (first-run setup). Creates entries/, projects.json and a .lattice-root.json marker inside the chosen folder; an existing Lattice library is taken over without touching its contents, and an unrelated non-empty folder is initialized in place. Pass the folder the user picked, or use_default=true for the default location. Idempotent.",
    parameters: {
      path: {
        type: "string",
        description: "Folder to use as the shared Lattice library (absolute path recommended; relative resolves against the host cwd).",
      },
      use_default: {
        type: "boolean",
        description: "Use the default library location (<DSH_HOME>/lattice-library) instead of path.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true, description: "Always true on success (errors throw)." },
          root: { type: "string", required: true, description: "The absolute library root now in effect." },
          source: { type: "string", required: true, description: "user | default — where the root came from." },
          created: { type: "boolean", required: true, description: "True when this call initialized a brand-new library." },
          took_over: { type: "boolean", required: true, description: "True when an existing Lattice library was taken over as-is." },
          entries: { type: "number", required: true, description: "Markdown entries currently in the library." },
        },
      },
      render: textRender(
        (value) =>
          `Lattice library ready: ${value.root} (${value.entries} entries; ${
            value.created ? "initialized now" : value.took_over ? "existing library taken over" : "already initialized"
          }).`,
      ),
    },
    execute: async (args) => {
      const outcome = applySetup(config, { path: args.path, useDefault: args.use_default === true });
      if (!outcome.ok) throw new Error(`lattice_setup: ${outcome.message}`);
      return {
        ok: outcome.ok,
        root: outcome.root,
        source: outcome.source,
        created: outcome.created,
        took_over: outcome.tookOver,
        entries: outcome.entries,
      };
    },
  });
}

function statusTool(config) {
  return defineTool({
    name: "lattice_status",
    description:
      "Report the Lattice plugin status: whether a library root is configured, where it lives, how many entries it holds, and the effective deployment config. Use this to diagnose first-run setup or a misconfigured profile.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true, description: "Always true." },
          configured: { type: "boolean", required: true, description: "Whether a library root is in effect." },
          root: { type: "string", required: true, description: "Absolute library root, or empty when unconfigured." },
          root_source: { type: "string", required: true, description: "config | user | default | stored — provenance of root." },
          is_library: { type: "boolean", required: true, description: "Whether the root holds a Lattice marker file." },
          entries: { type: "number", required: true, description: "Markdown entries in the library." },
          default_root: { type: "string", required: true, description: "Default location offered by first-run setup." },
          state_dir: { type: "string", required: true, description: "Plugin state directory (root.json lives here)." },
          onboarding: { type: "boolean", required: true, description: "Whether the first-run card is enabled." },
          overlay: { type: "boolean", required: true, description: "Whether <workspace>/.lattice overlay entries are merged." },
          top_k: { type: "number", required: true, description: "Configured resident entries." },
          max_tokens: { type: "number", required: true, description: "Configured resident token budget." },
          stale_days: { type: "number", required: true, description: "Entry staleness threshold in days." },
          read_only: { type: "boolean", required: true, description: "Whether writes (record/verify) are refused." },
        },
      },
      render: textRender((value) =>
        [
          `Lattice: ${value.configured ? `library at ${value.root}` : "not configured"}`,
          `configured=${value.configured} is_library=${value.is_library} entries=${value.entries} root_source=${value.root_source || "-"}`,
          `default_root=${value.default_root}`,
          `state_dir=${value.state_dir}`,
          `inject topK=${value.top_k} maxTokens=${value.max_tokens} staleDays=${value.stale_days}`,
          `overlay=${value.overlay} read_only=${value.read_only}`,
        ].join("\n"),
      ),
    },
    execute: async () => {
      const snapshot = stateSnapshot(config);
      return {
        ok: true,
        configured: snapshot.configured,
        root: snapshot.root,
        root_source: snapshot.rootSource,
        is_library: snapshot.isLibrary,
        entries: snapshot.entries,
        default_root: snapshot.defaultRoot,
        state_dir: snapshot.stateDir,
        onboarding: snapshot.onboarding,
        overlay: config.projectOverlay === true,
        top_k: config.inject.topK,
        max_tokens: config.inject.maxTokens,
        stale_days: config.staleDays,
        read_only: config.readOnly,
      };
    },
  });
}

/**
 * Resolve the workspace to inspect: explicit argument > calling agent's session cwd
 * (`exec.agent` + the `workingDirectory` service) > host process cwd.
 */
async function resolveWorkspace(ctx, exec, explicit) {
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim();
  const directory = ctx?.get?.("workingDirectory") ?? ctx?.workingDirectory;
  if (exec?.agent !== undefined && directory && typeof directory.ensure === "function") {
    try {
      const cwd = await directory.ensure(exec.agent, exec.signal);
      if (typeof cwd === "string" && cwd !== "") return cwd;
    } catch {
      /* fall back to the host process cwd */
    }
  }
  return process.cwd();
}

/**
 * Detect a workspace profile and apply the library's `projects.json` override
 * (M4). Overrides win over every metadata signal; a preset in the override
 * replaces the detected one, dims are merged key by key.
 * @returns {{workspace: string, preset: string, dims: object, signals: string[], source: "detected" | "projects.json"}}
 */
function detectForWorkspace(config, workspace) {
  const detected = detectProject(workspace);
  let override = null;
  try {
    const active = resolveActiveRoot(config);
    if (active.root !== null) override = matchProject(readProjects(active.root), workspace);
  } catch (err) {
    override = null;
  }
  if (override === null) return { ...detected, source: "detected" };
  return {
    workspace: detected.workspace,
    preset: override.preset !== "" ? override.preset : detected.preset,
    dims: { ...detected.dims, ...override.dims },
    signals: [...detected.signals, "projects.json"],
    source: "projects.json",
  };
}

function profileTool(ctx, config) {
  return defineTool({
    name: "lattice_profile",
    description:
      "Detect the calling workspace's project profile from its own metadata (gradle.properties, mods.toml/neoforge.mods.toml/fabric.mod.json, package.json, pyproject.toml, Cargo.toml, AndroidManifest.xml, git branch). Returns a preset name and the dimension map (game/mcver/loader/platform/...) used to filter Lattice memory entries. Without an agent workspace it falls back to the host process cwd; pass path to inspect a different folder.",
    parameters: {
      path: {
        type: "string",
        description: "Workspace folder to inspect; defaults to the calling agent's workspace (host process cwd when no agent).",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workspace: { type: "string", required: true, description: "Absolute folder inspected." },
          preset: { type: "string", required: true, description: "Preset label: minecraft-mod | node-package | python | rust | android | gradle-jvm | generic." },
          dims_json: { type: "string", required: true, description: "Detected dimension map as a JSON object string." },
          signals: { type: "string", required: true, description: "Comma-separated metadata files that produced the detection." },
          source: { type: "string", required: true, description: '"detected" or "projects.json" — projects.json overrides win over metadata detection.' },
        },
      },
      render: textRender((value) =>
        [
          `Lattice profile: preset=${value.preset} workspace=${value.workspace}`,
          `dims: ${value.dims_json}`,
          `signals: ${value.signals || "(none)"}`,
          `source: ${value.source}`,
        ].join("\n"),
      ),
    },
    execute: async (args, exec) => {
      const workspace = await resolveWorkspace(ctx, exec, args.path);
      const detected = detectForWorkspace(config, workspace);
      return {
        workspace: detected.workspace,
        preset: detected.preset,
        dims_json: JSON.stringify(detected.dims),
        signals: detected.signals.join(", "),
        source: detected.source,
      };
    },
  });
}

const SEARCH_MODES = ["prefer", "strict"];

function searchTool(ctx, config) {
  return defineTool({
    name: "lattice_search",
    description:
      "Search the shared Lattice memory library (BM25 over title/feature/tags/dims/body; CJK bigrams supported, so Chinese queries work). Dimension values of the calling workspace are detected automatically, or pass dims as JSON. mode=prefer (default) downweights entries whose dimensions mismatch and flags them as cross-version references; mode=strict excludes them. Follow up with lattice_get to read the full body of a hit.",
    parameters: {
      query: {
        type: "string",
        description: "Keywords, error text or symbol to look for. Combined with feature when both are given.",
      },
      feature: {
        type: "string",
        description: "Feature/capability to focus the query on, e.g. 'potion-effects' or '药水效果'.",
      },
      dims: {
        type: "string",
        description: 'Optional JSON object overriding workspace dimensions, e.g. {"mcver":"1.20.1","loader":"forge"}.',
      },
      workspace: {
        type: "string",
        description: "Workspace folder to detect dimensions from; defaults to the calling agent's workspace (host process cwd when no agent).",
      },
      mode: {
        type: "string",
        description: "prefer (default) | strict — how mismatching dimensions are handled.",
      },
      kinds: {
        type: "string",
        description: "Comma-separated kinds to keep, e.g. contract,gotcha.",
      },
      status: {
        type: "string",
        description: "Comma-separated statuses to keep, e.g. verified,draft.",
      },
      limit: {
        type: "number",
        description: "Maximum hits (default: configured topK).",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", required: true, description: "The query as received." },
          feature: { type: "string", required: true, description: "The feature focus as received (may be empty)." },
          dims_json: { type: "string", required: true, description: "Dimensions used for filtering, as a JSON object string." },
          dims_source: { type: "string", required: true, description: "parameter | workspace:<preset> — where dimensions came from." },
          mode: { type: "string", required: true, description: "prefer | strict." },
          total: { type: "number", required: true, description: "Number of hits returned." },
          hits_json: { type: "string", required: true, description: "JSON array of compact hits (id, title, kind, status, dims, score, applicable, summary, file)." },
          problems: { type: "number", required: true, description: "Entry files skipped because they failed validation." },
          note: { type: "string", required: true, description: "Status or next-step note." },
        },
      },
      render: textRender(
        (value) =>
          [
            `lattice_search "${value.query}"${value.feature ? ` feature=${value.feature}` : ""}: ${value.total} hit(s) [dims ${value.dims_source}, mode ${value.mode}]`,
            value.hits_json === "[]" ? value.note : value.hits_json,
            value.problems > 0 ? `(${value.problems} entry file(s) skipped as invalid)` : "",
          ]
            .filter((line) => line !== "")
            .join("\n"),
      ),
    },
    execute: async (args, exec) => {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const feature = typeof args.feature === "string" ? args.feature.trim() : "";
      if (query === "" && feature === "") throw new Error("lattice_search: pass query and/or feature");
      const requestedMode = typeof args.mode === "string" ? args.mode.trim().toLowerCase() : "";
      const mode = SEARCH_MODES.includes(requestedMode) ? requestedMode : "prefer";
      const workspace = await resolveWorkspace(ctx, exec, args.workspace);
      let dims = parseDimsJson(args.dims);
      let dimsSource = "parameter";
      if (dims === null) {
        const detected = detectForWorkspace(config, workspace);
        dims = detected.dims;
        dimsSource = detected.source === "projects.json" ? `projects:${detected.preset}` : `workspace:${detected.preset}`;
      }
      const loaded = loadLibrary(config, workspace, "lattice_search");
      const limit = Number(args.limit) > 0 ? Number(args.limit) : config.inject.topK;
      const ranked = rankEntries(loaded.entries, [feature, query].filter(Boolean).join(" "), {
        dims,
        mode,
        kinds: parseCsv(args.kinds),
        statuses: parseCsv(args.status),
        limit,
        halfLifeDays: config.staleDays,
      });
      const hits = ranked.map(hitJson);
      const overlayNote = loaded.overlay > 0 ? ` (${loaded.overlay} overlay entries merged from ${loaded.overlayRoot})` : "";
      const dimsDetected = Object.keys(dims).length > 0;
      const baseNote =
        loaded.entries.length === 0
          ? `library ${loaded.root} has no valid entries yet; add Markdown files under ${join(loaded.root, "entries")}.`
          : hits.length === 0
            ? `no entry matched${overlayNote}; try a softer query, drop kinds/status filters, or use mode=prefer to include cross-version references.`
            : `applicable hits describe the detected dimensions; applicable=false means cross-version reference only.${overlayNote}`;
      const note = dimsDetected
        ? baseNote
        : `workspace dimensions not detected, so applicability was not filtered; pass dims for version-aware ranking. ${baseNote}`;
      return {
        query,
        feature,
        dims_json: JSON.stringify(dims),
        dims_source: dimsSource,
        mode,
        total: hits.length,
        hits_json: JSON.stringify(hits),
        problems: loaded.problems.length,
        note,
      };
    },
  });
}

function getTool(ctx, config) {
  return defineTool({
    name: "lattice_get",
    description:
      "Read one Lattice entry in full: YAML frontmatter (typed fields) plus the Markdown body. Use after lattice_search/lattice_list to load the actual contract, steps or gotchas of an entry.",
    parameters: {
      id: {
        type: "string",
        required: true,
        description: "Entry id (frontmatter `id` or the .md filename without extension).",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", required: true, description: "Entry id." },
          found: { type: "boolean", required: true, description: "Always true on success (missing entries throw)." },
          file: { type: "string", required: true, description: "Absolute path of the entry file." },
          frontmatter_json: { type: "string", required: true, description: "Typed frontmatter fields as a JSON object string." },
          body: { type: "string", required: true, description: "Markdown body of the entry." },
        },
      },
      render: textRender(
        (value) => [`lattice_get ${value.id} (${value.file})`, "", value.body].join("\n"),
      ),
    },
    execute: async (args, exec) => {
      const raw = typeof args.id === "string" ? args.id.trim().replace(/\.md$/i, "") : "";
      if (raw === "") throw new Error("lattice_get: id is required");
      const workspace = await resolveWorkspace(ctx, exec, undefined);
      const loaded = loadLibrary(config, workspace, "lattice_get");
      const entry = getEntryMerged(loaded.root, loaded.overlayRoot, raw);
      if (entry === null) {
        const known = loaded.entries
          .slice(0, 12)
          .map((item) => item.id)
          .join(", ");
        throw new Error(`lattice_get: no entry "${raw}" in ${loaded.root}${known === "" ? "" : `; known ids: ${known}`}`);
      }
      const data = {
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        summary: entry.summary,
        feature: entry.feature,
        tags: entry.tags,
        dims: entry.dims,
        status: entry.status,
        confidence: entry.confidence,
        verified_on: entry.verified_on,
        evidence: entry.evidence,
        supersedes: entry.supersedes,
        related: entry.related,
        applies_when: entry.applies_when,
        created: entry.created,
        updated: entry.updated,
      };
      return {
        id: entry.id,
        found: true,
        file: entry.file || "",
        frontmatter_json: JSON.stringify(data),
        body: entry.body,
      };
    },
  });
}

function listTool(ctx, config) {
  return defineTool({
    name: "lattice_list",
    description:
      "List Lattice entries in compact form (id, kind, status, feature, dims, verified_on) without reading bodies. Filter by feature/kind/status to see what a shared library already knows before searching or recording.",
    parameters: {
      feature: {
        type: "string",
        description: "Only entries whose feature contains this text (case-insensitive).",
      },
      kind: {
        type: "string",
        description: "Comma-separated kinds to keep, e.g. contract,gotcha.",
      },
      status: {
        type: "string",
        description: "Comma-separated statuses to keep, e.g. verified,draft.",
      },
      limit: {
        type: "number",
        description: "Maximum entries to return (default 200).",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          count: { type: "number", required: true, description: "Number of entries listed." },
          items_json: { type: "string", required: true, description: "JSON array of compact entries." },
          problems: { type: "number", required: true, description: "Entry files skipped because they failed validation." },
          note: { type: "string", required: true, description: "Status note." },
        },
      },
      render: textRender(
        (value) => `lattice_list: ${value.count} entr${value.count === 1 ? "y" : "ies"}\n${value.items_json}`,
      ),
    },
    execute: async (args, exec) => {
      const workspace = await resolveWorkspace(ctx, exec, undefined);
      const loaded = loadLibrary(config, workspace, "lattice_list");
      const feature = typeof args.feature === "string" ? args.feature.trim().toLowerCase() : "";
      const kinds = parseCsv(args.kind);
      const statuses = parseCsv(args.status);
      const limit = Number(args.limit) > 0 ? Math.min(1000, Number(args.limit)) : 200;
      const items = loaded.entries
        .filter((entry) => (feature === "" ? true : entry.feature.toLowerCase().includes(feature)))
        .filter((entry) => (kinds.length === 0 ? true : kinds.includes(entry.kind)))
        .filter((entry) => (statuses.length === 0 ? true : statuses.includes(entry.status)))
        .slice(0, limit)
        .map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          status: entry.status,
          title: entry.title,
          feature: entry.feature,
          dims: entry.dims,
          verified_on: entry.verified_on,
        }));
      const overlayNote = loaded.overlay > 0 ? ` (${loaded.overlay} overlays from ${loaded.overlayRoot})` : "";
      return {
        count: items.length,
        items_json: JSON.stringify(items),
        problems: loaded.problems.length,
        note:
          items.length === 0
            ? "no entry matched the filters; lattice_search finds by keywords, this lists by metadata only."
            : `showing ${items.length} of ${loaded.entries.length} valid entries${overlayNote}`,
      };
    },
  });
}

// ── Brief preview / matrix / gaps (M2) ──────────────────────────────────

/** Preview exactly what the resident prompt section would inject. */
function briefTool(ctx, config) {
  return defineTool({
    name: "lattice_brief",
    description:
      "Show the resident memory brief that the plugin injects into the system prompt for this workspace (same selection + token budget: inject.topK / inject.maxTokens). Use it to check what the model already sees, to tune the budget, or to debug why a piece of memory is not being surfaced.",
    parameters: {
      dims: {
        type: "string",
        description: 'Optional JSON object of dimensions to preview, e.g. {"mcver":"1.21.4","loader":"neoforge"}. Default: detected from the calling workspace.',
      },
      workspace: {
        type: "string",
        description: "Workspace folder to detect dimensions from; defaults to the calling agent's workspace.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          dims_json: { type: "string", required: true, description: "Dimensions used for selection, as a JSON object string." },
          dims_source: { type: "string", required: true, description: "parameter | workspace:<preset> — where dimensions came from." },
          count: { type: "number", required: true, description: "Number of entries in the brief." },
          total: { type: "number", required: true, description: "Valid entries in the library." },
          tokens: { type: "number", required: true, description: "Estimated tokens of the brief text." },
          text: { type: "string", required: true, description: "The brief text, as injected into the prompt section." },
        },
      },
      render: textRender((value) =>
        [
          `lattice_brief [dims ${value.dims_source}] ${value.count}/${value.total} entries, ~${value.tokens} tokens (budget ${config.inject.maxTokens})`,
          "",
          value.text,
        ].join("\n"),
      ),
    },
    execute: async (args, exec) => {
      const workspace = await resolveWorkspace(ctx, exec, args.workspace);
      let dims = parseDimsJson(args.dims);
      let dimsSource = "parameter";
      if (dims === null) {
        const detected = detectForWorkspace(config, workspace);
        dims = detected.dims;
        dimsSource = detected.source === "projects.json" ? `projects:${detected.preset}` : `workspace:${detected.preset}`;
      }
      const loaded = loadLibrary(config, workspace, "lattice_brief");
      const brief = buildBrief(loaded.entries, {
        dims,
        topK: config.inject.topK,
        maxTokens: config.inject.maxTokens,
        halfLifeDays: config.staleDays,
        overlayCount: loaded.overlay,
      });
      return {
        dims_json: JSON.stringify(dims),
        dims_source: dimsSource,
        count: brief.count,
        total: brief.total,
        tokens: brief.tokens,
        text: brief.text,
      };
    },
  });
}

/** Human-readable cell list for one matrix row. */
function renderMatrixRow(row) {
  const cells = row.cells.map(
    (cell) => `${cell.signature} → ${cell.count} (${cell.best_status || "unknown"})`,
  );
  return `- ${row.feature} (${row.entries}): ${cells.join("; ")}`;
}

function matrixTool(ctx, config) {
  return defineTool({
    name: "lattice_matrix",
    description:
      "Show the feature × dimension matrix of the shared Lattice library: one row per feature, one cell per version/environment combination, with how many entries exist and the best status there. Use it to see at a glance which versions a feature already has verified knowledge for. keys selects the dimensions (default: the most informative ones present, e.g. mcver,loader).",
    parameters: {
      feature: {
        type: "string",
        description: "Only features whose name contains this text (case-insensitive). Omit for the whole library.",
      },
      keys: {
        type: "string",
        description: "Comma-separated dimension keys to build columns from, e.g. 'mcver,loader'. Default: chosen from the entries.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          keys_json: { type: "string", required: true, description: "Dimension keys used for the columns, as a JSON array string." },
          features: { type: "number", required: true, description: "Number of feature rows." },
          total_entries: { type: "number", required: true, description: "Entries covered by the matrix." },
          rows_json: { type: "string", required: true, description: "JSON array of {feature, entries, cells:[{signature, dims, count, best_status, ids}]}." },
          note: { type: "string", required: true, description: "Status or next-step note." },
        },
      },
      render: textRender(
        (value) =>
          [`lattice_matrix: ${value.features} feature(s), ${value.total_entries} entries [keys ${value.keys_json}]`]
            .concat(value.rows_json === "[]" ? [value.note] : JSON.parse(value.rows_json).map(renderMatrixRow))
            .join("\n"),
      ),
    },
    execute: async (args, exec) => {
      const workspace = await resolveWorkspace(ctx, exec, undefined);
      const loaded = loadLibrary(config, workspace, "lattice_matrix");
      const matrix = buildMatrix(loaded.entries, {
        feature: typeof args.feature === "string" ? args.feature : "",
        keys: parseCsv(args.keys),
      });
      return {
        keys_json: JSON.stringify(matrix.keys),
        features: matrix.features,
        total_entries: matrix.total_entries,
        rows_json: JSON.stringify(matrix.rows),
        note:
          matrix.features === 0
            ? "no entry matched; the library has no memory for this filter yet — record one with the M3 write path, or search other features."
            : "cells show entry count and best status per dimension signature; missing cells are gaps.",
      };
    },
  });
}

function gapsTool(ctx, config) {
  return defineTool({
    name: "lattice_gaps",
    description:
      "List features that have entries in the shared Lattice library but no entry applicable to the given dimensions (default: the calling workspace's detected dimensions), plus the dimension combinations they do cover. Use it before starting version-sensitive work to know what the memory does not know yet, and to decide what to record afterwards.",
    parameters: {
      feature: {
        type: "string",
        description: "Only features whose name contains this text (case-insensitive).",
      },
      dims: {
        type: "string",
        description: 'Optional JSON object of dimensions to check, e.g. {"mcver":"1.21.4","loader":"neoforge"}. Default: detected from the workspace.',
      },
      workspace: {
        type: "string",
        description: "Workspace folder to detect dimensions from; defaults to the calling agent's workspace.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          dims_json: { type: "string", required: true, description: "Dimensions checked, as a JSON object string." },
          dims_source: { type: "string", required: true, description: "parameter | workspace:<preset> — where dimensions came from." },
          features: { type: "number", required: true, description: "Number of features considered." },
          covered: { type: "number", required: true, description: "Features with at least one applicable entry." },
          gaps_json: { type: "string", required: true, description: "JSON array of {feature, entries, ids, covered:[signature]}." },
          note: { type: "string", required: true, description: "Status or next-step note." },
        },
      },
      render: textRender((value) => {
        const gaps = JSON.parse(value.gaps_json);
        const lines = [
          `lattice_gaps: ${value.covered}/${value.features} feature(s) covered for dims ${value.dims_json} [${value.dims_source}]`,
        ];
        if (gaps.length === 0) lines.push(value.note);
        else {
          for (const gap of gaps) {
            lines.push(`- ${gap.feature} (${gap.entries} entr${gap.entries === 1 ? "y" : "ies"}: ${gap.ids.join(", ")})`);
            lines.push(`  covers: ${gap.covered.join("; ") || "(none)"}`);
          }
        }
        return lines.join("\n");
      }),
    },
    execute: async (args, exec) => {
      const workspace = await resolveWorkspace(ctx, exec, args.workspace);
      let dims = parseDimsJson(args.dims);
      let dimsSource = "parameter";
      if (dims === null) {
        const detected = detectForWorkspace(config, workspace);
        dims = detected.dims;
        dimsSource = detected.source === "projects.json" ? `projects:${detected.preset}` : `workspace:${detected.preset}`;
      }
      const loaded = loadLibrary(config, workspace, "lattice_gaps");
      if (Object.keys(dims).length === 0) {
        return {
          dims_json: "{}",
          dims_source: dimsSource,
          features: 0,
          covered: 0,
          gaps_json: "[]",
          note: "workspace dimensions were not detected (not a mod/package project?), so a gap cannot be told apart from a match; pass dims explicitly, e.g. dims='{\"mcver\":\"1.21.4\",\"loader\":\"neoforge\"}'.",
        };
      }
      const result = findGaps(loaded.entries, {
        dims,
        feature: typeof args.feature === "string" ? args.feature : "",
      });
      return {
        dims_json: JSON.stringify(dims),
        dims_source: dimsSource,
        features: result.features,
        covered: result.covered,
        gaps_json: JSON.stringify(result.gaps),
        note:
          result.gaps.length === 0
            ? "every feature in the library has an applicable entry for these dimensions."
            : "features without an applicable entry: record verified knowledge for this workspace's versions after the work is done (M3 write path).",
      };
    },
  });
}

// ── Write path (M3) ──────────────────────────────────────────────────────

/** Write guard: a read-only library refuses to store anything. */
function ensureWritable(config, toolName) {
  if (config.readOnly) {
    throw new Error(`${toolName}: the Lattice library is read-only (config readOnly=true); nothing was written.`);
  }
}

/** Evidence parameter: JSON array, or a newline / ";" separated list. */
function parseEvidence(value) {
  const clean = (item) => String(item).trim();
  if (Array.isArray(value)) return value.map(clean).filter((item) => item !== "");
  if (typeof value !== "string" || value.trim() === "") return [];
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`invalid evidence JSON: ${(err && err.message) || err}`);
    }
    if (!Array.isArray(parsed)) throw new Error('evidence JSON must be an array, e.g. ["file:src/main.js:42","run:npm test"]');
    return parsed.map(clean).filter((item) => item !== "");
  }
  return trimmed
    .split(/[\n;]+/)
    .map(clean)
    .filter((item) => item !== "");
}

/** Refuse to store credential-like content in the shared library. */
function rejectSecrets(toolName, entry) {
  const text = [entry.title, entry.summary, entry.body, ...(entry.evidence || [])].join("\n");
  const hits = scanSecrets(text);
  if (hits.length === 0) return;
  const rules = [...new Set(hits.map((hit) => hit.rule))].join(", ");
  throw new Error(
    `${toolName}: refused to store credential-like content (${rules}); replace the secret with a placeholder such as <redacted> and retry.`,
  );
}

function recordTool(config) {
  return defineTool({
    name: "lattice_record",
    description:
      "Record a project memory entry (a contract, decision, gotcha, port note, checklist, reference or note) into the shared Lattice library. Entries are version-tagged via dims and default to status=draft; use lattice_verify later to promote them once evidence is confirmed. Fails when the text contains credentials or when a near-duplicate entry already exists (Jaccard similarity >= lint.similarityThreshold). Writes only to the shared library, never to a project overlay.",
    parameters: {
      title: { type: "string", required: true, description: "One-line title." },
      kind: {
        type: "string",
        required: true,
        description: `Entry kind: ${ENTRY_KINDS.join(" | ")}.`,
      },
      feature: { type: "string", required: true, description: "Capability or area the entry is about, e.g. 药水持续时间 / auth-token-refresh." },
      summary: { type: "string", description: "Short summary shown in the resident index (1-2 sentences)." },
      body: { type: "string", description: "Markdown body: the actual contract, steps, pitfall, or porting notes." },
      dims: {
        type: "string",
        description: 'JSON object of dimensions, e.g. {"game":"minecraft","mcver":"1.20.1","loader":"forge"}. Empty = generic.',
      },
      tags: { type: "string", description: "Comma-separated tags." },
      status: { type: "string", description: "draft (default) or verified. Prefer recording draft and promoting with lattice_verify." },
      confidence: { type: "string", description: `low | medium | high (default: low for drafts, medium for verified).` },
      evidence: {
        type: "string",
        description: 'Evidence items: file:/run:/url: references. JSON array or newline-separated list; required by default (record.requireEvidence).',
      },
      id: { type: "string", description: "Optional entry id (lowercase slug). Defaults to a slug of the title." },
      supersedes: { type: "string", description: "Comma-separated entry ids this entry replaces." },
      related: { type: "string", description: "Comma-separated related entry ids." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true, description: "Always true on success (errors throw)." },
          id: { type: "string", required: true, description: "Entry id written." },
          file: { type: "string", required: true, description: "Absolute path of the written Markdown file." },
          status: { type: "string", required: true, description: "Stored status (draft or verified)." },
          created: { type: "boolean", required: true, description: "True when the file did not exist before." },
          similar_json: { type: "string", required: true, description: "JSON array of {id,title,score} near-matches below the refusal threshold." },
          note: { type: "string", required: true, description: "Next-step hint." },
        },
      },
      render: textRender((value) =>
        [
          `lattice_record: stored ${value.id} (${value.status}) at ${value.file}${value.created ? "" : " (replaced)"}`,
          value.similar_json !== "[]" ? `similar existing entries: ${value.similar_json}` : "no similar entries",
          value.note,
        ].join("\n"),
      ),
    },
    execute: async (args) => {
      ensureWritable(config, "lattice_record");
      const root = activeRootOrThrow(config, "lattice_record");
      const title = typeof args.title === "string" ? args.title.trim() : "";
      const feature = typeof args.feature === "string" ? args.feature.trim() : "";
      const kind = typeof args.kind === "string" ? args.kind.trim().toLowerCase() : "";
      if (title === "") throw new Error("lattice_record: title is required");
      if (feature === "") throw new Error("lattice_record: feature is required (the capability this entry is about)");
      if (!ENTRY_KINDS.includes(kind)) throw new Error(`lattice_record: kind must be one of ${ENTRY_KINDS.join(", ")}`);

      const status = typeof args.status === "string" && args.status.trim() !== "" ? args.status.trim().toLowerCase() : "draft";
      if (status !== "draft" && status !== "verified") {
        throw new Error("lattice_record: status must be draft or verified (promote later with lattice_verify)");
      }
      const requestedConfidence = typeof args.confidence === "string" ? args.confidence.trim().toLowerCase() : "";
      if (requestedConfidence !== "" && !CONFIDENCE_LEVELS.includes(requestedConfidence)) {
        throw new Error(`lattice_record: confidence must be one of ${CONFIDENCE_LEVELS.join(", ")}`);
      }
      const confidence = requestedConfidence !== "" ? requestedConfidence : status === "verified" ? "medium" : "low";

      const evidence = parseEvidence(args.evidence);
      if (evidence.length === 0 && (config.record.requireEvidence || status === "verified")) {
        throw new Error(
          "lattice_record: evidence is required; pass at least one file:/run:/url: item (set record.requireEvidence=false only if you really must).",
        );
      }

      const requestedId = typeof args.id === "string" && args.id.trim() !== "" ? args.id.trim() : "";
      const titleSlug = slugify(title);
      const featureSlug = slugify(feature) || "entry";
      const fallbackId = `${featureSlug.slice(0, 40)}-${kind}-${hashSuffix(title)}`;
      const id = requestedId !== "" ? requestedId : isEntryId(titleSlug) ? titleSlug : fallbackId;
      if (!isEntryId(id)) {
        throw new Error(
          `lattice_record: could not derive a valid id from "${title}" (ids must be lowercase ASCII letters, digits, ".", "_" or "-"); pass an explicit id such as id="my-entry-id".`,
        );
      }

      const dims = parseDimsJson(args.dims) ?? {};
      const entry = normalizeEntry(
        {
          id,
          kind,
          title,
          summary: typeof args.summary === "string" ? args.summary.trim() : "",
          feature,
          tags: parseCsv(args.tags),
          dims,
          status,
          confidence,
          verified_on: status === "verified" ? isoDate() : "",
          evidence,
          supersedes: parseCsv(args.supersedes),
          related: parseCsv(args.related),
        },
        typeof args.body === "string" ? args.body.trim() : "",
        null,
      );
      rejectSecrets("lattice_record", entry);

      const existing = loadEntries(root).entries;
      if (existing.some((item) => item.id === id)) {
        throw new Error(`lattice_record: ${id} already exists; update it with lattice_verify, record a different fact, or pick another id.`);
      }
      const similar = findSimilar(existing, entry);
      const close = similar.filter((item) => item.score >= config.lint.similarityThreshold);
      if (close.length > 0) {
        throw new Error(
          `lattice_record: refused as a near-duplicate of ${close.map((item) => `${item.id} (${item.score})`).join(", ")}; merge into that entry, mark it superseded, or lower lint.similarityThreshold.`,
        );
      }

      const saved = saveEntry(root, entry, { overwrite: false });
      if (!saved.ok) throw new Error(`lattice_record: ${saved.message}`);
      return {
        ok: true,
        id: entry.id,
        file: saved.file,
        status: entry.status,
        created: saved.created,
        similar_json: JSON.stringify(similar),
        note:
          entry.status === "draft"
            ? "draft stored; run lattice_verify with evidence once the fact is confirmed so it can enter the resident index."
            : "verified entry stored; it becomes eligible for the resident index immediately.",
      };
    },
  });
}

function verifyTool(config) {
  return defineTool({
    name: "lattice_verify",
    description:
      "Promote an existing entry to verified (or refresh its verification date) after confirming it against the current code. Requires new evidence; refuses credential-like content; never overwrites the body — use it to bump status/confidence/verified_on and accumulate evidence. Read-only libraries refuse the write.",
    parameters: {
      id: { type: "string", required: true, description: "Entry id to verify." },
      evidence: {
        type: "string",
        required: true,
        description: "New evidence: JSON array or newline list of file:/run:/url: items. Always required.",
      },
      confidence: { type: "string", description: "low | medium | high; defaults to the entry's current confidence or medium." },
      verified_on: { type: "string", description: "YYYY-MM-DD verification date; defaults to today." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true, description: "Always true on success (errors throw)." },
          id: { type: "string", required: true, description: "Entry id verified." },
          previous_status: { type: "string", required: true, description: "Status before this call." },
          status: { type: "string", required: true, description: "Status after this call (verified)." },
          confidence: { type: "string", required: true, description: "Confidence after this call." },
          verified_on: { type: "string", required: true, description: "Verification date stored." },
          evidence_count: { type: "number", required: true, description: "Total evidence items after merging." },
          file: { type: "string", required: true, description: "Absolute path of the updated Markdown file." },
          note: { type: "string", required: true, description: "Next-step hint." },
        },
      },
      render: textRender((value) =>
        [
          `lattice_verify: ${value.id} ${value.previous_status} -> ${value.status} (${value.confidence}, verified ${value.verified_on}, ${value.evidence_count} evidence item(s))`,
          value.note,
        ].join("\n"),
      ),
    },
    execute: async (args) => {
      ensureWritable(config, "lattice_verify");
      const root = activeRootOrThrow(config, "lattice_verify");
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!isEntryId(id)) throw new Error("lattice_verify: id is required (the entry id shown by lattice_list/lattice_search)");
      const entries = loadEntries(root).entries;
      const existing = entries.find((item) => item.id === id);
      if (!existing) {
        const known = entries.slice(0, 10).map((item) => item.id);
        throw new Error(`lattice_verify: ${id} not found in ${root}; known ids${known.length === 0 ? " (library is empty)" : `: ${known.join(", ")}`}`);
      }
      const evidence = parseEvidence(args.evidence);
      if (evidence.length === 0) throw new Error("lattice_verify: evidence is required (file:/run:/url:); verification without evidence is not verification");

      const requestedConfidence = typeof args.confidence === "string" ? args.confidence.trim().toLowerCase() : "";
      if (requestedConfidence !== "" && !CONFIDENCE_LEVELS.includes(requestedConfidence)) {
        throw new Error(`lattice_verify: confidence must be one of ${CONFIDENCE_LEVELS.join(", ")}`);
      }
      const confidence = requestedConfidence !== "" ? requestedConfidence : existing.confidence || "medium";
      const verifiedOn = typeof args.verified_on === "string" && args.verified_on.trim() !== "" ? args.verified_on.trim() : isoDate();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(verifiedOn)) throw new Error("lattice_verify: verified_on must be YYYY-MM-DD");

      const mergedEvidence = [...new Set([...existing.evidence, ...evidence])];
      const updated = {
        ...existing,
        status: "verified",
        confidence,
        verified_on: verifiedOn,
        evidence: mergedEvidence,
        updated: new Date().toISOString(),
      };
      rejectSecrets("lattice_verify", updated);
      const saved = saveEntry(root, updated, { overwrite: true });
      if (!saved.ok) throw new Error(`lattice_verify: ${saved.message}`);
      return {
        ok: true,
        id: updated.id,
        previous_status: existing.status,
        status: updated.status,
        confidence: updated.confidence,
        verified_on: updated.verified_on,
        evidence_count: updated.evidence.length,
        file: saved.file,
        note: "verified; eligible for the resident index and applicable search hits until staleDays passes.",
      };
    },
  });
}

function lintTool(ctx, config) {
  return defineTool({
    name: "lattice_lint",
    description:
      "Audit the shared memory library: entries that have gone stale (verified_on older than staleDays), entries without evidence, near-duplicate pairs, leaked credential-like strings, and files that fail validation. Read-only; fix findings with lattice_verify or by editing the Markdown files.",
    parameters: {
      workspace: {
        type: "string",
        description: "Workspace folder whose optional .lattice overlay should be linted together with the shared library. Defaults to the calling agent's workspace.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          entries: { type: "number", required: true, description: "Entries inspected (library + overlay)." },
          problems: { type: "number", required: true, description: "Entry files that failed validation and are invisible to retrieval." },
          stale_json: { type: "string", required: true, description: "JSON array of {id,title,verified_on,age_days}." },
          missing_evidence_json: { type: "string", required: true, description: "JSON array of {id,status}." },
          duplicates_json: { type: "string", required: true, description: "JSON array of {a,b,score} near-duplicate pairs." },
          secrets_json: { type: "string", required: true, description: "JSON array of {id,rules} entries containing credential-like strings." },
          read_only: { type: "boolean", required: true, description: "Whether the library is configured read-only." },
          notes: { type: "string", required: true, description: "Human-readable findings summary." },
        },
      },
      render: textRender((value) => {
        const lines = [
          `lattice_lint: ${value.entries} entries, ${value.problems} invalid file(s), read_only=${value.read_only}`,
        ];
        if (value.stale_json !== "[]") lines.push(`stale: ${value.stale_json}`);
        if (value.missing_evidence_json !== "[]") lines.push(`missing evidence: ${value.missing_evidence_json}`);
        if (value.duplicates_json !== "[]") lines.push(`near-duplicates: ${value.duplicates_json}`);
        if (value.secrets_json !== "[]") lines.push(`credential-like content: ${value.secrets_json}`);
        lines.push(value.notes);
        return lines.join("\n");
      }),
    },
    execute: async (args, exec) => {
      const workspace = await resolveWorkspace(ctx, exec, args.workspace);
      const loaded = loadLibrary(config, workspace, "lattice_lint");
      const report = lintReport(loaded.entries, loaded.problems, {
        staleDays: config.staleDays,
        similarityThreshold: config.lint.similarityThreshold,
      });
      return {
        entries: report.entries,
        problems: report.problems.length,
        stale_json: JSON.stringify(report.stale),
        missing_evidence_json: JSON.stringify(report.missing_evidence),
        duplicates_json: JSON.stringify(report.duplicates),
        secrets_json: JSON.stringify(report.secrets),
        read_only: config.readOnly,
        notes: report.notes.join(" "),
      };
    },
  });
}

const EXPORT_FORMATS = ["json", "skill", "agents"];

/** Shared-library entries only: overlays are project-local and must stay local. */
function exportableEntries(config, toolName) {
  const root = activeRootOrThrow(config, toolName);
  const loaded = loadEntries(root);
  return { root, entries: loaded.entries, problems: loaded.problems };
}

function exportTool(config) {
  return defineTool({
    name: "lattice_export",
    description:
      "Export part of the shared memory library as a portable artifact: JSON (re-importable, schema lattice-export/1), SKILL.md (a DSH skill page), or an AGENTS.md Markdown snippet. Filter by ids, feature substring, kind and/or status; the artifact is returned as text and nothing is written to disk. Re-import with lattice_import. Project overlays are never exported.",
    parameters: {
      format: {
        type: "string",
        required: true,
        description: 'Artifact format: "json" (re-importable), "skill" (SKILL.md page), "agents" (AGENTS.md snippet).',
      },
      ids: {
        type: "string",
        description: "Comma-separated entry ids to export; omit to export everything matching the other filters.",
      },
      feature: {
        type: "string",
        description: "Case-insensitive substring filter on the feature field.",
      },
      kind: {
        type: "string",
        description: `Entry kind filter (${ENTRY_KINDS.join(", ")}).`,
      },
      status: {
        type: "string",
        description: `Entry status filter (${ENTRY_STATUSES.join(", ")}).`,
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          format: { type: "string", required: true, description: "Artifact format used." },
          count: { type: "number", required: true, description: "Entries included in the artifact." },
          content: { type: "string", required: true, description: "The exported artifact text (show it to the user or write it to a file)." },
          note: { type: "string", required: true, description: "Next-step hint." },
        },
      },
      render: textRender((value) =>
        [`lattice_export: ${value.format}, ${value.count} entries`, "", value.content, "", value.note].join("\n"),
      ),
    },
    execute: async (args) => {
      const format = typeof args.format === "string" ? args.format.trim().toLowerCase() : "";
      if (!EXPORT_FORMATS.includes(format)) {
        throw new Error(`lattice_export: format must be one of ${EXPORT_FORMATS.join(", ")}`);
      }
      const { root, entries, problems } = exportableEntries(config, "lattice_export");
      const ids = typeof args.ids === "string" ? args.ids.split(",").map((item) => item.trim()).filter(Boolean) : undefined;
      const selected = filterEntries(entries, {
        ids,
        feature: typeof args.feature === "string" ? args.feature : "",
        kind: typeof args.kind === "string" ? args.kind.trim() : "",
        status: typeof args.status === "string" ? args.status.trim() : "",
      });
      if (selected.length === 0) {
        throw new Error("lattice_export: no entries matched the filters (library is empty or the filter is too narrow)");
      }
      let content;
      if (format === "json") {
        content = JSON.stringify(exportJson(selected, { source: root, overlay: 0 }), null, 2);
      } else if (format === "skill") {
        content = exportSkill(selected, { source: root });
      } else {
        content = exportAgents(selected, { source: root });
      }
      return {
        format,
        count: selected.length,
        content,
        note:
          problems.length > 0
            ? `${problems.length} invalid file(s) in the library were skipped. ${format === "json" ? "Re-import this with lattice_import." : "Paste it into a SKILL.md / AGENTS.md file."}`
            : format === "json"
              ? "Re-import this with lattice_import (dry-run first)."
              : "Paste the content into a SKILL.md (skill channel) or the project's AGENTS.md.",
      };
    },
  });
}

function importTool(config) {
  return defineTool({
    name: "lattice_import",
    description:
      "Import entries from a Lattice JSON export (schema lattice-export/1, or a bare array of entry records). Plans the merge first: new ids are added, existing ids / near-duplicates / invalid records / credential-like content are reported as conflicts and never overwritten. dry_run defaults to true; pass dry_run=false to write the accepted entries.",
    parameters: {
      data: {
        type: "string",
        required: true,
        description: "The JSON export text (object with entries[] or a bare array).",
      },
      dry_run: {
        type: "boolean",
        description: "true (default): only plan and report differences. false: write the accepted entries.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          dry_run: { type: "boolean", required: true, description: "Whether anything was written." },
          candidates: { type: "number", required: true, description: "Valid candidate entries in the payload." },
          added_json: { type: "string", required: true, description: "JSON array of entry ids that were (or would be) added." },
          conflicts_json: { type: "string", required: true, description: "JSON array of {id,reason,detail}." },
          problems_json: { type: "string", required: true, description: "JSON array of payload-level problems." },
          note: { type: "string", required: true, description: "Next-step hint." },
        },
      },
      render: textRender((value) => {
        const lines = [
          `lattice_import: ${value.candidates} candidate(s), ${value.dry_run ? "dry-run (nothing written)" : "applied"}`,
        ];
        if (value.added_json !== "[]") lines.push(`added: ${value.added_json}`);
        if (value.conflicts_json !== "[]") lines.push(`conflicts: ${value.conflicts_json}`);
        if (value.problems_json !== "[]") lines.push(`problems: ${value.problems_json}`);
        lines.push(value.note);
        return lines.join("\n");
      }),
    },
    execute: async (args) => {
      ensureWritable(config, "lattice_import");
      const root = activeRootOrThrow(config, "lattice_import");
      const data = typeof args.data === "string" ? args.data : "";
      if (data.trim() === "") throw new Error("lattice_import: data is required (the JSON export text)");
      const dryRun = args.dry_run !== false;
      const existing = loadEntries(root).entries;
      const plan = planImport(existing, data, { similarityThreshold: config.lint.similarityThreshold });
      const added = [];
      if (!dryRun) {
        for (const entry of plan.toAdd) {
          rejectSecrets("lattice_import", entry);
          const saved = saveEntry(root, entry, { overwrite: false });
          if (!saved.ok) throw new Error(`lattice_import: ${entry.id}: ${saved.message}`);
          added.push(entry.id);
        }
      } else {
        added.push(...plan.toAdd.map((entry) => entry.id));
      }
      const conflicts = plan.conflicts.map((item) => ({
        id: item.id,
        reason: item.reason,
        detail: item.detail,
      }));
      return {
        dry_run: dryRun,
        candidates: plan.candidates,
        added_json: JSON.stringify(added),
        conflicts_json: JSON.stringify(conflicts),
        problems_json: JSON.stringify(plan.problems),
        note: dryRun
          ? "dry-run only; re-run with dry_run=false to write the accepted entries."
          : `${added.length} entries written; run lattice_lint to confirm the library is consistent.`,
      };
    },
  });
}

// ── Mounting ─────────────────────────────────────────────────────────────

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": String(body.length),
  });
  res.end(body);
}

function readRequestBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        resolve("");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

/**
 * Browser trust fence: custom routes must go through DSH's admission check,
 * otherwise any web page could read or repoint the memory library.
 *
 * Returns `{ admitted, code, connection }`: when `admitted` is false the
 * request must be rejected with `code` (a 401/403 produced by the host, or a
 * `true` from a throwing check).
 */
function evaluateFence(serviceCtx, req) {
  let connection;
  try {
    if (serviceCtx && typeof serviceCtx.get === "function") {
      connection = serviceCtx.get("connection");
    }
  } catch (err) {
    connection = undefined;
  }
  if (!connection && serviceCtx) connection = serviceCtx.connection;
  if (!connection || typeof connection.requestRejection !== "function") {
    return { admitted: true, code: undefined, connection: "missing" };
  }
  try {
    const rejection = connection.requestRejection(req);
    if (rejection === undefined || rejection === null || rejection === false) {
      return { admitted: true, code: undefined, connection: "present" };
    }
    return { admitted: false, code: rejection, connection: "present" };
  } catch (err) {
    return { admitted: false, code: 403, connection: "threw:" + String((err && err.message) || err) };
  }
}

/**
 * Best-effort diagnostics: one JSON line per onboarding request, written into
 * the plugin state dir so a broken deployment can be debugged from logs.
 */
function recordRoute(req, fence) {
  try {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    const entry = {
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      host: req.headers.host,
      origin: req.headers.origin,
      secFetchSite: req.headers["sec-fetch-site"],
      admitted: fence.admitted,
      code: fence.code,
      connection: fence.connection,
    };
    appendFileSync(join(dir, "route-debug.log"), JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    /* diagnostics must never break the route */
  }
}

/** Shared fence gate for panel routes; returns false when a response was sent. */
function fenceGuard(scoped, req, res, debug) {
  const fence = evaluateFence(scoped, req);
  if (debug) recordRoute(req, fence);
  if (fence.admitted) return true;
  sendJson(res, 403, {
    ok: false,
    error: {
      code: "fence-rejected",
      message: `browser trust fence rejected the request (${String(fence.code)})`,
    },
    hint: {
      host: req.headers.host ?? null,
      origin: req.headers.origin ?? null,
      connection: fence.connection,
    },
  });
  return false;
}

function queryOf(req) {
  try {
    return new URL(req.url || "/", "http://localhost");
  } catch (err) {
    return new URL("/", "http://localhost");
  }
}

function round4(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 10000) / 10000 : 0;
}

/** Panel-facing view of an entry (no absolute file path). */
function entryView(entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    summary: entry.summary,
    feature: entry.feature,
    tags: entry.tags,
    dims: entry.dims,
    status: entry.status,
    confidence: entry.confidence,
    verified_on: entry.verified_on,
    evidence: entry.evidence,
    supersedes: entry.supersedes,
    related: entry.related,
  };
}

function panelWorkspace(url) {
  const explicit = (url.searchParams.get("workspace") || "").trim();
  return explicit === "" ? process.cwd() : explicit;
}

/* ------------------------------- updates -------------------------------- */

/** Version of the plugin that is actually loaded on this machine. */
function readLocalPackageVersion() {
  try {
    const raw = readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.version === "string" ? parsed.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parseSemver(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(value || "").trim(),
  );
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] || "" };
}

/** 1 when a > b, -1 when a < b, 0 when equal (unparsable sides count as equal). */
function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return 0;
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === "") return 1;
  if (right.pre === "") return -1;
  return left.pre > right.pre ? 1 : -1;
}

async function readRemoteManifest(config) {
  const repo = config.update.repo;
  const branch = config.update.branch;
  const sourceUrl = `https://raw.githubusercontent.com/${repo}/${branch}/package.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
  try {
    const response = await fetch(sourceUrl, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${sourceUrl}`);
    const text = await response.text();
    const manifest = JSON.parse(text);
    return { repo, branch, sourceUrl, manifest };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compare the loaded version with the one published on GitHub. Report only:
 * installing the newer build stays an explicit user action.
 */
async function checkForUpdate(config) {
  const current = readLocalPackageVersion();
  try {
    const remote = await readRemoteManifest(config);
    const latest = typeof remote.manifest.version === "string" ? remote.manifest.version.trim() : "";
    const comparison = latest === "" ? 0 : compareSemver(latest, current);
    const spec = `github:${remote.repo}${remote.branch === "main" ? "" : `#${remote.branch}`}`;
    return {
      ok: true,
      current,
      latest,
      hasUpdate: comparison > 0,
      repo: remote.repo,
      branch: remote.branch,
      sourceUrl: remote.sourceUrl,
      homepage: `https://github.com/${remote.repo}`,
      installSpec: spec,
      hint:
        comparison > 0
          ? `发现新版本 ${latest}（当前 ${current}）：在 DSH 插件页重装 ${spec}，然后点面板里的「重载界面」。`
          : `已是最新版本（${current}）。`,
    };
  } catch (error) {
    return {
      ok: false,
      current,
      error: {
        code: "update-check-failed",
        message: String(error && error.message ? error.message : error),
      },
    };
  }
}

function updateTool(config) {
  return defineTool({
    name: "lattice_check_update",
    description:
      "Check GitHub for a newer Lattice version (reads package.json from the configured repo/branch). Report only; installing stays a manual step.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true, description: "Whether the check completed." },
          current: { type: "string", required: true, description: "Version loaded on this machine." },
          latest: { type: "string", description: "Version published on the configured branch." },
          has_update: { type: "boolean", description: "True when the remote version is newer." },
          repo: { type: "string", description: "owner/repo that was checked." },
          install_spec: { type: "string", description: "Spec to install the newer build." },
          source_url: { type: "string", description: "URL of the package.json that was read." },
          hint: { type: "string", description: "Human-readable next step." },
          error: { type: "object", additionalProperties: true, description: "Check error when ok is false." },
        },
      },
      render: (args, value) => [{ type: "text", text: value.hint || value.current || "lattice_check_update" }],
    },
    execute: async () => {
      const result = await checkForUpdate(config);
      return {
        ok: result.ok,
        current: result.current,
        latest: result.latest || "",
        has_update: result.hasUpdate === true,
        repo: result.repo || config.update.repo,
        install_spec: result.installSpec || "",
        source_url: result.sourceUrl || "",
        hint: result.ok ? result.hint : `检查更新失败：${result.error.message}`,
        error: result.ok ? undefined : result.error,
      };
    },
  });
}

/** Legacy onboarding routes kept for reference; superseded by mountPanelRoutes.
 *  TODO(M5.1): delete once the panel route has shipped one release.
 */
function mountRoutesLegacy(ctx, config) {
  ctx.inject(["webServer"], (scoped) => {
    const server = scoped.webServer;
    if (!server || typeof server.register !== "function") return;

    scoped.effect(
      () =>
        server.register({
          kind: "exact",
          path: API_STATE,
          handler: async (req, res) => {
            const fence = evaluateFence(scoped, req);
            if (config.debug) recordRoute(req, fence);
            if (!fence.admitted) {
              sendJson(res, 403, {
                ok: false,
                error: {
                  code: "fence-rejected",
                  message: `browser trust fence rejected the request (${String(fence.code)})`,
                },
                hint: {
                  host: req.headers.host ?? null,
                  origin: req.headers.origin ?? null,
                  connection: fence.connection,
                },
              });
              return;
            }
            sendJson(res, 200, stateSnapshot(config));
          },
        }),
      "dsh-lattice-memory: state route",
    );

    scoped.effect(
      () =>
        server.register({
          kind: "exact",
          path: API_SETUP,
          handler: async (req, res) => {
            const fence = evaluateFence(scoped, req);
            if (config.debug) recordRoute(req, fence);
            if (!fence.admitted) {
              sendJson(res, 403, {
                ok: false,
                error: {
                  code: "fence-rejected",
                  message: `browser trust fence rejected the request (${String(fence.code)})`,
                },
                hint: {
                  host: req.headers.host ?? null,
                  origin: req.headers.origin ?? null,
                  connection: fence.connection,
                },
              });
              return;
            }
            if ((req.method || "GET").toUpperCase() !== "POST") {
              sendJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "POST only" } });
              return;
            }
            const text = await readRequestBody(req);
            let payload = {};
            try {
              payload = text === "" ? {} : JSON.parse(text);
            } catch (err) {
              sendJson(res, 400, { ok: false, error: { code: "invalid-json", message: "request body is not valid JSON" } });
              return;
            }
            const outcome = applySetup(config, payload);
            if (!outcome.ok) {
              sendJson(res, 400, { ok: false, error: { code: outcome.code, message: outcome.message } });
              return;
            }
            sendJson(res, 200, { ...outcome, state: stateSnapshot(config) });
          },
        }),
      "dsh-lattice-memory: setup route",
    );

    scoped.effect(
      () =>
        server.register({
          kind: "exact",
          path: API_ENTRIES,
          handler: async (req, res) => {
            if (!fenceGuard(scoped, req, res, config.debug)) return;
            const url = queryOf(req);
            const workspace = panelWorkspace(url);
            const loaded = loadLibrary(config, workspace, "lattice panel");
            const quiz = (url.searchParams.get("q") || "").trim();
            const feature = (url.searchParams.get("feature") || "").trim().toLowerCase();
            const kind = (url.searchParams.get("kind") || "").trim();
            const status = (url.searchParams.get("status") || "").trim();
            const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 100));
            if (quiz !== "") {
              const detected = detectForWorkspace(config, workspace);
              const rows = rankEntries(loaded.entries, quiz, {
                dims: detected.dims,
                mode: "prefer",
                limit,
              });
              sendJson(res, 200, {
                ok: true,
                mode: "search",
                query: quiz,
                dims: detected.dims,
                dims_source: detected.source === "projects.json" ? `projects:${detected.preset}` : `workspace:${detected.preset}`,
                total: loaded.entries.length,
                problems: loaded.problems.length,
                overlay: loaded.overlay,
                items: rows.map((row) => ({
                  ...entryView(row.entry),
                  score: round4(row.score),
                  bm25: round4(row.bm25),
                  applicable: row.applicable,
                  dim_notes: row.dims.notes,
                })),
              });
              return;
            }
            const items = loaded.entries
              .filter((entry) => {
                if (feature !== "" && !entry.feature.toLowerCase().includes(feature)) return false;
                if (kind !== "" && entry.kind !== kind) return false;
                if (status !== "" && entry.status !== status) return false;
                return true;
              })
              .sort((left, right) => String(right.updated || "").localeCompare(String(left.updated || "")))
              .slice(0, limit)
              .map(entryView);
            sendJson(res, 200, {
              ok: true,
              mode: "browse",
              total: loaded.entries.length,
              problems: loaded.problems.length,
              overlay: loaded.overlay,
              items,
            });
          },
        }),
      "dsh-lattice-memory: entries route",
    );

    scoped.effect(
      () =>
        server.register({
          kind: "exact",
          path: API_ENTRY,
          handler: async (req, res) => {
            if (!fenceGuard(scoped, req, res, config.debug)) return;
            const url = queryOf(req);
            const id = (url.searchParams.get("id") || "").trim();
            const workspace = panelWorkspace(url);
            const active = resolveActiveRoot(config);
            if (active.root === null) {
              sendJson(res, 409, { ok: false, error: { code: "not-configured", message: "the Lattice library root is not configured yet" } });
              return;
            }
            const loaded = loadEntriesMerged(active.root, overlayRootOf(config, workspace));
            const entry = getEntryMerged(active.root, overlayRootOf(config, workspace), id);
            if (!entry) {
              sendJson(res, 404, {
                ok: false,
                error: { code: "not-found", message: `entry "${id}" not found`, known: loaded.entries.slice(0, 20).map((item) => item.id) },
              });
              return;
            }
            sendJson(res, 200, { ok: true, entry: { ...entryView(entry), body: entry.body } });
          },
        }),
      "dsh-lattice-memory: entry route",
    );

    scoped.effect(
      () =>
        server.register({
          kind: "exact",
          path: API_MATRIX,
          handler: async (req, res) => {
            if (!fenceGuard(scoped, req, res, config.debug)) return;
            const url = queryOf(req);
            const workspace = panelWorkspace(url);
            const loaded = loadLibrary(config, workspace, "lattice panel");
            const feature = (url.searchParams.get("feature") || "").trim();
            const keys = (url.searchParams.get("keys") || "")
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean);
            const matrix = buildMatrix(loaded.entries, { feature, keys });
            sendJson(res, 200, { ok: true, ...matrix });
          },
        }),
      "dsh-lattice-memory: matrix route",
    );

    scoped.effect(
      () =>
        server.register({
          kind: "exact",
          path: API_EXPORT,
          handler: async (req, res) => {
            if (!fenceGuard(scoped, req, res, config.debug)) return;
            const url = queryOf(req);
            const format = (url.searchParams.get("format") || "json").trim().toLowerCase();
            if (!EXPORT_FORMATS.includes(format)) {
              sendJson(res, 400, { ok: false, error: { code: "bad-format", message: `format must be one of ${EXPORT_FORMATS.join(", ")}` } });
              return;
            }
            let exported;
            try {
              exported = exportableEntries(config, "lattice export");
            } catch (err) {
              sendJson(res, 409, { ok: false, error: { code: "not-configured", message: String((err && err.message) || err) } });
              return;
            }
            const ids = (url.searchParams.get("ids") || "").split(",").map((item) => item.trim()).filter(Boolean);
            const selected = filterEntries(exported.entries, {
              ids: ids.length > 0 ? ids : undefined,
              feature: url.searchParams.get("feature") || "",
              kind: url.searchParams.get("kind") || "",
              status: url.searchParams.get("status") || "",
            });
            let content;
            if (format === "json") content = JSON.stringify(exportJson(selected, { source: exported.root, overlay: 0 }), null, 2);
            else if (format === "skill") content = exportSkill(selected, { source: exported.root });
            else content = exportAgents(selected, { source: exported.root });
            sendJson(res, 200, { ok: true, format, count: selected.length, content });
          },
        }),
      "dsh-lattice-memory: export route",
    );

    scoped.effect(
      () =>
        server.register({
          kind: "exact",
          path: API_IMPORT,
          handler: async (req, res) => {
            if (!fenceGuard(scoped, req, res, config.debug)) return;
            if ((req.method || "GET").toUpperCase() !== "POST") {
              sendJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "POST only" } });
              return;
            }
            const text = await readRequestBody(req, PANEL_BODY_LIMIT);
            let payload;
            try {
              payload = text === "" ? {} : JSON.parse(text);
            } catch (err) {
              sendJson(res, 400, { ok: false, error: { code: "invalid-json", message: "request body is not valid JSON" } });
              return;
            }
            if (!payload || typeof payload.data !== "string" || payload.data.trim() === "") {
              sendJson(res, 400, { ok: false, error: { code: "missing-data", message: "data (the JSON export text) is required" } });
              return;
            }
            if (config.readOnly) {
              sendJson(res, 409, { ok: false, error: { code: "read-only", message: "the library is configured read-only (readOnly: true)" } });
              return;
            }
            let root;
            try {
              root = activeRootOrThrow(config, "lattice import");
            } catch (err) {
              sendJson(res, 409, { ok: false, error: { code: "not-configured", message: String((err && err.message) || err) } });
              return;
            }
            const existing = loadEntries(root).entries;
            const plan = planImport(existing, payload.data, { similarityThreshold: config.lint.similarityThreshold });
            const dryRun = payload.dry_run !== false;
            const added = [];
            if (!dryRun) {
              for (const entry of plan.toAdd) {
                const secrets = scanSecrets([entry.title, entry.summary, entry.body].join("\n"));
                if (secrets.length > 0) continue;
                const saved = saveEntry(root, entry, { overwrite: false });
                if (!saved.ok) continue;
                added.push(entry.id);
              }
            } else {
              added.push(...plan.toAdd.map((entry) => entry.id));
            }
            sendJson(res, 200, {
              ok: true,
              dry_run: dryRun,
              candidates: plan.candidates,
              added,
              conflicts: plan.conflicts,
              problems: plan.problems,
            });
          },
        }),
      "dsh-lattice-memory: import route",
    );
  });
}

/** Best-effort boot trail: the panel can only tell the browser it is missing. */
function bootLog(line) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    appendFileSync(join(stateDir(), "boot.log"), `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    /* diagnostics must never break mounting */
  }
}

/** Resolve the host web server directly (same shape as dsh-startup-screen). */
function resolveWebServer(ctx) {
  try {
    const viaGet = typeof ctx.get === "function" ? ctx.get("webServer") : undefined;
    if (viaGet) return viaGet;
  } catch {
    // fall through to the service property
  }
  try {
    return ctx.webServer;
  } catch {
    return undefined;
  }
}

/** Register the one prefix route on a server, scoped so disposal cleans up. */
function registerPanelRoute(scope, server, config) {
  return scope.effect(
    () =>
      server.register({
        kind: "prefix",
        path: API_PANEL,
        handler: async (req, res) => {
          try {
            await handlePanelRequest(scope, config, req, res);
          } catch (err) {
            if (res.headersSent) {
              res.end();
              return;
            }
            sendJson(res, 500, {
              ok: false,
              error: { code: "panel-error", message: String((err && err.message) || err) },
            });
          }
        },
      }),
    "dsh-lattice-memory: panel routes",
  );
}

/**
 * Panel + onboarding API. Registered as ONE prefix route so the whole surface is
 * atomic: either every /lattice-panel endpoint exists or none does, and the
 * client can prove which by calling /lattice-panel/version.
 */
function mountPanelRoutes(ctx, config) {
  const server = resolveWebServer(ctx);
  if (server && typeof server.register === "function") {
    try {
      registerPanelRoute(ctx, server, config);
      bootLog(`panel: registered prefix ${API_PANEL} via resolveWebServer`);
      return;
    } catch (err) {
      bootLog(`panel: register via resolveWebServer failed: ${(err && err.stack) || err}`);
    }
  } else {
    bootLog(`panel: resolveWebServer returned ${server === undefined ? "undefined" : typeof server}`);
  }
  try {
    ctx.inject(["webServer"], (scoped) => {
      const injected = scoped.webServer;
      if (!injected || typeof injected.register !== "function") {
        bootLog(`panel: injected webServer unusable (${injected === undefined ? "undefined" : typeof injected})`);
        return;
      }
      registerPanelRoute(scoped, injected, config);
      bootLog(`panel: registered prefix ${API_PANEL} via ctx.inject`);
    });
  } catch (err) {
    bootLog(`panel: ctx.inject path threw: ${(err && err.stack) || err}`);
  }
}

async function handlePanelRequest(ctx, config, req, res) {
  if (!fenceGuard(ctx, req, res, config.debug)) return;
  const url = queryOf(req);
  const tail = (url.pathname || "").replace(/\/+$/, "").slice(API_PANEL.length) || "/";
  const method = (req.method || "GET").toUpperCase();

  if (tail === "/version") {
    sendJson(res, 200, { ok: true, version: PANEL_VERSION, endpoints: PANEL_ENDPOINTS });
    return;
  }

  if (tail === "/state") {
    sendJson(res, 200, { ok: true, state: stateSnapshot(config) });
    return;
  }

  if (tail === "/setup") {
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "POST only" } });
      return;
    }
    const text = await readRequestBody(req);
    let payload = {};
    try {
      payload = text === "" ? {} : JSON.parse(text);
    } catch {
      sendJson(res, 400, { ok: false, error: { code: "invalid-json", message: "request body is not valid JSON" } });
      return;
    }
    const outcome = applySetup(config, payload);
    if (!outcome.ok) {
      sendJson(res, 400, { ok: false, error: { code: outcome.code, message: outcome.message } });
      return;
    }
    sendJson(res, 200, { ...outcome, state: stateSnapshot(config) });
    return;
  }

  if (tail === "/entries") {
    const workspace = panelWorkspace(url);
    const loaded = loadLibrary(config, workspace, "lattice panel");
    const quiz = (url.searchParams.get("q") || "").trim();
    const feature = (url.searchParams.get("feature") || "").trim().toLowerCase();
    const kind = (url.searchParams.get("kind") || "").trim();
    const status = (url.searchParams.get("status") || "").trim();
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 100));
    if (quiz !== "") {
      const detected = detectForWorkspace(config, workspace);
      const rows = rankEntries(loaded.entries, quiz, { dims: detected.dims, mode: "prefer", limit });
      sendJson(res, 200, {
        ok: true,
        mode: "search",
        query: quiz,
        dims: detected.dims,
        dims_source: detected.source === "projects.json" ? `projects:${detected.preset}` : `workspace:${detected.preset}`,
        total: loaded.entries.length,
        problems: loaded.problems.length,
        overlay: loaded.overlay,
        items: rows.map((row) => ({
          ...entryView(row.entry),
          score: round4(row.score),
          bm25: round4(row.bm25),
          applicable: row.applicable,
          dim_notes: row.dims.notes,
        })),
      });
      return;
    }
    const items = loaded.entries
      .filter((entry) => {
        if (feature !== "" && !entry.feature.toLowerCase().includes(feature)) return false;
        if (kind !== "" && entry.kind !== kind) return false;
        if (status !== "" && entry.status !== status) return false;
        return true;
      })
      .sort((left, right) => String(right.updated || "").localeCompare(String(left.updated || "")))
      .slice(0, limit)
      .map(entryView);
    sendJson(res, 200, { ok: true, mode: "browse", total: loaded.entries.length, problems: loaded.problems.length, overlay: loaded.overlay, items });
    return;
  }

  if (tail === "/captures") {
    const pending = listCandidates();
    const view = (items) => items.map((item) => ({
      id: item.id,
      tool: item.tool,
      kind: item.kind,
      title: item.title,
      summary: item.summary,
      body: item.body ?? "",
      evidence: Array.isArray(item.evidence) ? item.evidence : [],
      dims: item.dims && typeof item.dims === "object" ? item.dims : {},
      count: item.count ?? 1,
      createdAt: item.createdAt,
      workspace: item.workspace ?? "",
      errorText: item.errorText ?? "",
      failedAt: item.failedAt ?? "",
      recoveredAt: item.recoveredAt ?? "",
      corrections: Array.isArray(item.corrections) ? item.corrections : [],
      reason: item.reason ?? "",
    }));
    if (method === "GET") {
      sendJson(res, 200, {
        ok: true,
        mode: config.capture.mode,
        enabled: config.capture.enabled,
        count: pending.length,
        items: view(pending),
      });
      return;
    }
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "GET or POST only" } });
      return;
    }
    const raw = await readRequestBody(req, PANEL_BODY_LIMIT);
    let body = {};
    try {
      body = raw === "" ? {} : JSON.parse(raw);
    } catch {
      sendJson(res, 400, { ok: false, error: { code: "invalid-json", message: "request body is not valid JSON" } });
      return;
    }
    const action = String(body.action ?? "").trim().toLowerCase();
    if (!["accept", "discard"].includes(action)) {
      sendJson(res, 400, { ok: false, error: { code: "invalid-action", message: "action must be accept or discard" } });
      return;
    }
    if (config.readOnly && action === "accept") {
      sendJson(res, 409, { ok: false, error: { code: "read-only", message: "the library is read-only (readOnly: true)" } });
      return;
    }
    const wanted = body.all === true
      ? pending.map((item) => item.id)
      : [String(body.id ?? "").trim()].filter((id) => id !== "");
    if (wanted.length === 0) {
      sendJson(res, 400, { ok: false, error: { code: "missing-id", message: "pass id or all:true" } });
      return;
    }
    if (action === "discard") {
      const removed = removeCandidates(wanted);
      sendJson(res, 200, { ok: true, action, removed, count: listCandidates().length, saved: [], items: view(listCandidates()) });
      return;
    }
    const saved = [];
    try {
      for (const id of wanted) {
        const candidate = pending.find((item) => item.id === id);
        if (!candidate) throw new Error(`no pending candidate with id ${id}`);
        const stored = storeCandidate(config, candidate, body.overrides && typeof body.overrides === "object" ? body.overrides : {});
        saved.push({ id: stored.entry.id, file: stored.saved.file });
      }
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: { code: "accept-failed", message: String(error && error.message ? error.message : error) },
        saved,
        count: listCandidates().length,
        items: view(listCandidates()),
      });
      return;
    }
    removeCandidates(wanted);
    sendJson(res, 200, { ok: true, action, removed: wanted.length, count: listCandidates().length, saved, items: view(listCandidates()) });
    return;
  }

  if (tail === "/clear") {
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "POST only" } });
      return;
    }
    if (config.readOnly) {
      sendJson(res, 409, {
        ok: false,
        error: { code: "read-only", message: "the library is read-only (readOnly: true in the plugin config)" },
      });
      return;
    }
    let body = {};
    try {
      const raw = await readRequestBody(req, PANEL_BODY_LIMIT);
      body = raw === "" ? {} : JSON.parse(raw);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: { code: "invalid-json", message: "request body is not valid JSON" } });
      return;
    }
    if (body.confirm !== true) {
      sendJson(res, 400, {
        ok: false,
        error: {
          code: "confirmation-required",
          message: "pass confirm:true — the panel shows a 30 second warning before this request is sent",
        },
      });
      return;
    }
    const root = activeRootOrThrow(config, "lattice panel");
    const loaded = loadEntries(root);
    let removed = 0;
    for (const entry of loaded.entries) {
      try {
        unlinkSync(entry.file);
        removed += 1;
      } catch (error) {
        // The file is already gone; nothing left to delete for this entry.
      }
    }
    clearEntriesCache();
    sendJson(res, 200, { ok: true, removed, entries: 0, invalidFiles: loaded.problems.length });
    return;
  }

  if (tail === "/delete") {
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "POST only" } });
      return;
    }
    if (config.readOnly) {
      sendJson(res, 409, {
        ok: false,
        error: { code: "read-only", message: "the library is read-only (readOnly: true in the plugin config)" },
      });
      return;
    }
    let body = {};
    try {
      const raw = await readRequestBody(req, PANEL_BODY_LIMIT);
      body = raw === "" ? {} : JSON.parse(raw);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: { code: "invalid-json", message: "request body is not valid JSON" } });
      return;
    }
    const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id ?? "").trim()).filter((id) => id !== "") : [];
    if (ids.length === 0) {
      sendJson(res, 400, { ok: false, error: { code: "missing-ids", message: "pass ids: [...] — the entries to delete" } });
      return;
    }
    const root = activeRootOrThrow(config, "lattice panel");
    const loaded = loadEntries(root);
    const wanted = new Set(ids);
    let removed = 0;
    const missing = [];
    for (const entry of loaded.entries) {
      if (!wanted.has(entry.id)) continue;
      try {
        unlinkSync(entry.file);
        removed += 1;
        wanted.delete(entry.id);
      } catch (error) {
        missing.push(entry.id);
      }
    }
    for (const id of wanted) missing.push(id);
    clearEntriesCache();
    sendJson(res, 200, { ok: true, removed, missing });
    return;
  }

  if (tail === "/backup" && method === "GET") {
    const dir = resolveBackupDir(config.backup.dir);
    let backups = [];
    let problem = "";
    try {
      backups = listBackups(dir);
    } catch (error) {
      problem = String(error && error.message ? error.message : error);
    }
    sendJson(res, 200, {
      ok: true,
      pluginRoot: PLUGIN_ROOT,
      installDir: pluginInstallDir(),
      packageDir: pluginPackageDir(),
      defaultDir: defaultBackupDir(),
      dir,
      keep: config.backup.keep,
      configured: config.backup.dir,
      backups,
      problem,
    });
    return;
  }

  if (tail === "/backup" && method === "POST") {
    let body = {};
    try {
      const raw = await readRequestBody(req, PANEL_BODY_LIMIT);
      body = raw === "" ? {} : JSON.parse(raw);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: { code: "invalid-json", message: "request body is not valid JSON" } });
      return;
    }
    let root;
    try {
      root = activeRootOrThrow(config, "lattice panel");
    } catch (error) {
      sendJson(res, 400, { ok: false, error: { code: "library-not-configured", message: String(error && error.message ? error.message : error) } });
      return;
    }
    const requested = typeof body.dir === "string" && body.dir.trim() !== "" ? body.dir : config.backup.dir;
    const target = resolveBackupDir(requested);
    const keep = (() => {
      const number = Number(body.keep);
      return Number.isFinite(number) && number >= 1 ? Math.floor(number) : config.backup.keep;
    })();
    try {
      const result = createBackup({ root, backupDir: target, keep, name: typeof body.name === "string" ? body.name : "" });
      sendJson(res, 200, { ok: true, ...result, backupDir: target });
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: { code: "backup-failed", message: String(error && error.message ? error.message : error) },
      });
    }
    return;
  }

  if (tail === "/restore" && method === "POST") {
    if (config.readOnly) {
      sendJson(res, 409, { ok: false, error: { code: "read-only", message: "the library is read-only (readOnly=true)" } });
      return;
    }
    let body = {};
    try {
      const raw = await readRequestBody(req, PANEL_BODY_LIMIT);
      body = raw === "" ? {} : JSON.parse(raw);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: { code: "invalid-json", message: "request body is not valid JSON" } });
      return;
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name === "") {
      sendJson(res, 400, { ok: false, error: { code: "missing-name", message: "pick a backup to restore (body.name)" } });
      return;
    }
    let root;
    try {
      root = activeRootOrThrow(config, "lattice panel");
    } catch (error) {
      sendJson(res, 400, { ok: false, error: { code: "library-not-configured", message: String(error && error.message ? error.message : error) } });
      return;
    }
    const target = resolveBackupDir(config.backup.dir);
    try {
      const result = restoreBackup({ root, backupDir: target, name });
      clearEntriesCache();
      sendJson(res, 200, { ok: true, ...result, backupDir: target });
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: { code: "restore-failed", message: String(error && error.message ? error.message : error) },
      });
    }
    return;
  }

  if (tail === "/update" && method === "GET") {
    const result = await checkForUpdate(config);
    if (!result.ok) {
      sendJson(res, 502, { ok: false, ...result });
      return;
    }
    sendJson(res, 200, { ok: true, ...result });
    return;
  }

  if (tail === "/pick-directory" && method === "POST") {
    let result = { ok: true, path: "", hint: "no-directory-picker" };
    try {
      const picker = (typeof ctx.get === "function" ? ctx.get("directoryPicker") : undefined) || ctx.directoryPicker;
      const capability = picker && typeof picker.capability === "function" ? picker.capability() : null;
      if (capability && capability.kind === "native" && typeof capability.pick === "function") {
        // The native backend reads `signal.aborted`, so it must get a real
        // AbortSignal (calling pick() with no argument throws inside the host).
        const controller = new AbortController();
        let timer = null;
        const picked = await Promise.race([
          capability.pick(controller.signal),
          new Promise((resolve) => {
            timer = setTimeout(() => {
              controller.abort();
              resolve(null);
            }, 5 * 60 * 1000);
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        result = { ok: true, path: typeof picked === "string" ? picked : "", hint: "native" };
      } else if (capability && capability.kind === "browse") {
        result = { ok: true, path: "", hint: "browse-only" };
      }
    } catch (error) {
      result = { ok: false, path: "", hint: "picker-failed", message: String(error && error.message ? error.message : error) };
    }
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (tail === "/entry") {
    const id = (url.searchParams.get("id") || "").trim();
    const workspace = panelWorkspace(url);
    const active = resolveActiveRoot(config);
    if (active.root === null) {
      sendJson(res, 409, { ok: false, error: { code: "not-configured", message: "the Lattice library root is not configured yet" } });
      return;
    }
    const overlay = overlayRootOf(config, workspace);
    const loaded = loadEntriesMerged(active.root, overlay);
    const entry = getEntryMerged(active.root, overlay, id);
    if (!entry) {
      sendJson(res, 404, {
        ok: false,
        error: { code: "not-found", message: `entry "${id}" not found`, known: loaded.entries.slice(0, 20).map((item) => item.id) },
      });
      return;
    }
    sendJson(res, 200, { ok: true, entry: { ...entryView(entry), body: entry.body } });
    return;
  }

  if (tail === "/matrix") {
    const workspace = panelWorkspace(url);
    const loaded = loadLibrary(config, workspace, "lattice panel");
    const feature = (url.searchParams.get("feature") || "").trim();
    const keys = (url.searchParams.get("keys") || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    sendJson(res, 200, { ok: true, ...buildMatrix(loaded.entries, { feature, keys }) });
    return;
  }

  if (tail === "/export") {
    const format = (url.searchParams.get("format") || "json").trim().toLowerCase();
    if (!EXPORT_FORMATS.includes(format)) {
      sendJson(res, 400, { ok: false, error: { code: "bad-format", message: `format must be one of ${EXPORT_FORMATS.join(", ")}` } });
      return;
    }
    let exported;
    try {
      exported = exportableEntries(config, "lattice export");
    } catch (err) {
      sendJson(res, 409, { ok: false, error: { code: "not-configured", message: String((err && err.message) || err) } });
      return;
    }
    const ids = (url.searchParams.get("ids") || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const selected = filterEntries(exported.entries, {
      ids: ids.length > 0 ? ids : undefined,
      feature: url.searchParams.get("feature") || "",
      kind: url.searchParams.get("kind") || "",
      status: url.searchParams.get("status") || "",
    });
    let content;
    if (format === "json") content = JSON.stringify(exportJson(selected, { source: exported.root, overlay: 0 }), null, 2);
    else if (format === "skill") content = exportSkill(selected, { source: exported.root });
    else content = exportAgents(selected, { source: exported.root });
    sendJson(res, 200, { ok: true, format, count: selected.length, content });
    return;
  }

  if (tail === "/compose") {
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "POST only" } });
      return;
    }
    ensureWritable(config, "lattice compose");
    const text = await readRequestBody(req, PANEL_BODY_LIMIT);
    let body;
    try {
      body = text === "" ? {} : JSON.parse(text);
    } catch {
      sendJson(res, 400, { ok: false, error: { code: "invalid-json", message: "request body is not valid JSON" } });
      return;
    }
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const feature = typeof body.feature === "string" ? body.feature.trim() : "";
    if (title === "" || feature === "") {
      sendJson(res, 400, { ok: false, error: { code: "missing-fields", message: "title and feature are required" } });
      return;
    }
    let root;
    try {
      root = activeRootOrThrow(config, "lattice compose");
    } catch (err) {
      sendJson(res, 409, { ok: false, error: { code: "not-configured", message: String((err && err.message) || err) } });
      return;
    }
    const wantedKind = typeof body.kind === "string" ? body.kind.trim().toLowerCase() : "";
    const kind = ENTRY_KINDS.includes(wantedKind) ? wantedKind : "note";
    const slug = slugify(title);
    const id = isEntryId(slug) ? slug : `memory-${Date.now()}`;
    const now = new Date().toISOString();
    let entry;
    try {
      entry = normalizeEntry(
        {
          id,
          kind,
          title,
          summary: typeof body.summary === "string" ? body.summary.trim() : "",
          feature,
          tags: parseCsv(body.tags),
          dims: parseDimsJson(body.dims) ?? {},
          status: "draft",
          confidence: "low",
          evidence: parseEvidence(body.evidence),
          created: now,
          updated: now,
        },
        typeof body.body === "string" ? body.body.trim() : "",
        null,
      );
      rejectSecrets("lattice compose", entry);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: { code: "invalid-entry", message: String((err && err.message) || err) } });
      return;
    }
    const existing = loadEntries(root).entries;
    const clash = existing.find((item) => item.id === entry.id);
    if (clash) {
      sendJson(res, 409, { ok: false, error: { code: "id-exists", message: `${entry.id} already exists; pick another title or edit that entry instead.` } });
      return;
    }
    const similar = findSimilar(existing, entry);
    const close = similar.filter((item) => item.score >= config.lint.similarityThreshold);
    if (close.length > 0) {
      sendJson(res, 409, {
        ok: false,
        error: {
          code: "near-duplicate",
          message: `refused as a near-duplicate of ${close.map((item) => `${item.id} (${item.score})`).join(", ")}; edit that entry instead or lower lint.similarityThreshold.`,
        },
      });
      return;
    }
    let saved;
    try {
      saved = saveEntry(root, entry, { overwrite: false });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: { code: "save-failed", message: String((err && err.message) || err) } });
      return;
    }
    if (!saved || !saved.ok) {
      sendJson(res, 400, { ok: false, error: { code: "save-failed", message: String((saved && saved.message) || "could not write the entry") } });
      return;
    }
    clearEntriesCache();
    sendJson(res, 200, { ok: true, id: entry.id, file: saved.file ?? entry.file, kind: entry.kind });
    return;
  }

  if (tail === "/import") {
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "POST only" } });
      return;
    }
    ensureWritable(config, "lattice import");
    const text = await readRequestBody(req, PANEL_BODY_LIMIT);
    let payload;
    try {
      payload = text === "" ? {} : JSON.parse(text);
    } catch {
      sendJson(res, 400, { ok: false, error: { code: "invalid-json", message: "request body is not valid JSON" } });
      return;
    }
    const data = payload && typeof payload.data === "string" ? payload.data : payload && typeof payload.data === "object" ? JSON.stringify(payload.data) : "";
    if (data === "" && payload && typeof payload.markdown === "string" && payload.markdown.trim() !== "") {
      // A single entry as a plain Markdown file (frontmatter + body).
      const doc = parseDocument(payload.markdown);
      if (!doc || !doc.data || typeof doc.data !== "object") {
        sendJson(res, 400, { ok: false, error: { code: "invalid-markdown", message: "the .md file has no YAML frontmatter block" } });
        return;
      }
      let record;
      try {
        record = normalizeEntry(doc.data, doc.body, "");
      } catch (err) {
        sendJson(res, 400, { ok: false, error: { code: "invalid-entry", message: String((err && err.message) || err) } });
        return;
      }
      payload = { ...payload, data: JSON.stringify({ schema: "lattice-export/1", entries: [record] }) };
    }
    const resolvedData = payload && typeof payload.data === "string" ? payload.data : "";
    if (resolvedData === "") {
      sendJson(res, 400, { ok: false, error: { code: "missing-data", message: "pass the export text or object as data (or a single entry as markdown)" } });
      return;
    }
    let root;
    try {
      root = activeRootOrThrow(config, "lattice import");
    } catch (err) {
      sendJson(res, 409, { ok: false, error: { code: "not-configured", message: String((err && err.message) || err) } });
      return;
    }
    const existing = loadEntries(root).entries;
    const plan = planImport(existing, resolvedData, { similarityThreshold: config.lint.similarityThreshold });
    const dryRun = payload.dry_run !== false;
    const added = [];
    if (!dryRun) {
      for (const entry of plan.toAdd) {
        rejectSecrets("lattice import", entry);
        saveEntry(root, entry, { overwrite: false });
        added.push(entry.id);
      }
    }
    sendJson(res, 200, {
      ok: true,
      dry_run: dryRun,
      candidates: plan.candidates,
      added,
      conflicts: plan.conflicts,
      problems: plan.problems,
    });
    return;
  }

  if (tail === "/background") {
    if (method === "GET") {
      const stored = readBackgroundBytes();
      if (!stored) {
        sendJson(res, 404, { ok: false, error: { code: "no-background", message: "no panel background has been set" } });
        return;
      }
      res.writeHead(200, {
        "Content-Type": stored.mime,
        "Cache-Control": "no-store",
        "Content-Length": String(stored.bytes.length),
      });
      res.end(stored.bytes);
      return;
    }
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: { code: "method-not-allowed", message: "GET or POST" } });
      return;
    }
    const text = await readRequestBody(req, BACKGROUND_LIMITS.bodyLimit);
    if (text === "") {
      sendJson(res, 413, { ok: false, error: { code: "body-too-large", message: `background payload is too large (limit ${BACKGROUND_LIMITS.bodyLimit} bytes)` } });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      sendJson(res, 400, { ok: false, error: { code: "invalid-json", message: "request body is not valid JSON" } });
      return;
    }
    if (payload && (payload.clear === true || payload.data_url === "")) {
      const removed = clearBackground();
      sendJson(res, 200, { ok: true, cleared: removed, background: readBackgroundMeta() });
      return;
    }
    if (!payload || typeof payload.data_url !== "string" || payload.data_url === "") {
      sendJson(res, 400, { ok: false, error: { code: "missing-data", message: "pass data_url (a base64 image data URL) or clear=true" } });
      return;
    }
    let saved;
    try {
      saved = saveBackgroundDataUrl(payload.data_url);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: { code: "background-rejected", message: String((err && err.message) || err) } });
      return;
    }
    sendJson(res, 200, { ok: true, background: readBackgroundMeta(), saved: { mime: saved.mime, bytes: saved.bytes } });
    return;
  }

  sendJson(res, 404, { ok: false, error: { code: "not-found", message: `unknown panel endpoint "${tail}"`, endpoints: PANEL_ENDPOINTS } });
}

/** Resident prompt section (short; text is cheap to rebuild per step). */

function mountPrompt(ctx, config) {
  ctx.inject(["systemPrompt"], (scoped) => {
    scoped.effect(
      () =>
        scoped.systemPrompt.section({
          name: SECTION_NAME,
          text: (context) => renderPromptSection(config, context),
        }),
      "dsh-lattice-memory: prompt section",
    );
  });
}

/**
 * Store one capture candidate as a draft entry. Shares the record path's
 * guarantees: read-only refusal, credential scan, id collision and
 * near-duplicate refusal before the file is written.
 */
function storeCandidate(config, candidate, overrides = {}) {
  ensureWritable(config, "lattice_capture");
  const root = activeRootOrThrow(config, "lattice_capture");
  const title = typeof overrides.title === "string" && overrides.title.trim() !== "" ? overrides.title.trim() : candidate.title;
  const kind = (() => {
    const wanted = typeof overrides.kind === "string" && overrides.kind.trim() !== "" ? overrides.kind.trim().toLowerCase() : candidate.kind;
    return ENTRY_KINDS.includes(wanted) ? wanted : "gotcha";
  })();
  const feature = typeof overrides.feature === "string" && overrides.feature.trim() !== ""
    ? overrides.feature.trim()
    : candidate.feature || "debugging";
  const summary = typeof overrides.summary === "string" ? overrides.summary.trim() : candidate.summary ?? "";
  const body = typeof overrides.body === "string" && overrides.body.trim() !== ""
    ? overrides.body.trim()
    : candidate.body ?? "";
  const evidence = overrides.evidence !== undefined && String(overrides.evidence).trim() !== ""
    ? parseEvidence(overrides.evidence)
    : Array.isArray(candidate.evidence) ? candidate.evidence : [];
  const dims = overrides.dims !== undefined && String(overrides.dims).trim() !== ""
    ? parseDimsJson(overrides.dims) ?? candidate.dims ?? {}
    : candidate.dims ?? {};
  const id = `capture-${String(candidate.id).split("-").pop() || hashSuffix(title)}`;
  const entry = normalizeEntry(
    {
      id,
      kind,
      title,
      summary,
      feature,
      tags: parseCsv(overrides.tags),
      dims,
      status: "draft",
      confidence: "low",
      evidence,
    },
    body,
    null,
  );
  rejectSecrets("lattice_capture", entry);

  const existing = loadEntries(root).entries;
  if (existing.some((item) => item.id === entry.id)) {
    throw new Error(`lattice_capture: ${entry.id} already exists; accept this candidate with a different title or discard it.`);
  }
  const similar = findSimilar(existing, entry);
  const close = similar.filter((item) => item.score >= config.lint.similarityThreshold);
  if (close.length > 0) {
    throw new Error(
      `lattice_capture: refused as a near-duplicate of ${close.map((item) => `${item.id} (${item.score})`).join(", ")}; merge into that entry instead, or discard this candidate.`,
    );
  }
  const saved = saveEntry(root, entry, { overwrite: false });
  if (!saved.ok) throw new Error(`lattice_capture: ${saved.message}`);
  return { entry, saved, similar };
}

/** Automatic capture (M6/M7): review and decide pending candidates. */
function captureTool(ctx, config) {
  return defineTool({
    name: "lattice_capture",
    description:
      "Review memory-capture candidates. The host queues one when a tool failed and a later retry (or a human correction) proved the failure recoverable in the same session; nothing is stored in the library until you accept. action=list shows pending candidates, action=accept stores one as a draft entry (title/kind/feature/summary/body/evidence/dims may be overridden), action=discard drops it. With capture.mode=draft/auto the host already wrote drafts and this tool only reviews leftovers.",
    parameters: {
      action: { type: "string", required: true, description: "list | accept | discard." },
      id: { type: "string", description: "Candidate id, as returned by action=list. Required for accept/discard unless all=true." },
      all: { type: "boolean", description: "Apply accept/discard to every pending candidate." },
      title: { type: "string", description: "Override the entry title when accepting." },
      kind: { type: "string", description: `Override the entry kind when accepting: ${ENTRY_KINDS.join(" | ")}.` },
      feature: { type: "string", description: "Override the entry feature (capability/area) when accepting." },
      summary: { type: "string", description: "Override the short summary when accepting." },
      body: { type: "string", description: "Override the Markdown body when accepting." },
      evidence: { type: "string", description: "Override evidence items (file:/run:/url:; JSON array or newline list)." },
      dims: { type: "string", description: 'Override dimensions, e.g. {"game":"minecraft","mcver":"1.20.1"}; empty = keep captured dims.' },
      tags: { type: "string", description: "Comma-separated tags for the accepted entry." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true, description: "Always true on success (errors throw)." },
          action: { type: "string", required: true, description: "Action executed." },
          count: { type: "number", required: true, description: "Pending candidates after the action." },
          pending_json: { type: "string", required: true, description: "JSON array of the pending candidates (id/tool/kind/title/summary/count/createdAt/workspace)." },
          saved_json: { type: "string", required: true, description: "JSON array of {id,file} entries written by an accept." },
          removed: { type: "number", required: true, description: "How many candidates a discard/accept removed from the queue." },
          note: { type: "string", required: true, description: "Next-step hint." },
        },
      },
      render: textRender((value) => {
        const lines = [
          `lattice_capture: ${value.action}; ${value.count} pending candidate(s) left; removed ${value.removed}`,
        ];
        let pending = [];
        try {
          pending = JSON.parse(value.pending_json ?? "[]");
        } catch {
          pending = [];
        }
        for (const item of pending) {
          lines.push(`- ${item.id} · ${item.tool} ×${item.count} · ${item.title}`);
          if (item.summary) lines.push(`  ${item.summary}`);
          if (item.workspace) lines.push(`  workspace: ${item.workspace}`);
        }
        if (value.saved_json !== "[]") lines.push(`stored: ${value.saved_json}`);
        if (value.note) lines.push(value.note);
        return lines.join("\n");
      }),
    },
    execute: async (args) => {
      const action = String(args.action ?? "").trim().toLowerCase();
      if (!["list", "accept", "discard"].includes(action)) {
        throw new Error("lattice_capture: action must be list, accept or discard");
      }
      const sum = (items) => JSON.stringify(items.map((item) => ({
        id: item.id,
        tool: item.tool,
        kind: item.kind,
        title: item.title,
        summary: item.summary,
        count: item.count ?? 1,
        createdAt: item.createdAt,
        workspace: item.workspace ?? "",
      })));
      const pending = listCandidates();
      if (action === "list") {
        return {
          ok: true,
          action,
          count: pending.length,
          pending_json: sum(pending),
          saved_json: "[]",
          removed: 0,
          note:
            pending.length === 0
              ? "No pending candidates. Candidates appear when a tool fails and a later retry succeeds, or when a human correction points at an open failure (capture.enabled)."
              : 'Pass id="<candidate id>" or all=true to accept/discard. Accepted entries are drafts with low confidence — rewrite the body and run lattice_verify afterwards.',
        };
      }
      const wanted = args.all === true
        ? pending.map((item) => item.id)
        : [String(args.id ?? "").trim()].filter((id) => id !== "");
      if (wanted.length === 0) throw new Error('lattice_capture: pass id="<candidate id>" or all=true');

      if (action === "discard") {
        const removed = removeCandidates(wanted);
        return {
          ok: true,
          action,
          count: listCandidates().length,
          pending_json: sum(listCandidates()),
          saved_json: "[]",
          removed,
          note: "Discarded; nothing was written to the library.",
        };
      }

      const saved = [];
      for (const id of wanted) {
        const candidate = pending.find((item) => item.id === id);
        if (!candidate) throw new Error(`lattice_capture: no pending candidate with id ${id}`);
        const stored = storeCandidate(config, candidate, args);
        saved.push({ id: stored.entry.id, file: stored.saved.file });
      }
      removeCandidates(wanted);
      return {
        ok: true,
        action,
        count: listCandidates().length,
        pending_json: sum(listCandidates()),
        saved_json: JSON.stringify(saved),
        removed: wanted.length,
        note: "Stored as draft(s). Rewrite the body with the real fix and run lattice_verify to promote them.",
      };
    },
  });
}

/**
 * Mount the capture listeners (M6/M7). `tools/result` is a plain observation
 * event (results are frozen) and `session/event` only reports user messages and
 * turn boundaries, so capture can never change a tool output or a session
 * message; a throwing handler is swallowed so execution is unaffected.
 */
function attachCapture(ctx, config) {
  if (!config.capture.enabled) return;
  if (typeof ctx.on !== "function") return;
  const tracker = createSessionCaptureTracker({
    forgetAfterMs: config.capture.incidentMinutes * 60 * 1000,
  });

  /** Turn one recovered incident into a candidate (queue or draft). */
  const publish = (incident, workspace) => {
    try {
      const dims = workspace.trim() === "" ? {} : detectForWorkspace(config, workspace).dims;
      const candidate = buildIncidentCandidate({ incident, dims, workspace });
      if (config.capture.mode !== "notify") {
        try {
          storeCandidate(config, candidate);
          return;
        } catch (err) {
          /* fall back to the queue so the candidate is not lost */
        }
      }
      addCandidate(candidate, { maxPending: config.capture.maxPending });
    } catch (err) {
      /* capture must never break tool execution */
    }
  };

  /** Text workspace of an agent ("" when unavailable). */
  const workspaceOf = (agent) => {
    try {
      const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : "";
      return typeof cwd === "string" && cwd.trim() !== "" ? cwd : "";
    } catch (err) {
      return "";
    }
  };

  const sessionKeyOf = (value) => {
    try {
      if (value && typeof value.id === "string" && value.id !== "") return value.id;
    } catch (err) {
      /* ignore */
    }
    return "";
  };

  const onResult = (exec, result) => {
    try {
      const session = exec && exec.agent ? exec.agent.session : null;
      const sessionKey = sessionKeyOf(session);
      if (sessionKey === "") return;
      const tool = typeof exec.name === "string" ? exec.name : "";
      const text = result && result.isError === true ? extractErrorText(result) : "";
      const recovered = tracker.recordTool({
        sessionKey,
        tool,
        isError: Boolean(result && result.isError === true),
        errorText: text,
      }).recovered;
      for (const incident of recovered) publish(incident, workspaceOf(exec.agent));
    } catch (err) {
      /* capture must never break tool execution */
    }
  };

  const onSessionEvent = (session, event) => {
    try {
      const sessionKey = sessionKeyOf(session);
      if (sessionKey === "" || !event || typeof event.type !== "string") return;
      if (event.type === "user/message" && config.capture.detectUserCorrections) {
        const data = event.data ?? {};
        const source = data.source;
        if (!source || source.kind !== "user") return;
        tracker.userMessage({ sessionKey, text: messageText(data) });
        return;
      }
      if (event.type !== "turn/end") return;
      const recovered = tracker.endTurn({ sessionKey });
      for (const incident of recovered) publish(incident, workspaceOf(session));
    } catch (err) {
      /* capture must never break the session pipeline */
    }
  };

  // The session-level view (user corrections + turn boundaries) needs the
  // session plumbing; without it the tool-result listener still works.
  ctx.effect(() => ctx.on("tools/result", onResult), "dsh-lattice-memory: capture listener");
  ctx.effect(() => ctx.on("session/event", onSessionEvent), "dsh-lattice-memory: capture session listener");
}

/**
 * Plugin entry. Exported exactly as `apply` + `name` + `inject` + `Config`;
 * no `default` export (the Cordis loader treats any default as authoritative).
 */
export function apply(ctx, rawConfig) {
  let config;
  try {
    config = resolveConfig(rawConfig);
  } catch (err) {
    bootLog(`apply: resolveConfig threw: ${(err && err.stack) || err}`);
    throw err;
  }
  bootLog(`apply: start (panel ${PANEL_VERSION})`);
  try {
    const tools = [
      setupTool(config),
      statusTool(config),
      profileTool(ctx, config),
      searchTool(ctx, config),
      getTool(ctx, config),
      listTool(ctx, config),
      briefTool(ctx, config),
      matrixTool(ctx, config),
      gapsTool(ctx, config),
      recordTool(config),
      verifyTool(config),
      lintTool(ctx, config),
      exportTool(config),
      importTool(config),
      captureTool(ctx, config),
      updateTool(config),
    ];
    for (const tool of tools) {
      ctx.effect(() => ctx.tools.register(tool), `dsh-lattice-memory: tool ${tool.name}`);
    }

    mountPrompt(ctx, config);
    mountPanelRoutes(ctx, config);
    attachCapture(ctx, config);
  } catch (err) {
    bootLog(`apply: threw: ${(err && err.stack) || err}`);
    throw err;
  }

  try {
    const active = resolveActiveRoot(config);
    ctx.logger?.info?.(
      "dsh-lattice-memory: mounted; library %s",
      active.root === null ? "not configured (first-run card pending)" : active.root,
    );
  } catch (err) {
    /* logging must never break mounting */
  }
  bootLog("apply: ready");
}
