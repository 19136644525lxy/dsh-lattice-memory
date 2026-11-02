/**
 * Lattice (dsh-lattice-memory) — host half.
 *
 * Cross-project, version-aware project memory for DSH. M0 scope (this file):
 *   - bundle skeleton + schemastery Config;
 *   - library root state (`<DSH_HOME>/lattice/root.json`) and validation;
 *   - first-run onboarding: web routes for the client card + `lattice_setup`;
 *   - tool stubs: lattice_status / lattice_profile / lattice_search, plus a
 *     resident prompt section that tells the model where the library lives.
 *
 * Retrieval, record/verify and matrix tools arrive in M1–M3 (see PLAN.md).
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { appendFileSync, mkdirSync } from "node:fs";
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

export const name = "dsh-lattice-memory";

/** Mount as soon as the tool registry exists; other services are optional. */
export const inject = ["tools"];

const SECTION_NAME = "dsh-lattice-memory";
const API_STATE = "/lattice/state";
const API_SETUP = "/lattice/setup";
const BODY_LIMIT = 8 * 1024;

/** Defaults kept in one place: schema defaults, direct-call defaults, docs. */
const DEFAULTS = Object.freeze({
  topK: 8,
  maxTokens: 1500,
  staleDays: 180,
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
        enabled: z.boolean().default(true).description("Reserved (M2): inject a small resident index section."),
        topK: z.number().step(1).min(1).default(DEFAULTS.topK).description("Reserved (M2): resident entries."),
        maxTokens: z.number().step(1).min(0).default(DEFAULTS.maxTokens).description("Reserved (M2): resident token budget."),
      })
      .default({}),
    projectOverlay: z
      .boolean()
      .default(false)
      .description("Reserved (M2): also read <workspace>/.lattice overlay entries."),
    staleDays: z
      .number()
      .step(1)
      .min(0)
      .default(DEFAULTS.staleDays)
      .description("Days after verified_on before an entry is reported stale."),
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

/** Resident prompt section: short, stable, cheap to re-render per step. */
function renderPromptSection(config) {
  const active = resolveActiveRoot(config);
  if (active.root === null) {
    return [
      "Lattice (dsh-lattice-memory) is installed but has no shared memory library yet.",
      "First-run setup: the Lattice card in the web UI lets the user pick the library folder; programmatic setup is `lattice_setup` (path=...), and `use_default=true` uses the default location.",
      "Until a root is configured, do not claim to have recalled project memory — there is none.",
    ].join("\n");
  }
  const library = inspectLibraryRoot(active.root);
  const lines = [
    "Lattice (dsh-lattice-memory) is active.",
    `Shared project memory library: ${active.root} (entries: ${library.entries}).`,
    "Entries are Markdown files with YAML frontmatter (id, kind, title, feature, dims, status, evidence).",
    "Before version- or environment-sensitive work, call lattice_profile to identify the current workspace, then lattice_search with the feature/keywords; only results whose dims match the current profile should be treated as applicable.",
    "Retrieval/matrix tooling is milestone-gated (M1–M3): if a tool is missing or returns a stub note, fall back to reading the entry files directly and say so.",
  ];
  return lines.join("\n");
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
          top_k: { type: "number", required: true, description: "Configured resident entries (reserved, M2)." },
          max_tokens: { type: "number", required: true, description: "Configured resident token budget (reserved, M2)." },
          stale_days: { type: "number", required: true, description: "Entry staleness threshold in days." },
        },
      },
      render: textRender((value) =>
        [
          `Lattice: ${value.configured ? `library at ${value.root}` : "not configured"}`,
          `configured=${value.configured} is_library=${value.is_library} entries=${value.entries} root_source=${value.root_source || "-"}`,
          `default_root=${value.default_root}`,
          `state_dir=${value.state_dir}`,
          `inject topK=${value.top_k} maxTokens=${value.max_tokens} staleDays=${value.stale_days}`,
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
        top_k: config.inject.topK,
        max_tokens: config.inject.maxTokens,
        stale_days: config.staleDays,
      };
    },
  });
}

function profileTool() {
  return defineTool({
    name: "lattice_profile",
    description:
      "Detect the calling workspace's project profile from its own metadata (gradle.properties, mods.toml/neoforge.mods.toml/fabric.mod.json, package.json, pyproject.toml, Cargo.toml, AndroidManifest.xml, git branch). Returns a preset name and the dimension map (game/mcver/loader/platform/...) used to filter Lattice memory entries. Pass path to inspect a workspace other than the host cwd.",
    parameters: {
      path: {
        type: "string",
        description: "Workspace folder to inspect; defaults to the host process cwd.",
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
        },
      },
      render: textRender((value) =>
        [
          `Lattice profile: preset=${value.preset} workspace=${value.workspace}`,
          `dims: ${value.dims_json}`,
          `signals: ${value.signals || "(none)"}`,
        ].join("\n"),
      ),
    },
    execute: async (args) => {
      const detected = detectProject(args.path && args.path.trim() !== "" ? args.path : process.cwd());
      return {
        workspace: detected.workspace,
        preset: detected.preset,
        dims_json: JSON.stringify(detected.dims),
        signals: detected.signals.join(", "),
      };
    },
  });
}

function searchTool(config) {
  return defineTool({
    name: "lattice_search",
    description:
      "Search the shared Lattice memory library for entries relevant to a query (feature name, error text, API name). M0 stub: validates the library and reports its state; BM25 retrieval + dimension filtering + the matrix/gaps tools land in M1–M2.",
    parameters: {
      query: {
        type: "string",
        required: true,
        description: "What to look for (feature, error message, symbol, port target).",
      },
      top_k: {
        type: "number",
        description: "Maximum results to return (reserved for M1; defaults to the configured topK).",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", required: true, description: "The query as received." },
          total: { type: "number", required: true, description: "Number of results returned (0 in M0)." },
          note: { type: "string", required: true, description: "Status or milestone note." },
        },
      },
      render: textRender((value) => `lattice_search "${value.query}": ${value.total} result(s). ${value.note}`),
    },
    execute: async (args) => {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (query === "") throw new Error("lattice_search: query must not be empty");
      const active = resolveActiveRoot(config);
      if (active.root === null) {
        throw new Error(
          "lattice_search: the Lattice library is not configured yet. Ask the user to finish the first-run card, or call lattice_setup with the folder picked.",
        );
      }
      const library = inspectLibraryRoot(active.root);
      return {
        query,
        total: 0,
        note: `library ${active.root} is ready with ${library.entries} entries; BM25 retrieval lands in M1 (this is the M0 stub).`,
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

/** First-run onboarding routes (only when the profile has a webServer). */
function mountRoutes(ctx, config) {
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
  });
}

/** Resident prompt section (short; text is cheap to rebuild per step). */
function mountPrompt(ctx, config) {
  ctx.inject(["systemPrompt"], (scoped) => {
    scoped.effect(
      () =>
        scoped.systemPrompt.section({
          name: SECTION_NAME,
          text: () => renderPromptSection(config),
        }),
      "dsh-lattice-memory: prompt section",
    );
  });
}

/**
 * Plugin entry. Exported exactly as `apply` + `name` + `inject` + `Config`;
 * no `default` export (the Cordis loader treats any default as authoritative).
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);

  const tools = [setupTool(config), statusTool(config), profileTool(), searchTool(config)];
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-lattice-memory: tool ${tool.name}`);
  }

  mountPrompt(ctx, config);
  mountRoutes(ctx, config);

  try {
    const active = resolveActiveRoot(config);
    ctx.logger?.info?.(
      "dsh-lattice-memory: mounted; library %s",
      active.root === null ? "not configured (first-run card pending)" : active.root,
    );
  } catch (err) {
    /* logging must never break mounting */
  }
}
