/**
 * Lattice — browser half.
 *
 * A hand-written `dsh.client` ModuleLoader bundle (no build step).
 *
 * Two slots:
 *   - `shell.overlay`: first-run onboarding card, shown only while the host
 *     reports no configured library root (`GET /lattice-panel/state`,
 *     `POST /lattice-panel/setup`).
 *   - `settings.section`: the Lattice panel in the settings UI — browse,
 *     search, matrix grid, and portable export/import.
 *
 * All data routes live under one prefix (`/lattice-panel/*`) behind the host
 * browser-trust fence. The panel probes `/lattice-panel/version` first, so a
 * host without the route can never masquerade as "library empty".
 */
window.__ModuleLoader__.load({
  id: "dsh-lattice-memory",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = react;

    const API = "/lattice-panel";
    const API_VERSION = API + "/version";
    const API_STATE = API + "/state";
    const API_SETUP = API + "/setup";
    const API_ENTRIES = API + "/entries";
    const API_ENTRY = API + "/entry";
    const API_MATRIX = API + "/matrix";
    const API_EXPORT = API + "/export";
    const API_IMPORT = API + "/import";
    const API_COMPOSE = API + "/compose";
    const API_BACKGROUND = API + "/background";
    const API_CAPTURES = API + "/captures";
    const API_CLEAR = API + "/clear";
    const API_DELETE = API + "/delete";
    const API_BACKUP = API + "/backup";
    const API_RESTORE = API + "/restore";
    const API_PICK_DIRECTORY = API + "/pick-directory";
    const API_UPDATE = API + "/update";
    const DISMISS_KEY = "dsh-lattice-memory:onboarding-dismissed";

    // Captured in apply() so components can reach the host directory picker
    // (the same service the workspace "add folder" flow uses).
    let slotCtx = null;

    async function pickDirectoryDialog() {
      const ctx = slotCtx;
      if (!ctx) return null;
      try {
        if (ctx.uiWorkspace && typeof ctx.uiWorkspace.pickDirectory === "function") {
          const picked = await ctx.uiWorkspace.pickDirectory();
          if (typeof picked === "string" && picked.trim() !== "") return picked;
        }
      } catch (error) {
        /* fall through to the remote verb */
      }
      try {
        const remote = ctx.remote && ctx.remote.directoryPicker;
        if (remote && typeof remote.pick === "function") {
          const picked = await remote.pick();
          if (typeof picked === "string" && picked.trim() !== "") return picked;
        }
      } catch (error) {
        /* no picker available; the text field stays usable */
      }
      return null;
    }

    const C = {
      text: "var(--dsw-alias-label-primary, #1f2328)",
      muted: "var(--dsw-alias-label-tertiary, #6e7781)",
      subtle: "var(--dsw-alias-label-secondary, #57606a)",
      border: "var(--dsw-alias-border-l2, rgba(31,35,40,.14))",
      surface: "var(--dsw-alias-bg-layer-1, #ffffff)",
      layer2: "var(--dsw-alias-bg-layer-2, #f3f5f8)",
      layer3: "var(--dsw-alias-bg-layer-3, #eef1f5)",
      accent: "var(--dsw-alias-state-business-primary, #3964fe)",
      accentSoft: "color-mix(in srgb, var(--dsw-alias-state-business-primary, #3964fe) 12%, transparent)",
      error: "var(--dsw-alias-state-error-primary, #cf222e)",
      ok: "var(--dsw-alias-state-success-primary, #1a7f37)",
      warn: "var(--dsw-alias-state-warning-primary, #9a6700)",
      mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    };

    const STATUS_TONE = {
      verified: C.ok,
      draft: C.warn,
      stale: C.muted,
      deprecated: C.muted,
      superseded: C.muted,
    };

    const KIND_LABEL = {
      contract: "契约",
      decision: "决策",
      gotcha: "坑",
      port: "移植",
      checklist: "清单",
      reference: "参考",
      note: "笔记",
    };

    /* ------------------------------------------------------------------ */
    /* transport                                                          */
    /* ------------------------------------------------------------------ */

    async function errorDetail(res) {
      const text = await res.text().catch(() => "");
      if (text === "") return `${res.status} ${res.statusText || ""}`.trim();
      try {
        const parsed = JSON.parse(text);
        const error = parsed && parsed.error;
        if (error && typeof error.message === "string") return error.message;
      } catch {
        /* not JSON: fall through to the raw snippet */
      }
      return text.slice(0, 180);
    }

    async function getJson(url) {
      const res = await fetch(url, { headers: { accept: "application/json" }, credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status} · ${await errorDetail(res)}`);
      return res.json();
    }

    async function postJson(url, payload) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} · ${await errorDetail(res)}`);
      return res.json();
    }

    /* ------------------------------------------------------------------ */
    /* shared bits                                                        */
    /* ------------------------------------------------------------------ */

    function isDismissed() {
      try {
        return window.sessionStorage.getItem(DISMISS_KEY) === "1";
      } catch {
        return false;
      }
    }

    function markDismissed() {
      try {
        window.sessionStorage.setItem(DISMISS_KEY, "1");
      } catch {
        /* private mode: dismissal is best-effort */
      }
    }

    function buttonStyle(kind, disabled) {
      const primary = kind === "primary";
      const danger = kind === "danger";
      return {
        border: `1px solid ${primary ? C.accent : danger ? C.error : C.border}`,
        background: primary ? C.accent : danger ? "transparent" : C.layer2,
        color: primary ? "#fff" : danger ? C.error : C.text,
        borderRadius: 8,
        padding: "6px 13px",
        fontSize: 12.5,
        lineHeight: "18px",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        fontFamily: "inherit",
      };
    }

    function pillStyle(tone) {
      const color = tone || C.muted;
      return {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 7px",
        borderRadius: 999,
        border: `1px solid ${color === C.muted ? C.border : color}`,
        color,
        fontSize: 11,
        lineHeight: "16px",
        whiteSpace: "nowrap",
      };
    }

    function inputStyle() {
      return {
        width: "100%",
        boxSizing: "border-box",
        border: `1px solid ${C.border}`,
        borderRadius: 9,
        background: C.surface,
        color: C.text,
        padding: "8px 11px",
        fontSize: 13,
        fontFamily: "inherit",
        outline: "none",
      };
    }

    function Empty({ title, hint }) {
      return h(
        "div",
        { style: { padding: "26px 6px", textAlign: "center", color: C.muted } },
        h("div", { style: { fontSize: 13.5, color: C.subtle, marginBottom: 6 } }, title),
        hint ? h("div", { style: { fontSize: 12 } }, hint) : null,
      );
    }

    function Notice({ tone = "error", children }) {
      const color = tone === "ok" ? C.ok : tone === "warn" ? C.warn : tone === "info" ? C.subtle : C.error;
      return h(
        "div",
        {
          style: {
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            border: `1px solid ${color}`,
            background: "color-mix(in srgb, currentColor 7%, transparent)",
            color,
            borderRadius: 9,
            padding: "8px 11px",
            fontSize: 12.5,
            lineHeight: 1.5,
            wordBreak: "break-word",
          },
        },
        h("span", { style: { flex: "0 0 auto", marginTop: 1 } }, Icon(tone === "ok" ? "check" : tone === "warn" ? "alert" : "alert", 13)),
        h("div", { style: { minWidth: 0 } }, children),
      );
    }

    /* ------------------------------------------------------------------ */
    /* icons (inline, theme-aware; no dependency on the host icon set)     */
    /* ------------------------------------------------------------------ */

    function Icon(name, size = 14) {
      const common = {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.9,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        style: { flex: "0 0 auto" },
      };
      const paths = {
        library: ["M4 5.5h7v13H4z", "M13 5.5h7v13h-7z", "M7.5 9h0.01", "M16.5 9h0.01"],
        search: ["M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z", "M15 15l5 5"],
        grid: ["M4 4h6v6H4z", "M14 4h6v6h-6z", "M4 14h6v6H4z", "M14 14h6v6h-6z"],
        box: ["M4 8l8-4 8 4-8 4-8-4z", "M4 8v8l8 4 8-4V8", "M12 12v8"],
        folder: ["M4 6.5h5l2 2.5h9V19H4z"],
        check: ["M5 12.5l4.5 4.5L19 7"],
        alert: ["M12 4.5l8 14H4l8-14z", "M12 10v4", "M12 17h0.01"],
        copy: ["M9 9h10v11H9z", "M15 9V5H5v11h4"],
        renew: ["M5 12a7 7 0 0 1 12-4.9", "M19 12a7 7 0 0 1-12 4.9", "M17 4v3.5h-3.5", "M7 20v-3.5h3.5"],
        database: ["M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z", "M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6", "M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"],
        chevron: ["M9 6l6 6-6 6"],
      };
      const list = paths[name] || paths.box;
      return h(
        "svg",
        common,
        list.map((d, index) => h("path", { key: String(index), d })),
      );
    }

    /* ------------------------------------------------------------------ */
    /* first-run onboarding card (shell.overlay)                           */
    /* ------------------------------------------------------------------ */

    function OnboardingCard({ ctx }) {
      const [snapshot, setSnapshot] = useState(null);
      const [loading, setLoading] = useState(true);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [doneRoot, setDoneRoot] = useState("");
      const [manual, setManual] = useState("");
      const [showManual, setShowManual] = useState(false);

      const refresh = useCallback(async () => {
        try {
          const body = await getJson(API_STATE);
          const state = body && body.state ? body.state : body;
          setSnapshot(state);
          setError("");
        } catch (err) {
          setSnapshot(null);
          setError(String((err && err.message) || err));
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => {
        refresh();
      }, [refresh]);

      const apply = useCallback(
        async (payload) => {
          setBusy(true);
          try {
            const body = await postJson(API_SETUP, payload);
            setDoneRoot(body.root || "");
            setError("");
            setBusy(false);
            window.setTimeout(() => {
              setSnapshot(null);
              refresh();
            }, 1600);
          } catch (err) {
            setError(String((err && err.message) || err));
            setBusy(false);
          }
        },
        [refresh],
      );

      const pickFolder = useCallback(async () => {
        setError("");
        try {
          const workspace = ctx && (ctx.uiWorkspace || (ctx.get && ctx.get("uiWorkspace")));
          const remote = ctx && (ctx.remote || (ctx.get && ctx.get("remote")));
          const directoryPicker = remote && remote.directoryPicker;
          const picked = workspace && typeof workspace.pickDirectory === "function"
            ? await workspace.pickDirectory()
            : directoryPicker && typeof directoryPicker.pick === "function"
              ? await directoryPicker.pick()
              : null;
          if (picked === null || picked === undefined) {
            setShowManual(true);
            return;
          }
          await apply({ action: "set", path: picked });
        } catch (err) {
          setError(`目录选择器不可用（${String((err && err.message) || err)}），请手填路径。`);
          setShowManual(true);
        }
      }, [apply, ctx]);

      if (isDismissed() && !doneRoot) return null;
      if (loading) return null;
      if (doneRoot !== "") {
        return h(
          "div",
          { style: cardStyle() },
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, color: C.ok, fontSize: 13 } }, Icon("check", 15), "Lattice 记忆库已就绪"),
          h("div", { style: { marginTop: 6, color: C.muted, fontSize: 12, wordBreak: "break-all" } }, doneRoot),
        );
      }
      if (snapshot && snapshot.configured) return null;
      if (snapshot === null && error === "") return null;

      return h(
        "div",
        { style: cardStyle() },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 6 } },
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 13.5 } }, Icon("library", 15), "Lattice · 首次使用"),
          h("button", { type: "button", onClick: () => { markDismissed(); setSnapshot({ configured: true, dismissed: true }); }, style: { ...buttonStyle("ghost"), padding: "2px 8px", fontSize: 12 } }, "稍后"),
        ),
        error !== "" ? h(Notice, null, error) : null,
        h("div", { style: { margin: "8px 0 10px", color: C.subtle, fontSize: 12.5, lineHeight: 1.65 } },
          "选一个文件夹作为共享记忆库：条目按项目维度（版本 / 加载器 / 环境）分区，所有工作区共用；也可以先放到默认位置。"),
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 } },
          h("button", { type: "button", disabled: busy, onClick: pickFolder, style: buttonStyle("primary", busy) }, busy ? "处理中…" : "选择文件夹…"),
          h("button", { type: "button", disabled: busy, onClick: () => apply({ action: "default" }), style: buttonStyle("ghost", busy) }, "使用默认位置"),
        ),
        showManual
          ? h(
              "div",
              { style: { marginTop: 10, display: "flex", gap: 8 } },
              h("input", {
                value: manual,
                onChange: (event) => setManual(event.target.value),
                placeholder: "例如 F:\\Lattice",
                style: { ...inputStyle(), flex: "1 1 auto" },
              }),
              h("button", { type: "button", disabled: busy || manual.trim() === "", onClick: () => apply({ action: "set", path: manual.trim() }), style: buttonStyle("primary", busy || manual.trim() === "") }, "用这个路径"),
            )
          : null,
        h("div", { style: { marginTop: 8, color: C.muted, fontSize: 11.5 } }, "默认位置：", h("span", { style: { fontFamily: C.mono } }, snapshot && snapshot.defaultRoot ? snapshot.defaultRoot : "…")),
      );
    }

    function cardStyle() {
      return {
        position: "fixed",
        right: 22,
        bottom: 22,
        zIndex: 60,
        width: 372,
        maxWidth: "calc(100vw - 44px)",
        boxSizing: "border-box",
        padding: "14px 16px",
        borderRadius: 14,
        border: `1px solid ${C.border}`,
        background: C.surface,
        color: C.text,
        boxShadow: "0 12px 34px rgba(15, 23, 42, .18)",
        fontFamily: "inherit",
        pointerEvents: "auto",
      };
    }

    /* ------------------------------------------------------------------ */
    /* settings panel                                                      */
    /* ------------------------------------------------------------------ */

    const TABS = [
      { id: "browse", label: "浏览", icon: "library" },
      { id: "matrix", label: "矩阵", icon: "grid" },
      { id: "portable", label: "导出/导入", icon: "box" },
      { id: "captures", label: "捕获", icon: "renew" },
    ];

    function Badge({ id, kind, entry }) {
      const parts = [
        h("span", { key: "kind", style: pillStyle(C.subtle) }, KIND_LABEL[entry.kind] || entry.kind),
      ];
      if (entry && entry.status) {
        parts.push(h("span", { key: "status", style: pillStyle(STATUS_TONE[entry.status] || C.muted) }, entry.status));
      }
      if (entry && entry.feature) {
        parts.push(h("span", { key: "feature", style: { ...pillStyle(C.muted), fontFamily: C.mono } }, entry.feature));
      }
      return h("span", { style: { display: "inline-flex", gap: 5, flexWrap: "wrap" } }, parts);
    }

    function dimsChips(dims) {
      if (!dims || typeof dims !== "object") return [];
      return Object.keys(dims)
        .filter((key) => dims[key] !== undefined && dims[key] !== null && dims[key] !== "")
        .slice(0, 6)
        .map((key) => {
          const value = Array.isArray(dims[key]) ? dims[key].join("|") : String(dims[key]);
          return h("span", { key, style: { ...pillStyle(C.muted), fontFamily: C.mono } }, `${key}=${value}`);
        });
    }

    function EntryDetail({ entry, onClose }) {
      return h(
        "div",
        { style: { border: `1px solid ${C.border}`, borderRadius: 12, background: C.layer2, padding: "13px 15px", overflow: "auto" } },
        h("div", { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 } },
          h("div", { style: { minWidth: 0 } },
            h("div", { style: { fontWeight: 600, fontSize: 14, lineHeight: 1.4 } }, entry.title),
            h("div", { style: { color: C.muted, fontFamily: C.mono, fontSize: 11.5, marginTop: 3 } }, entry.id),
          ),
          h("button", { type: "button", onClick: onClose, style: { ...buttonStyle("ghost"), padding: "2px 9px", fontSize: 12 } }, "关闭"),
        ),
        h("div", { style: { display: "flex", gap: 5, flexWrap: "wrap", marginTop: 8 } }, dimsChips(entry.dims)),
        entry.summary ? h("div", { style: { marginTop: 10, fontSize: 12.5, color: C.subtle, lineHeight: 1.6 } }, entry.summary) : null,
        entry.evidence && entry.evidence.length > 0
          ? h("div", { style: { marginTop: 9, fontSize: 11.5, color: C.muted } }, "证据：", entry.evidence.map((item, index) => h("div", { key: String(index), style: { fontFamily: C.mono, wordBreak: "break-all" } }, item)))
          : null,
        h("pre", {
          style: {
            margin: "11px 0 0",
            padding: "10px 12px",
            borderRadius: 9,
            background: C.surface,
            border: `1px solid ${C.border}`,
            color: C.text,
            fontSize: 12,
            lineHeight: 1.62,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 260,
            overflow: "auto",
            fontFamily: "inherit",
          },
        }, entry.body || "（无正文）"),
      );
    }

    function BackupSection({ onRestored }) {
      const [info, setInfo] = useState(null);
      const [dir, setDir] = useState("");
      const [name, setName] = useState("");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [done, setDone] = useState("");
      const [restorePick, setRestorePick] = useState("");
      const [restoreAsk, setRestoreAsk] = useState(false);
      const [restoreBusy, setRestoreBusy] = useState(false);
      const [restoreError, setRestoreError] = useState("");
      const [restoreDone, setRestoreDone] = useState("");

      const load = useCallback(async () => {
        try {
          const body = await getJson(API_BACKUP);
          setInfo(body);
          setDir((previous) => (previous === "" ? (body.configured || "") : previous));
          const backups = Array.isArray(body.backups) ? body.backups : [];
          setRestorePick((previous) => {
            if (previous !== "" && backups.some((item) => item.name === previous)) return previous;
            return backups.length > 0 ? backups[0].name : "";
          });
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const pickFolder = useCallback(async () => {
        setError("");
        try {
          const body = await postJson(API_PICK_DIRECTORY, {});
          if (body && typeof body.path === "string" && body.path.trim() !== "") {
            setDir(body.path.trim());
            return;
          }
          const picked = await pickDirectoryDialog();
          if (picked) setDir(picked);
        } catch (err) {
          const picked = await pickDirectoryDialog();
          if (picked) setDir(picked);
          else setError(String((err && err.message) || err));
        }
      }, []);

      const run = useCallback(async () => {
        setBusy(true);
        setError("");
        setDone("");
        try {
          const body = await postJson(API_BACKUP, { dir: dir.trim(), keep: info ? info.keep : undefined, name: name.trim() });
          setDone(`已备份 ${body.count} 条条目${body.label ? `（${body.label}）` : ""} → ${body.dir}`);
          setName("");
          await load();
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      }, [dir, info, load, name]);

      const runRestore = useCallback(async () => {
        if (restorePick === "") return;
        setRestoreBusy(true);
        setRestoreError("");
        try {
          const body = await postJson(API_RESTORE, { name: restorePick });
          setRestoreDone(`已从 ${body.backup}${body.label ? `（${body.label}）` : ""} 恢复 ${body.restored} 条条目`);
          setRestoreAsk(false);
          await load();
          if (onRestored) onRestored();
        } catch (err) {
          setRestoreError(String((err && err.message) || err));
        } finally {
          setRestoreBusy(false);
        }
      }, [load, onRestored, restorePick]);

      const backups = info && Array.isArray(info.backups) ? info.backups : [];
      const picked = backups.find((item) => item.name === restorePick);

      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 7, border: `1px solid ${C.border}`, borderRadius: 11, padding: "10px 12px" } },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
          h("span", { style: { display: "flex", color: C.accent } }, Icon("database", 14)),
          h("span", { style: { fontSize: 12.5, fontWeight: 600 } }, "备份记忆库"),
          h("span", { style: { color: C.muted, fontSize: 11 } }, info ? `保留最近 ${info.keep} 份 · 已有 ${backups.length} 份` : "读取备份信息…"),
          h("button", { type: "button", title: "重新检测备份目录与备份列表", onClick: () => load(), style: { ...buttonStyle("ghost", false), padding: "2px 8px", fontSize: 11 } }, Icon("renew", 11), h("span", { style: { marginLeft: 4 } }, "刷新")),
        ),
        h(
          "div",
          { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          h("input", {
            value: dir,
            onChange: (event) => setDir(event.target.value),
            placeholder: info ? `留空 = ${info.defaultDir}` : "备份目录（留空 = 插件数据目录/backups）",
            style: { ...inputStyle(), flex: "1 1 220px", fontFamily: C.mono, fontSize: 11.5 },
          }),
          h("button", { type: "button", onClick: () => pickFolder(), style: buttonStyle("ghost", false) }, "选择文件夹…"),
          h(
            "button",
            {
              type: "button",
              title: info ? `填入默认目录：${info.defaultDir}` : "填入默认目录",
              onClick: () => setDir(info && info.defaultDir ? info.defaultDir : ""),
              style: buttonStyle("ghost", false),
            },
            "用默认",
          ),
        ),
        h(
          "div",
          { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          h("input", {
            value: name,
            onChange: (event) => setName(event.target.value),
            placeholder: "备份名称（可选，如 改矩阵前）",
            style: { ...inputStyle(), flex: "1 1 220px" },
          }),
          h("button", { type: "button", onClick: () => run(), disabled: busy, style: buttonStyle("primary", busy) }, busy ? "备份中…" : "立即备份"),
        ),
        info
          ? h(
              "div",
              { style: { color: C.muted, fontSize: 11, lineHeight: 1.6 } },
              `默认目录：${info.defaultDir}`,
              info.installDir && info.installDir !== "" ? `（插件安装位置：${info.installDir}）` : "",
              info.packageDir && info.packageDir !== info.installDir && info.packageDir !== info.pluginRoot ? `（插件包实体：${info.packageDir}）` : "",
            )
          : null,
        info && backups.length === 0
          ? h("div", { style: { color: C.muted, fontSize: 11.5, lineHeight: 1.6 } }, "还没有备份：点「立即备份」生成第一份；生成后这里会出现恢复下拉与「恢复所选备份…」。")
          : null,
        backups.length > 0
          ? h(
              "div",
              { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
              h("span", { style: { color: C.muted, fontSize: 11.5 } }, `恢复备份（共 ${backups.length} 份）：`),
              h(
                "select",
                {
                  value: restorePick,
                  onChange: (event) => setRestorePick(event.target.value),
                  style: { ...inputStyle(), flex: "1 1 260px", fontFamily: C.mono, fontSize: 11.5 },
                },
                backups.map((item) =>
                  h(
                    "option",
                    { key: item.name, value: item.name },
                    `${item.name}${item.label ? ` · ${item.label}` : ""}（${item.entryCount === null || item.entryCount === undefined ? "?" : item.entryCount} 条）`,
                  ),
                ),
              ),
              h("button", { type: "button", onClick: () => setRestoreAsk(true), disabled: restorePick === "", style: buttonStyle("ghost", false) }, "恢复所选备份…"),
            )
          : null,
        restoreAsk
          ? h(
              "div",
              { style: { border: `1px solid ${C.danger || C.border}`, borderRadius: 10, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 7, background: C.dangerSoft || "transparent" } },
              h("div", { style: { fontWeight: 600, fontSize: 12.5 } }, "确认恢复备份"),
              h(
                "div",
                { style: { color: C.muted, fontSize: 11.5, lineHeight: 1.7 } },
                `将从「${picked ? picked.name : restorePick}」恢复 ${picked && picked.entryCount !== null ? picked.entryCount : "?"} 条条目，覆盖同名文件；备份后新增的条目会保留。`,
              ),
              h(
                "div",
                { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
                h("button", { type: "button", onClick: () => setRestoreAsk(false), style: buttonStyle("ghost", false) }, "取消"),
                h("button", { type: "button", onClick: () => runRestore(), disabled: restoreBusy, style: buttonStyle("primary", restoreBusy) }, restoreBusy ? "恢复中…" : "确认恢复"),
              ),
            )
          : null,
        restoreError !== "" ? h(Notice, null, restoreError) : null,
        restoreDone !== "" ? h(Notice, null, restoreDone) : null,
        error !== "" ? h(Notice, null, error) : null,
        done !== "" ? h(Notice, null, done) : null,
      );
    }

    function BrowseTab({ onEntryCount }) {
      const [query, setQuery] = useState("");
      const [mode, setMode] = useState("browse");
      const [items, setItems] = useState([]);
      const [meta, setMeta] = useState(null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState("");
      const [detail, setDetail] = useState(null);
      const [detailError, setDetailError] = useState("");
      const [clearOpen, setClearOpen] = useState(false);
      const [clearLeft, setClearLeft] = useState(30);
      const [clearBusy, setClearBusy] = useState(false);
      const [clearError, setClearError] = useState("");
      const [clearDone, setClearDone] = useState("");
      const [selected, setSelected] = useState([]);
      const [pendingDelete, setPendingDelete] = useState([]);
      const [deleteBusy, setDeleteBusy] = useState(false);
      const [deleteError, setDeleteError] = useState("");
      const [deleteDone, setDeleteDone] = useState("");

      const load = useCallback(async (q) => {
        setLoading(true);
        setError("");
        setDetail(null);
        setDetailError("");
        try {
          const url = q
            ? `${API_ENTRIES}?q=${encodeURIComponent(q)}&limit=80`
            : `${API_ENTRIES}?limit=100`;
          const body = await getJson(url);
          setItems(Array.isArray(body.items) ? body.items : []);
          setMode(body.mode || "browse");
          setMeta({ total: body.total || 0, problems: body.problems || 0, overlay: body.overlay || 0, dims_source: body.dims_source || "", dims: body.dims || null });
          if (onEntryCount) onEntryCount(body.total || 0);
        } catch (err) {
          setItems([]);
          setMeta(null);
          setError(String((err && err.message) || err));
        } finally {
          setLoading(false);
        }
      }, [onEntryCount]);

      useEffect(() => {
        load("");
      }, [load]);

      const openEntry = useCallback(async (id) => {
        setDetailError("");
        try {
          const body = await getJson(`${API_ENTRY}?id=${encodeURIComponent(id)}`);
          setDetail(body.entry);
        } catch (err) {
          setDetailError(String((err && err.message) || err));
        }
      }, []);

      const runClear = useCallback(async () => {
        setClearBusy(true);
        setClearError("");
        try {
          const body = await postJson(API_CLEAR, { confirm: true });
          const removed = body && typeof body.removed === "number" ? body.removed : 0;
          setClearDone(`已清除 ${removed} 条记忆`);
          setClearOpen(false);
          await load("");
        } catch (err) {
          setClearError(String((err && err.message) || err));
        } finally {
          setClearBusy(false);
        }
      }, [load]);

      const toggleSelect = useCallback((id, on) => {
        setSelected((previous) => (on ? (previous.includes(id) ? previous : [...previous, id]) : previous.filter((item) => item !== id)));
      }, []);

      const runDelete = useCallback(async (ids) => {
        if (!Array.isArray(ids) || ids.length === 0) return;
        setDeleteBusy(true);
        setDeleteError("");
        setDeleteDone("");
        try {
          const body = await postJson(API_DELETE, { ids });
          const removed = body && typeof body.removed === "number" ? body.removed : 0;
          const missing = Array.isArray(body && body.missing) ? body.missing.length : 0;
          setDeleteDone(`已删除 ${removed} 条记忆${missing > 0 ? `（${missing} 条未找到）` : ""}`);
          setPendingDelete([]);
          setSelected((previous) => previous.filter((id) => !ids.includes(id)));
          await load(query.trim());
        } catch (err) {
          setDeleteError(String((err && err.message) || err));
        } finally {
          setDeleteBusy(false);
        }
      }, [load, query]);

      useEffect(() => {
        if (!clearOpen) return undefined;
        setClearLeft(30);
        const timer = window.setInterval(() => {
          setClearLeft((previous) => {
            if (previous <= 1) {
              window.clearInterval(timer);
              runClear();
              return 0;
            }
            return previous - 1;
          });
        }, 1000);
        return () => window.clearInterval(timer);
      }, [clearOpen, runClear]);

      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 11 } },
        h(
          "div",
          { style: { display: "flex", gap: 8 } },
          h(
            "div",
            { style: { position: "relative", flex: "1 1 auto" } },
            h("span", { style: { position: "absolute", left: 10, top: 9, color: C.muted, display: "flex" } }, Icon("search", 14)),
            h("input", {
              value: query,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => { if (event.key === "Enter") load(query.trim()); },
              placeholder: "搜索：关键词 / 符号 / 错误文本（留空浏览全部）",
              style: { ...inputStyle(), paddingLeft: 31 },
            }),
          ),
          h("button", { type: "button", disabled: loading, onClick: () => load(query.trim()), style: buttonStyle("primary", loading) }, loading ? "检索中…" : "检索"),
        ),
        meta
          ? h(
              "div",
              { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", color: C.muted, fontSize: 11.5 } },
              h("span", null, `库内共 ${meta.total} 条`),
              meta.problems > 0 ? h("span", { style: { color: C.warn } }, `· ${meta.problems} 个文件解析失败`) : null,
              meta.overlay > 0 ? h("span", null, `· overlay ${meta.overlay} 条`) : null,
              meta.dims_source ? h("span", { style: { fontFamily: C.mono } }, `· 维度 ${meta.dims_source}`) : null,
              mode === "search" ? h("span", { style: { color: C.accent } }, "· 检索结果（按相关度）") : null,
            )
          : null,
        error !== "" ? h(Notice, null, error) : null,
        detailError !== "" ? h(Notice, null, detailError) : null,
        items.length > 0
          ? h(
              "div",
              { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", color: C.muted, fontSize: 11.5 } },
              h(
                "label",
                { style: { display: "inline-flex", gap: 6, alignItems: "center", cursor: "pointer" } },
                h("input", {
                  type: "checkbox",
                  checked: selected.length > 0 && selected.length === items.length,
                  onChange: (event) => setSelected(event.target.checked ? items.map((item) => item.id) : []),
                }),
                "全选当前列表",
              ),
              selected.length > 0 ? h("span", null, `已选 ${selected.length} 条`) : null,
              h("span", { style: { flex: "1 1 auto" } }),
              h(
                "button",
                {
                  type: "button",
                  disabled: deleteBusy || selected.length === 0,
                  onClick: () => setPendingDelete([...selected]),
                  style: { ...buttonStyle("ghost", deleteBusy || selected.length === 0), color: "#e5484d", borderColor: "rgba(229,72,77,.5)" },
                },
                deleteBusy ? "删除中…" : `删除所选（${selected.length}）`,
              ),
            )
          : null,
        detail ? h(EntryDetail, { entry: detail, onClose: () => setDetail(null) }) : null,
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", border: `1px solid ${C.border}`, borderRadius: 11, overflow: "hidden" } },
          items.length === 0 && !loading
            ? h(Empty, { title: error !== "" ? "请求失败" : query !== "" ? "没有匹配的条目" : "库里还没有条目", hint: query === "" && error === "" ? "在对话里用 lattice_record 记录第一条经验，刷新即可看到。" : null })
            : items.map((entry) =>
                h(
                  "div",
                  {
                    key: entry.id,
                    style: {
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      borderBottom: `1px solid ${C.border}`,
                      background: detail && detail.id === entry.id ? C.layer2 : "transparent",
                      padding: "0 8px 0 11px",
                    },
                  },
                  h("input", {
                    type: "checkbox",
                    checked: selected.includes(entry.id),
                    onChange: (event) => toggleSelect(entry.id, event.target.checked),
                    style: { margin: 0, cursor: "pointer" },
                  }),
                  h(
                    "button",
                    {
                      type: "button",
                      onClick: () => openEntry(entry.id),
                      style: {
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        flex: "1 1 auto",
                        minWidth: 0,
                        textAlign: "left",
                        padding: "9px 2px",
                        border: "none",
                        background: "transparent",
                        color: C.text,
                        cursor: "pointer",
                        fontFamily: "inherit",
                      },
                    },
                    h("span", { style: { color: entry.applicable === false ? C.muted : C.accent, display: "flex" } }, Icon(entry.applicable === false ? "alert" : "chevron", 13)),
                    h(
                      "span",
                      { style: { flex: "1 1 auto", minWidth: 0 } },
                      h("span", { style: { display: "block", fontSize: 13, fontWeight: 550, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, entry.title),
                      h("span", { style: { display: "block", color: C.muted, fontSize: 11, fontFamily: C.mono, marginTop: 2 } }, entry.id),
                    ),
                    h(Badge, { entry }),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      title: "删除这一条记忆",
                      onClick: () => {
                        setDeleteError("");
                        setDeleteDone("");
                        setPendingDelete([entry.id]);
                      },
                      style: { ...buttonStyle("ghost", false), padding: "2px 8px", fontSize: 11, color: "#e5484d", borderColor: "rgba(229,72,77,.45)", flex: "0 0 auto" },
                    },
                    "删除",
                  ),
                ),
              ),
        ),
        deleteError !== "" ? h(Notice, null, deleteError) : null,
        deleteDone !== "" ? h(Notice, null, deleteDone) : null,
        h(BackupSection, { onRestored: () => load(query) }),
        h(
          "div",
          {
            style: {
              border: "1px solid rgba(229,72,77,.55)",
              borderRadius: 11,
              padding: "9px 12px",
              display: "flex",
              alignItems: "center",
              gap: 10,
              background: "rgba(229,72,77,.06)",
            },
          },
          h("span", { style: { display: "flex", color: "#e5484d" } }, Icon("alert", 14)),
          h(
            "span",
            { style: { flex: "1 1 auto", fontSize: 11.5, color: C.subtle, lineHeight: 1.5 } },
            "危险操作：清除记忆库会删除库内全部条目（保留库目录与 projects.json），不可恢复。",
          ),
          h(
            "button",
            {
              type: "button",
              onClick: () => {
                setClearError("");
                setClearDone("");
                setClearOpen(true);
              },
              style: { ...buttonStyle("ghost", false), color: "#e5484d", borderColor: "rgba(229,72,77,.5)" },
            },
            "清除记忆库…",
          ),
        ),
        clearDone !== "" ? h(Notice, null, clearDone) : null,
        pendingDelete.length > 0
          ? h(
              "div",
              {
                style: {
                  position: "fixed",
                  inset: 0,
                  zIndex: 260,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "rgba(4,6,10,.55)",
                },
              },
              h(
                "div",
                {
                  style: {
                    width: "min(440px, 92vw)",
                    background: opaquePage(),
                    border: `1px solid ${C.border}`,
                    borderRadius: 12,
                    padding: 16,
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    color: C.text,
                    boxShadow: "0 18px 48px rgba(0,0,0,.42)",
                  },
                },
                h("div", { style: { fontSize: 14, fontWeight: 650 } }, `删除 ${pendingDelete.length} 条记忆？`),
                h("div", { style: { fontSize: 12, color: C.subtle, lineHeight: 1.6 } }, "这些条目会从库目录里被删除（备份里的副本不受影响）。此操作不可撤销。"),
                h(
                  "div",
                  { style: { fontFamily: C.mono, fontSize: 11.5, color: C.muted, lineHeight: 1.7, maxHeight: 120, overflow: "auto" } },
                  pendingDelete.slice(0, 8).map((id) => h("div", { key: id }, id)),
                  pendingDelete.length > 8 ? h("div", null, `… 还有 ${pendingDelete.length - 8} 条`) : null,
                ),
                deleteError !== "" ? h(Notice, null, deleteError) : null,
                h(
                  "div",
                  { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
                  h("button", { type: "button", disabled: deleteBusy, onClick: () => setPendingDelete([]), style: buttonStyle("ghost", deleteBusy) }, "取消"),
                  h(
                    "button",
                    {
                      type: "button",
                      disabled: deleteBusy,
                      onClick: () => runDelete(pendingDelete),
                      style: { ...buttonStyle("primary", deleteBusy), background: "#e5484d", borderColor: "#e5484d" },
                    },
                    deleteBusy ? "删除中…" : "确认删除",
                  ),
                ),
              ),
            )
          : null,
        clearOpen
          ? h(
              "div",
              {
                style: {
                  position: "fixed",
                  inset: 0,
                  zIndex: 260,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "rgba(4,6,10,.55)",
                },
              },
              h(
                "div",
                {
                  style: {
                    width: 470,
                    maxWidth: "calc(100% - 40px)",
                    background: opaquePage(),
                    border: `1px solid ${C.border}`,
                    borderRadius: 14,
                    padding: "18px 20px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                    color: C.text,
                    boxShadow: "0 18px 48px rgba(0,0,0,.4)",
                  },
                },
                h("div", { style: { fontSize: 15, fontWeight: 650 } }, "清除记忆库？"),
                h(
                  "div",
                  { style: { fontSize: 12.5, color: C.subtle, lineHeight: 1.65 } },
                  `将删除库内全部条目（保留库目录与 projects.json），不可恢复。${clearBusy ? " 正在执行…" : ` 将在 ${clearLeft} 秒后自动执行。`}`,
                ),
                clearError !== "" ? h(Notice, null, clearError) : null,
                h(
                  "div",
                  { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
                  h(
                    "button",
                    { type: "button", onClick: () => setClearOpen(false), disabled: clearBusy, style: buttonStyle("ghost", clearBusy) },
                    "取消（保留记忆）",
                  ),
                  h(
                    "button",
                    { type: "button", onClick: () => runClear(), disabled: clearBusy, style: { ...buttonStyle("primary", clearBusy), background: "#e5484d" } },
                    clearBusy ? "清除中…" : "立即清除",
                  ),
                ),
              ),
            )
          : null,
      );
    }

    function MatrixTab(props) {
      const fill = Boolean(props && props.fill);
      const [feature, setFeature] = useState("");
      const [keys, setKeys] = useState("");
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState("");

      const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
          const params = [];
          if (feature.trim() !== "") params.push(`feature=${encodeURIComponent(feature.trim())}`);
          if (keys.trim() !== "") params.push(`keys=${encodeURIComponent(keys.trim())}`);
          const body = await getJson(`${API_MATRIX}${params.length ? `?${params.join("&")}` : ""}`);
          setData(body);
        } catch (err) {
          setData(null);
          setError(String((err && err.message) || err));
        } finally {
          setLoading(false);
        }
      }, [feature, keys]);

      useEffect(() => {
        load();
      }, [load]);

      const columns = useMemo(() => {
        if (!data || !Array.isArray(data.rows)) return [];
        const seen = [];
        for (const row of data.rows) {
          for (const cell of row.cells || []) {
            if (!seen.some((item) => item.signature === cell.signature)) seen.push(cell);
          }
        }
        return seen;
      }, [data]);

      const matrixRows = data && Array.isArray(data.rows) ? data.rows : [];
      const signatures = columns.map((column) => column.signature);
      const truncate = (text, max) => {
        const value = String(text || "");
        return value.length > max ? `${value.slice(0, max - 1)}…` : value;
      };
      const statusColor = (status) =>
        status === "verified" ? C.ok : status === "draft" ? C.accent : status === "stale" ? C.warn : "rgba(148,163,184,.8)";
      function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
      }

      /* ---- 3D scene: manual perspective projection, no dependencies ---- */
      const wrapRef = useRef(null);
      const [size, setSize] = useState({ w: 1180, h: 720 });
      const W = size.w;
      const H = size.h;

      useEffect(() => {
        const element = wrapRef.current;
        if (!element || typeof ResizeObserver === "undefined") return undefined;
        const measure = () => {
          const rect = element.getBoundingClientRect();
          if (rect.width < 120 || rect.height < 120) return;
          const next = { w: Math.round(rect.width), h: Math.round(rect.height) };
          setSize((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
      }, [fill]);
      const [view, setView] = useState({ yaw: 0.68, pitch: 0.32, dist: 3.4 });
      const [autoRotate, setAutoRotate] = useState(true);
      const [dragging, setDragging] = useState(false);
      const [hoverKey, setHoverKey] = useState("");
      const [pulse, setPulse] = useState(0);
      const dragRef = useRef(null);
      const svgRef = useRef(null);
      const autoRotateRef = useRef(autoRotate);
      autoRotateRef.current = autoRotate;
      const inertiaRef = useRef({ vx: 0, vy: 0 });

      useEffect(() => {
        let raf = 0;
        let last = 0;
        const tick = (time) => {
          raf = requestAnimationFrame(tick);
          if (time - last < 30) return;
          const dt = last === 0 ? 0.03 : Math.min(0.06, (time - last) / 1000);
          last = time;
          setPulse((prev) => (prev + dt * 0.42) % 1);
          setView((prev) => {
            const inertia = inertiaRef.current;
            let yaw = prev.yaw;
            let pitch = prev.pitch;
            if (autoRotateRef.current) yaw += dt * 0.22;
            if (!dragRef.current && (Math.abs(inertia.vx) > 0.0015 || Math.abs(inertia.vy) > 0.0015)) {
              yaw += inertia.vx * dt;
              pitch = clamp(pitch + inertia.vy * dt, -1.15, 1.15);
              inertia.vx *= 0.9;
              inertia.vy *= 0.9;
            }
            if (yaw === prev.yaw && pitch === prev.pitch) return prev;
            return Object.assign({}, prev, { yaw, pitch });
          });
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
      }, []);

      const zoomBy = useCallback((deltaY) => {
        setView((prev) => ({ ...prev, dist: clamp(prev.dist + deltaY * 0.0022, 1.2, 9) }));
      }, []);

      useEffect(() => {
        // The listener lives on the wrapper (always mounted, and it also covers
        // the SVG) so wheel zoom keeps working across re-renders and even while
        // the canvas is empty; preventDefault keeps the drawer from scrolling.
        const element = wrapRef.current;
        if (!element) return undefined;
        const onWheelNative = (event) => {
          event.preventDefault();
          event.stopPropagation();
          zoomBy(event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY);
        };
        element.addEventListener("wheel", onWheelNative, { passive: false });
        return () => element.removeEventListener("wheel", onWheelNative);
      }, [zoomBy, fill, data]);

      const scene = useMemo(() => {
        const features = matrixRows.map((row, index) => {
          const angle = (index / Math.max(1, matrixRows.length)) * Math.PI * 2;
          return {
            key: `f:${row.feature}`,
            kind: "feature",
            label: row.feature,
            count: row.entries || (row.cells || []).reduce((sum, cell) => sum + (cell.count || 1), 0),
            p: [-0.92, Math.cos(angle) * 0.66, Math.sin(angle) * 0.66],
          };
        });
        const sigs = columns.map((column, index) => {
          const angle = (index / Math.max(1, columns.length)) * Math.PI * 2 + Math.PI / 2;
          const total = matrixRows.reduce((sum, row) => {
            const cell = (row.cells || []).find((item) => item.signature === column.signature);
            return sum + (cell ? cell.count || 1 : 0);
          }, 0);
          return {
            key: `s:${column.signature}`,
            kind: "sig",
            label: column.signature,
            count: total,
            p: [0.92, Math.cos(angle) * 0.66, Math.sin(angle) * 0.66],
          };
        });
        const nodeMap = new Map([].concat(features, sigs).map((node) => [node.key, node]));
        const edges = [];
        for (const row of matrixRows) {
          const from = nodeMap.get(`f:${row.feature}`);
          if (!from) continue;
          const cells = new Map((row.cells || []).map((cell) => [cell.signature, cell]));
          for (const column of columns) {
            const to = nodeMap.get(`s:${column.signature}`);
            if (!to) continue;
            const cell = cells.get(column.signature) || null;
            edges.push({
              key: `${row.feature}::${column.signature}`,
              from: from.key,
              to: to.key,
              feature: row.feature,
              signature: column.signature,
              cell,
              color: statusColor(cell ? cell.best_status : ""),
              width: cell ? Math.min(5, 1.1 + (cell.count || 1) * 0.85) : 1,
              dashed: !cell,
            });
          }
        }
        return { nodes: [].concat(features, sigs), edges };
      }, [matrixRows, columns]);

      const projected = useMemo(() => {
        const { yaw, pitch, dist } = view;
        const cy = Math.cos(yaw);
        const sy = Math.sin(yaw);
        const cp = Math.cos(pitch);
        const sp = Math.sin(pitch);
        const K = Math.min(W, H) * 0.56;
        const project = (point) => {
          const x1 = point[0] * cy + point[2] * sy;
          const z1 = -point[0] * sy + point[2] * cy;
          const y2 = point[1] * cp - z1 * sp;
          const z2 = point[1] * sp + z1 * cp;
          const depth = Math.max(0.4, z2 + dist);
          const scale = 2.1 / depth;
          return {
            x: W / 2 + x1 * scale * K,
            y: H / 2 - y2 * scale * K,
            depth: z2,
            scale,
            alpha: Math.max(0.3, Math.min(1, 0.52 + (z2 + 1) * 0.24)),
          };
        };
        const nodes = scene.nodes.map((node) => Object.assign({}, node, { screen: project(node.p) }));
        const nodeMap = new Map(nodes.map((node) => [node.key, node]));
        const edges = scene.edges
          .map((edge) => {
            const from = nodeMap.get(edge.from);
            const to = nodeMap.get(edge.to);
            if (!from || !to) return null;
            const midX = (from.screen.x + to.screen.x) / 2;
            const midY = (from.screen.y + to.screen.y) / 2;
            return Object.assign({}, edge, {
              fromScreen: from.screen,
              toScreen: to.screen,
              control: { x: W / 2 + (midX - W / 2) * 0.78, y: H / 2 + (midY - H / 2) * 0.78 },
            });
          })
          .filter(Boolean);
        const ring = (x) => {
          const points = [];
          for (let index = 0; index < 56; index += 1) {
            const angle = (index / 56) * Math.PI * 2;
            points.push(project([x, Math.cos(angle) * 0.66, Math.sin(angle) * 0.66]));
          }
          return points;
        };
        return { nodes, edges, guides: [ring(-0.92), ring(0.92)] };
      }, [scene, view]);

      const hoveredNode = hoverKey !== "" ? projected.nodes.find((node) => node.key === hoverKey) : null;
      const hoverInfo = hoveredNode
        ? `${hoveredNode.kind === "feature" ? "feature" : "维度"}：${hoveredNode.label} · ${hoveredNode.count || 0} 条`
        : "";

      const onPointerDown = (event) => {
        dragRef.current = { x: event.clientX, y: event.clientY, t: performance.now(), vx: 0, vy: 0 };
        inertiaRef.current = { vx: 0, vy: 0 };
        setDragging(true);
        setAutoRotate(false);
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
      };
      const onPointerMove = (event) => {
        const drag = dragRef.current;
        if (!drag) return;
        const now = performance.now();
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        const dt = Math.max(8, now - drag.t) / 1000;
        drag.vx = clamp((dx * 0.007) / dt, -6, 6);
        drag.vy = clamp((dy * 0.006) / dt, -6, 6);
        drag.x = event.clientX;
        drag.y = event.clientY;
        drag.t = now;
        setView((prev) => Object.assign({}, prev, { yaw: prev.yaw + dx * 0.007, pitch: clamp(prev.pitch + dy * 0.006, -1.15, 1.15) }));
      };
      const onPointerUp = (event) => {
        if (dragRef.current) inertiaRef.current = { vx: dragRef.current.vx || 0, vy: dragRef.current.vy || 0 };
        dragRef.current = null;
        setDragging(false);
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
      };

      return h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 11,
            flex: fill ? "1 1 auto" : undefined,
            minHeight: fill ? 0 : undefined,
            height: fill ? "100%" : undefined,
          },
        },
        h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          h("input", { value: feature, onChange: (event) => setFeature(event.target.value), placeholder: "feature 过滤（留空 = 全部）", style: { ...inputStyle(), flex: "1 1 180px" } }),
          h("input", { value: keys, onChange: (event) => setKeys(event.target.value), placeholder: "维度键，如 mcver,loader（留空 = 自动）", style: { ...inputStyle(), flex: "1 1 200px" } }),
          h("button", { type: "button", disabled: loading, onClick: load, style: buttonStyle("primary", loading) }, loading ? "生成中…" : "生成矩阵"),
        ),
        h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", color: C.muted, fontSize: 11.5, alignItems: "center" } },
          h("span", { style: { fontFamily: C.mono } }, data && Array.isArray(data.keys) ? `keys: ${data.keys.join(" , ")}` : "keys: —"),
          data ? h("span", null, `· ${data.features ? data.features.length : 0} 个 feature · ${data.total_entries || 0} 条` ) : null,
        ),
        error !== "" ? h(Notice, null, error) : null,
        matrixRows.length === 0 || signatures.length === 0
          ? h(Empty, { title: "没有可展示的节点", hint: "先记录几条带 dims 的条目，再按维度生成矩阵。" })
          : h(
              "div",
              {
                style: {
                  position: "relative",
                  border: `1px solid ${C.border}`,
                  borderRadius: 12,
                  overflow: "hidden",
                  background: "radial-gradient(120% 120% at 20% 8%, rgba(56,189,248,.16), transparent 62%), " + C.surface,
                  flex: fill ? "1 1 auto" : undefined,
                  minHeight: fill ? 0 : undefined,
                  display: "flex",
                  flexDirection: "column",
                },
              },
              h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "9px 12px 0", color: C.muted, fontSize: 11.5 } },
                h("span", { style: { color: C.subtle } }, "拖拽旋转 · 滚轮或按钮缩放 · 悬停节点查看详情"),
                h("span", { style: { flex: "1 1 auto" } }),
                hoverInfo !== "" ? h("span", { style: { color: C.accent } }, hoverInfo) : null,
                h("span", { style: { fontFamily: C.mono, color: C.muted } }, `缩放 ${Math.round((3.4 / view.dist) * 100)}%`),
                h(
                  "button",
                  {
                    type: "button",
                    title: "放大（拉近相机）",
                    onClick: () => setView((prev) => ({ ...prev, dist: clamp(prev.dist * 0.86, 1.2, 9) })),
                    style: { ...buttonStyle("ghost", false), padding: "3px 9px", fontSize: 12, lineHeight: "16px" },
                  },
                  "＋",
                ),
                h(
                  "button",
                  {
                    type: "button",
                    title: "缩小（拉远相机）",
                    onClick: () => setView((prev) => ({ ...prev, dist: clamp(prev.dist / 0.86, 1.2, 9) })),
                    style: { ...buttonStyle("ghost", false), padding: "3px 9px", fontSize: 12, lineHeight: "16px" },
                  },
                  "－",
                ),
                h("button", { type: "button", onClick: () => setView({ yaw: 0.68, pitch: 0.32, dist: 3.4 }), style: { ...buttonStyle("ghost", false), padding: "3px 10px", fontSize: 11 } }, "重置视角"),
                h(
                  "label",
                  { style: { display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" } },
                  h("input", { type: "checkbox", checked: autoRotate, onChange: (event) => setAutoRotate(event.target.checked) }),
                  "自动旋转",
                ),
              ),
              h("div", { ref: wrapRef, style: { flex: "1 1 auto", minHeight: 0, position: "relative" } },
              h(
                "svg",
                {
                  ref: svgRef,
                  viewBox: `0 0 ${W} ${H}`,
                  preserveAspectRatio: "xMidYMid meet",
                  style: { display: "block", width: "100%", height: fill ? "100%" : "min(70vh, 760px)", touchAction: "none", cursor: dragging ? "grabbing" : "grab" },
                  onPointerDown: onPointerDown,
                  onPointerMove: onPointerMove,
                  onPointerUp: onPointerUp,
                  onPointerCancel: onPointerUp,
                  onPointerLeave: () => setHoverKey(""),
                },
                h(
                  "defs",
                  null,
                  h(
                    "radialGradient",
                    { id: "lattice-core-glow", cx: "50%", cy: "50%", r: "50%" },
                    h("stop", { offset: "0%", stopColor: "rgba(56,189,248,.22)" }),
                    h("stop", { offset: "60%", stopColor: "rgba(99,102,241,.07)" }),
                    h("stop", { offset: "100%", stopColor: "rgba(56,189,248,0)" }),
                  ),
                  h(
                    "radialGradient",
                    { id: "lattice-feature-node", cx: "34%", cy: "28%", r: "78%" },
                    h("stop", { offset: "0%", stopColor: "#ffffff" }),
                    h("stop", { offset: "22%", stopColor: C.accent }),
                    h("stop", { offset: "72%", stopColor: "rgba(59,130,246,.95)" }),
                    h("stop", { offset: "100%", stopColor: "rgba(30,64,175,.92)" }),
                  ),
                  h(
                    "radialGradient",
                    { id: "lattice-sig-node", cx: "34%", cy: "28%", r: "78%" },
                    h("stop", { offset: "0%", stopColor: "#f0fbff" }),
                    h("stop", { offset: "24%", stopColor: "rgba(125,211,252,.98)" }),
                    h("stop", { offset: "74%", stopColor: "rgba(14,165,233,.92)" }),
                    h("stop", { offset: "100%", stopColor: "rgba(8,47,73,.92)" }),
                  ),
                  h(
                    "radialGradient",
                    { id: "lattice-feature-halo", cx: "50%", cy: "50%", r: "50%" },
                    h("stop", { offset: "0%", stopColor: "rgba(96,165,250,.42)" }),
                    h("stop", { offset: "100%", stopColor: "rgba(96,165,250,0)" }),
                  ),
                  h(
                    "radialGradient",
                    { id: "lattice-sig-halo", cx: "50%", cy: "50%", r: "50%" },
                    h("stop", { offset: "0%", stopColor: "rgba(56,189,248,.42)" }),
                    h("stop", { offset: "100%", stopColor: "rgba(56,189,248,0)" }),
                  ),
                ),
                Array.from({ length: 72 }, (_, index) =>
                  h("circle", {
                    key: `star:${index}`,
                    cx: (index * 137.5) % W,
                    cy: (index * 271.3) % H,
                    r: 0.5 + (((index * 53) % 10) / 10) * 0.9,
                    fill: "rgba(186,230,253,.8)",
                    opacity: 0.16 + (((index * 29) % 100) / 200) * 0.5,
                    style: { pointerEvents: "none" },
                  }),
                ),
                h("circle", { cx: W / 2, cy: H / 2, r: Math.min(W, H) * 0.46, fill: "url(#lattice-core-glow)", style: { pointerEvents: "none" } }),
                projected.guides.map((points, guideIndex) =>
                  h("polyline", {
                    key: `guide:${guideIndex}`,
                    points: points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" "),
                    fill: "none",
                    stroke: "rgba(125,211,252,.16)",
                    strokeWidth: 1,
                    strokeDasharray: "2 7",
                    style: { pointerEvents: "none" },
                  }),
                ),
                projected.edges.map((edge) => {
                  const faded = hoverKey !== "" && edge.from !== hoverKey && edge.to !== hoverKey;
                  return h(
                    "path",
                    {
                      key: edge.key,
                      d: `M ${edge.fromScreen.x} ${edge.fromScreen.y} Q ${edge.control.x} ${edge.control.y} ${edge.toScreen.x} ${edge.toScreen.y}`,
                      fill: "none",
                      stroke: edge.dashed ? "rgba(148,163,184,.24)" : edge.color,
                      strokeWidth: edge.dashed ? 1 : Math.max(0.9, edge.width * ((edge.fromScreen.scale + edge.toScreen.scale) / 1.24)),
                      strokeDasharray: edge.dashed ? "4 6" : undefined,
                      strokeLinecap: "round",
                      opacity: faded ? 0.06 : (edge.dashed ? 0.45 : 0.78) * Math.min(edge.fromScreen.alpha, edge.toScreen.alpha),
                      style: { pointerEvents: "none" },
                    },
                    h("title", null, edge.dashed ? `${edge.feature} × ${edge.signature}：缺口` : `${edge.feature} × ${edge.signature}：${(edge.cell && edge.cell.count) || 1} 条（${edge.cell && edge.cell.best_status}）`),
                  );
                }),
                projected.edges.map((edge, index) => {
                  if (edge.dashed) return null;
                  const t = (pulse + ((index * 0.173) % 1)) % 1;
                  const mt = 1 - t;
                  const x = mt * mt * edge.fromScreen.x + 2 * mt * t * edge.control.x + t * t * edge.toScreen.x;
                  const y = mt * mt * edge.fromScreen.y + 2 * mt * t * edge.control.y + t * t * edge.toScreen.y;
                  const faded = hoverKey !== "" && edge.from !== hoverKey && edge.to !== hoverKey;
                  const strength = faded ? 0.12 : 1;
                  return h(
                    "g",
                    { key: `pulse:${edge.key}`, style: { pointerEvents: "none" } },
                    h("circle", { cx: x, cy: y, r: 6.5, fill: edge.color, opacity: 0.16 * strength }),
                    h("circle", { cx: x, cy: y, r: 2.4, fill: "#eaf6ff", opacity: 0.92 * strength }),
                  );
                }),
                projected.nodes
                  .slice()
                  .sort((a, b) => a.screen.depth - b.screen.depth)
                  .map((node) => {
                    const base = (node.kind === "feature" ? 8.5 : 7) * (node.screen.scale / 0.62) * (1 + Math.min(0.55, (node.count || 0) * 0.1));
                    const active = hoverKey === node.key;
                    const radius = active ? base * 1.16 : base;
                    const depthAlpha = Math.max(0.34, node.screen.alpha);
                    return h(
                      "g",
                      {
                        key: node.key,
                        style: { cursor: "pointer" },
                        onPointerEnter: () => setHoverKey(node.key),
                        onPointerLeave: () => setHoverKey(""),
                      },
                      h("circle", {
                        cx: node.screen.x,
                        cy: node.screen.y,
                        r: radius * 2.6,
                        fill: node.kind === "feature" ? "url(#lattice-feature-halo)" : "url(#lattice-sig-halo)",
                        opacity: (active ? 0.85 : 0.5) * depthAlpha,
                        style: { pointerEvents: "none" },
                      }),
                      active
                        ? h("circle", { cx: node.screen.x, cy: node.screen.y, r: radius + 8, fill: "none", stroke: C.accent, strokeWidth: 1.1, opacity: 0.55, style: { pointerEvents: "none" } })
                        : null,
                      h("circle", {
                        cx: node.screen.x,
                        cy: node.screen.y,
                        r: radius,
                        fill: node.kind === "feature" ? "url(#lattice-feature-node)" : "url(#lattice-sig-node)",
                        stroke: "rgba(255,255,255,.35)",
                        strokeWidth: Math.max(0.6, radius * 0.08),
                        opacity: depthAlpha,
                      }),
                      h("ellipse", {
                        cx: node.screen.x - radius * 0.3,
                        cy: node.screen.y - radius * 0.34,
                        rx: radius * 0.42,
                        ry: radius * 0.28,
                        fill: "rgba(255,255,255,.72)",
                        opacity: depthAlpha * 0.9,
                        style: { pointerEvents: "none" },
                      }),
                      h(
                        "text",
                        {
                          x: node.kind === "feature" ? node.screen.x - radius - 9 : node.screen.x + radius + 9,
                          y: node.screen.y,
                          textAnchor: node.kind === "feature" ? "end" : "start",
                          dominantBaseline: "middle",
                          fontSize: 11 + Math.max(0, node.screen.depth) * 0.9,
                          fill: node.kind === "feature" ? C.text : C.subtle,
                          fontFamily: node.kind === "feature" ? "inherit" : C.mono,
                          opacity: Math.max(0.36, node.screen.alpha),
                          style: { pointerEvents: "none", userSelect: "none" },
                        },
                        truncate(node.label, node.kind === "feature" ? 18 : 26),
                      ),
                    );
                  }),
              ),
              ),
              h(
                "div",
                { style: { display: "flex", gap: 14, flexWrap: "wrap", padding: "0 12px 9px", color: C.muted, fontSize: 11 } },
                h("span", null, "● 左 = feature，右 = 维度组合"),
                h("span", null, "— 实线 = 已有条目（粗细 = 条目数，颜色 = 最佳状态）"),
                h("span", null, "- - 虚线 = 覆盖缺口"),
              ),
            ),
      );
    }

    function PortableTab() {
      const [format, setFormat] = useState("json");
      const [content, setContent] = useState("");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [copyState, setCopyState] = useState("");
      const [importText, setImportText] = useState("");
      const [importResult, setImportResult] = useState(null);
      const [importError, setImportError] = useState("");
      const [mdText, setMdText] = useState("");
      const [mdName, setMdName] = useState("");
      const [mdError, setMdError] = useState("");
      const [composeTitle, setComposeTitle] = useState("");
      const [composeFeature, setComposeFeature] = useState("");
      const [composeKind, setComposeKind] = useState("note");
      const [composeSummary, setComposeSummary] = useState("");
      const [composeBody, setComposeBody] = useState("");
      const [composeEvidence, setComposeEvidence] = useState("");
      const [composeDims, setComposeDims] = useState("");
      const [composeTags, setComposeTags] = useState("");
      const [composeResult, setComposeResult] = useState(null);
      const [composeError, setComposeError] = useState("");

      const doExport = useCallback(async (nextFormat) => {
        setBusy(true);
        setError("");
        setCopyState("");
        try {
          const body = await getJson(`${API_EXPORT}?format=${encodeURIComponent(nextFormat)}`);
          setFormat(nextFormat);
          setContent(body.content || "");
        } catch (err) {
          setContent("");
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      }, []);

      const doCopy = useCallback(async () => {
        try {
          await navigator.clipboard.writeText(content);
          setCopyState("已复制");
        } catch {
          setCopyState("复制失败，请手动选择文本框内容");
        }
        window.setTimeout(() => setCopyState(""), 1800);
      }, [content]);

      const doImport = useCallback(async (dryRun) => {
        setBusy(true);
        setImportError("");
        setImportResult(null);
        try {
          const body = await postJson(API_IMPORT, { data: importText, dry_run: dryRun });
          setImportResult(body);
        } catch (err) {
          setImportError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      }, [importText]);

      const doImportMd = useCallback(async (dryRun) => {
        setBusy(true);
        setImportError("");
        setImportResult(null);
        try {
          const body = await postJson(API_IMPORT, { markdown: mdText, dry_run: dryRun });
          setImportResult(body);
        } catch (err) {
          setImportError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      }, [mdText]);

      const doCompose = useCallback(async () => {
        setBusy(true);
        setComposeError("");
        setComposeResult(null);
        try {
          const body = await postJson(API_COMPOSE, {
            title: composeTitle,
            feature: composeFeature,
            kind: composeKind,
            summary: composeSummary,
            body: composeBody,
            evidence: composeEvidence,
            dims: composeDims,
            tags: composeTags,
          });
          setComposeResult(body);
        } catch (err) {
          setComposeError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      }, [composeTitle, composeFeature, composeKind, composeSummary, composeBody, composeEvidence, composeDims, composeTags]);

      const pickMarkdown = useCallback((event) => {
        setMdError("");
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        if (file.size > 512 * 1024) {
          setMdError("文件超过 512KB，单个记忆条目不应该这么大");
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          setMdText(String(reader.result || ""));
          setMdName(file.name || "");
        };
        reader.onerror = () => setMdError("读取文件失败");
        reader.readAsText(file, "utf-8");
        event.target.value = "";
      }, []);

      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 12 } },
        h("div", { style: { fontSize: 12, color: C.muted } }, "导出：把库的一部分变成可迁移的产物（JSON 可再导入；SKILL.md / AGENTS.md 可直接被对应通道加载）。"),
        h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          ["json", "skill", "agents"].map((item) =>
            h("button", { key: item, type: "button", disabled: busy, onClick: () => doExport(item), style: buttonStyle(format === item ? "primary" : "ghost", busy) }, item === "json" ? "JSON" : item === "skill" ? "SKILL.md" : "AGENTS.md"),
          ),
          content !== "" ? h("button", { type: "button", onClick: doCopy, style: buttonStyle("ghost") }, Icon("copy", 12), h("span", { style: { marginLeft: 5 } }, copyState || "复制")) : null,
        ),
        error !== "" ? h(Notice, null, error) : null,
        content !== ""
          ? h("textarea", { readOnly: true, value: content, style: { ...inputStyle(), minHeight: 180, fontFamily: C.mono, fontSize: 11.5, lineHeight: 1.55, resize: "vertical" } })
          : null,
        h("hr", { style: { border: "none", borderTop: `1px solid ${C.border}`, margin: "2px 0" } }),
        h("div", { style: { fontSize: 12, color: C.muted } }, "导入：粘贴 Lattice JSON 导出内容，先预检差异，再选择写入。已存在的 id、近似重复、含凭证的记录不会覆盖。"),
        h("textarea", {
          value: importText,
          onChange: (event) => setImportText(event.target.value),
          placeholder: '{"schema":"lattice-export/1","entries":[...]}',
          style: { ...inputStyle(), minHeight: 110, fontFamily: C.mono, fontSize: 11.5, lineHeight: 1.55, resize: "vertical" },
        }),
        h("div", { style: { display: "flex", gap: 8 } },
          h("button", { type: "button", disabled: busy || importText.trim() === "", onClick: () => doImport(true), style: buttonStyle("ghost", busy || importText.trim() === "") }, "预检"),
          h("button", { type: "button", disabled: busy || importText.trim() === "", onClick: () => doImport(false), style: buttonStyle("primary", busy || importText.trim() === "") }, busy ? "处理中…" : "写入新增条目"),
        ),
        importError !== "" ? h(Notice, null, importError) : null,
        h("hr", { style: { border: "none", borderTop: `1px solid ${C.border}`, margin: "2px 0" } }),
        h("div", { style: { fontSize: 12, color: C.muted } }, "导入单条记忆：选择一个带 YAML frontmatter 的 `.md` 文件（和 `entries/` 里条目同格式），预检后写入。"),
        h(
          "div",
          { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
          h(
            "label",
            { style: { ...buttonStyle("ghost", false), display: "inline-flex", alignItems: "center", gap: 6, cursor: busy ? "not-allowed" : "pointer" } },
            Icon("box", 12),
            h("span", null, mdText === "" ? "选择 .md 文件…" : `已选：${mdName || "memory.md"}`),
            h("input", {
              type: "file",
              accept: ".md,text/markdown",
              disabled: busy,
              onChange: pickMarkdown,
              style: { display: "none" },
            }),
          ),
          h("button", { type: "button", disabled: busy || mdText === "", onClick: () => doImportMd(true), style: buttonStyle("ghost", busy || mdText === "") }, "预检"),
          h("button", { type: "button", disabled: busy || mdText === "", onClick: () => doImportMd(false), style: buttonStyle("primary", busy || mdText === "") }, busy ? "处理中…" : "写入这条记忆"),
          mdText !== "" ? h("button", { type: "button", onClick: () => { setMdText(""); setMdName(""); setMdError(""); }, style: buttonStyle("ghost", false) }, "换一个") : null,
        ),
        mdError !== "" ? h(Notice, null, mdError) : null,
        mdText !== ""
          ? h("textarea", {
              readOnly: true,
              value: mdText.slice(0, 4000),
              style: { ...inputStyle(), minHeight: 90, fontFamily: C.mono, fontSize: 11, lineHeight: 1.55, resize: "vertical" },
            })
          : null,
        importResult
          ? h(
              "div",
              { style: { fontSize: 12, lineHeight: 1.7, color: C.subtle } },
              h("div", { style: { color: importResult.dry_run ? C.accent : C.ok, fontWeight: 550 } }, importResult.dry_run ? "预检结果（未写入）" : "已写入"),
              h("div", null, `候选 ${importResult.candidates} 条 · 新增 ${(importResult.added || []).length} 条 · 冲突 ${(importResult.conflicts || []).length} 条`),
              (importResult.conflicts || []).slice(0, 12).map((item, index) =>
                h("div", { key: String(index), style: { fontFamily: C.mono, fontSize: 11.5, color: C.muted, wordBreak: "break-all" } }, `${item.id} · ${item.reason}${item.detail ? ` · ${item.detail}` : ""}`),
              ),
              (importResult.problems || []).length > 0 ? h("div", { style: { color: C.warn } }, `payload 问题 ${importResult.problems.length} 条（见工具输出）`) : null,
            )
          : null,
        h("hr", { style: { border: "none", borderTop: `1px solid ${C.border}`, margin: "2px 0" } }),
        h("div", { style: { fontSize: 12, color: C.muted } }, "写一条记忆：自己填标题/feature/正文，写入库根 `entries/`（draft，可在浏览 tab 里 verify 或删除）。同样会做 id 冲突、近似重复与凭证检查。"),
        h(
          "div",
          { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          h("input", { value: composeTitle, onChange: (event) => setComposeTitle(event.target.value), placeholder: "标题（必填，如 药水持续时间在 1.21 的新 API）", style: { ...inputStyle(), flex: "2 1 280px" } }),
          h("input", { value: composeFeature, onChange: (event) => setComposeFeature(event.target.value), placeholder: "feature（必填，如 potion-duration）", style: { ...inputStyle(), flex: "1 1 180px" } }),
        ),
        h(
          "div",
          { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          h(
            "select",
            { value: composeKind, onChange: (event) => setComposeKind(event.target.value), style: { ...inputStyle(), flex: "0 1 150px" } },
            ["note", "contract", "decision", "gotcha", "port", "checklist", "reference"].map((kind) => h("option", { key: kind, value: kind }, kind)),
          ),
          h("input", { value: composeTags, onChange: (event) => setComposeTags(event.target.value), placeholder: "标签，逗号分隔（可选）", style: { ...inputStyle(), flex: "1 1 220px" } }),
          h("input", { value: composeDims, onChange: (event) => setComposeDims(event.target.value), placeholder: 'dims JSON（可选，如 {"mcver":"1.20.1","loader":"forge"}）', style: { ...inputStyle(), flex: "1 1 280px", fontFamily: C.mono, fontSize: 11.5 } }),
        ),
        h("input", { value: composeSummary, onChange: (event) => setComposeSummary(event.target.value), placeholder: "一句话摘要（可选，用于检索与常驻注入）", style: { ...inputStyle() } }),
        h("textarea", { value: composeBody, onChange: (event) => setComposeBody(event.target.value), placeholder: "正文（Markdown）：结论、步骤、坑、验收口径…", style: { ...inputStyle(), minHeight: 130, lineHeight: 1.6, resize: "vertical" } }),
        h("textarea", { value: composeEvidence, onChange: (event) => setComposeEvidence(event.target.value), placeholder: "证据（可选，每行一条）：run:… / file:… / url:…", style: { ...inputStyle(), minHeight: 54, fontFamily: C.mono, fontSize: 11.5, lineHeight: 1.55, resize: "vertical" } }),
        h(
          "div",
          { style: { display: "flex", gap: 8, alignItems: "center" } },
          h("button", { type: "button", disabled: busy || composeTitle.trim() === "" || composeFeature.trim() === "", onClick: doCompose, style: buttonStyle("primary", busy || composeTitle.trim() === "" || composeFeature.trim() === "") }, busy ? "写入中…" : "写入记忆"),
          h("button", { type: "button", onClick: () => { setComposeTitle(""); setComposeFeature(""); setComposeSummary(""); setComposeBody(""); setComposeEvidence(""); setComposeDims(""); setComposeTags(""); setComposeResult(null); setComposeError(""); }, style: buttonStyle("ghost", false) }, "清空"),
        ),
        composeError !== "" ? h(Notice, null, composeError) : null,
        composeResult
          ? h("div", { style: { fontSize: 12, lineHeight: 1.7, color: C.ok } }, `已写入 draft：${composeResult.id}（${composeResult.kind}）→ ${composeResult.file}`)
          : null,
      );
    }

    function CaptureTab() {
      const [items, setItems] = useState([]);
      const [mode, setMode] = useState("");
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState("");
      const [busyId, setBusyId] = useState("");
      const [openId, setOpenId] = useState("");

      const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
          const body = await getJson(API_CAPTURES);
          setItems(Array.isArray(body.items) ? body.items : []);
          setMode(String(body.mode || ""));
        } catch (err) {
          setItems([]);
          setError(String((err && err.message) || err));
        } finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const act = useCallback(async (action, id) => {
        setBusyId(id);
        setError("");
        try {
          const body = await postJson(API_CAPTURES, { action, id });
          setItems(Array.isArray(body.items) ? body.items : []);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusyId("");
        }
      }, []);

      const note =
        mode === "notify"
          ? "宿主把候选放进队列，确认后才写库；接受后是一条 draft，改完正文再 verify。"
          : mode === "draft" || mode === "auto"
            ? `当前 capture.mode=${mode}：宿主已直接写成 draft，这里只剩没写成功的残留候选。`
            : "读取中…";

      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 12 } },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
          h("div", { style: { fontSize: 12.5, lineHeight: 1.6, color: C.muted } }, note),
          h("span", { style: { flex: "1 1 auto" } }),
          h(
            "button",
            { type: "button", disabled: loading, onClick: load, style: buttonStyle("ghost", loading) },
            Icon("renew", 12),
            h("span", { style: { marginLeft: 5 } }, loading ? "刷新中…" : "刷新"),
          ),
        ),
        error !== "" ? h(Notice, null, error) : null,
        loading && items.length === 0 ? h("div", { style: { fontSize: 12, color: C.muted } }, "读取中…") : null,
        items.length === 0 && !loading
          ? h(
              "div",
              { style: { border: `1px dashed ${C.border}`, borderRadius: 10, padding: "16px", fontSize: 12, color: C.muted, textAlign: "center" } },
              "队列为空。让某个工具报错一次再重试成功，或者报错后你纠正我、我再改对，候选就会出现在这里。",
            )
          : null,
        items.map((item) => {
          const busy = busyId === item.id;
          const corrections = Array.isArray(item.corrections) ? item.corrections : [];
          return h(
            "div",
            {
              key: item.id,
              style: { border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 },
            },
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
              h("span", { style: { fontSize: 13, fontWeight: 600 } }, item.title),
              h("span", { style: pillStyle(C.accent) }, `${item.tool} ×${item.count}`),
              item.reason ? h("span", { style: pillStyle(C.subtle) }, item.reason) : null,
              h("span", { style: { flex: "1 1 auto" } }),
              h(
                "button",
                { type: "button", onClick: () => setOpenId(openId === item.id ? "" : item.id), style: buttonStyle("ghost", false) },
                openId === item.id ? "收起详情" : "查看详情",
              ),
              h(
                "button",
                { type: "button", disabled: busy, onClick: () => act("accept", item.id), style: buttonStyle("primary", busy) },
                busy ? "处理中…" : "接受为 draft",
              ),
              h(
                "button",
                { type: "button", disabled: busy, onClick: () => act("discard", item.id), style: buttonStyle("ghost", busy) },
                "丢弃",
              ),
            ),
            item.summary ? h("div", { style: { fontSize: 12, color: C.subtle, wordBreak: "break-word" } }, item.summary) : null,
            corrections.length > 0
              ? h(
                  "div",
                  { style: { fontSize: 12, color: C.accent, fontStyle: "italic", borderLeft: `2px solid ${C.accent}`, paddingLeft: 8 } },
                  corrections.map((text, index) => h("div", { key: String(index) }, `> ${text}`)),
                )
              : null,
            item.errorText ? h("div", { style: { fontFamily: C.mono, fontSize: 11, color: C.muted, wordBreak: "break-all" } }, item.errorText) : null,
            item.workspace ? h("div", { style: { fontSize: 11, color: C.muted, fontFamily: C.mono } }, item.workspace) : null,
            openId === item.id
              ? h(
                  "div",
                  { style: { display: "flex", flexDirection: "column", gap: 6, borderTop: `1px dashed ${C.border}`, paddingTop: 8 } },
                  item.body
                    ? h(
                        "pre",
                        { style: { margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: C.mono, fontSize: 11, lineHeight: 1.65, color: C.text, background: C.mono ? "transparent" : "transparent" } },
                        item.body,
                      )
                    : null,
                  Array.isArray(item.evidence) && item.evidence.length > 0
                    ? h(
                        "div",
                        { style: { fontSize: 11, color: C.muted, fontFamily: C.mono, lineHeight: 1.7 } },
                        item.evidence.map((line, index) => h("div", { key: String(index) }, `evidence: ${line}`)),
                      )
                    : null,
                  item.dims && Object.keys(item.dims).length > 0
                    ? h("div", { style: { fontSize: 11, color: C.muted } }, `dims: ${Object.keys(item.dims).map((key) => `${key}=${String(item.dims[key])}`).join(", ")}`)
                    : null,
                  item.failedAt || item.recoveredAt || item.count
                    ? h(
                        "div",
                        { style: { fontSize: 11, color: C.muted } },
                        [
                          item.count ? `出现 ${item.count} 次` : "",
                          item.failedAt ? `最近失败 ${new Date(item.failedAt).toLocaleString()}` : "",
                          item.recoveredAt ? `恢复 ${new Date(item.recoveredAt).toLocaleString()}` : "",
                          item.attempts ? `尝试 ${item.attempts} 次` : "",
                        ].filter((part) => part !== "").join(" · "),
                      )
                    : null,
                )
              : null,
          );
        }),
      );
    }

    function LatticePanel(props) {
      const fullBleed = Boolean(props && props.fullBleed);
      const [tab, setTab] = useState("browse");
      const matrixFill = fullBleed && tab === "matrix";
      const [version, setVersion] = useState("");
      const [hostError, setHostError] = useState("");
      const [summary, setSummary] = useState(null);
      const [entryCount, setEntryCount] = useState(null);
      const [reloadKey, setReloadKey] = useState(0);
      const [updateInfo, setUpdateInfo] = useState(null);
      const [updateBusy, setUpdateBusy] = useState(false);
      const [updateError, setUpdateError] = useState("");

      useEffect(() => {
        let cancelled = false;
        getJson(API_VERSION)
          .then((body) => {
            if (!cancelled) {
              setVersion(String(body.version || ""));
              setHostError("");
            }
          })
          .catch((err) => {
            if (!cancelled) setHostError(String((err && err.message) || err));
          });
        getJson(API_STATE)
          .then((body) => {
            if (cancelled) return;
            const state = body && body.state ? body.state : body;
            setSummary(state);
            syncHostBgFromState(state);
          })
          .catch(() => {
            /* summary is best-effort; browse reports its own errors */
          });
        return () => {
          cancelled = true;
        };
      }, [reloadKey]);

      const refreshAll = useCallback(() => {
        setReloadKey((value) => value + 1);
      }, []);

      const checkUpdate = useCallback(() => {
        setUpdateBusy(true);
        setUpdateError("");
        getJson(API_UPDATE)
          .then((body) => {
            setUpdateInfo(body);
            if (!body || body.ok !== true) setUpdateError(String((body && body.error && body.error.message) || "检查更新失败"));
          })
          .catch((err) => {
            setUpdateInfo(null);
            setUpdateError(String((err && err.message) || err));
          })
          .then(() => setUpdateBusy(false));
      }, []);

      const reloadUi = useCallback(() => {
        try {
          window.location.reload();
        } catch (err) {
          setUpdateError(String((err && err.message) || err));
        }
      }, []);

      return h(
        "div",
        {
          style: {
            border: `1px solid ${C.border}`,
            borderRadius: 14,
            overflow: "hidden",
            background: C.surface,
            color: C.text,
            fontFamily: "inherit",
            display: "flex",
            flexDirection: "column",
            flex: matrixFill ? "1 1 auto" : undefined,
            minHeight: matrixFill ? 0 : undefined,
            height: matrixFill ? "100%" : undefined,
          },
        },
        h(
          "div",
          {
            style: {
              padding: matrixFill ? "8px 14px" : "15px 17px 13px",
              borderBottom: `1px solid ${C.border}`,
              background: "linear-gradient(135deg, rgba(99,102,241,.12), rgba(56,189,248,.08) 55%, transparent)",
            },
          },
          h("div", { style: { display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" } },
            h("span", { style: { display: "flex", color: C.accent } }, Icon("library", matrixFill ? 16 : 19)),
            h("span", { style: { fontSize: matrixFill ? 13.5 : 15, fontWeight: 650, letterSpacing: ".2px" } }, "Lattice 记忆库"),
            version !== "" ? h("span", { style: { ...pillStyle(C.muted), marginLeft: 2 } }, version) : null,
            h("span", { style: { flex: "1 1 auto" } }),
            h("span", { style: pillStyle(summary && summary.configured ? C.ok : C.warn) },
              summary && summary.configured ? "库已配置" : "未配置"),
            summary && summary.root ? h("span", { style: { ...pillStyle(C.muted), fontFamily: C.mono, fontSize: 10.5, maxWidth: matrixFill ? 260 : "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, summary.root) : null,
            h("span", { style: pillStyle(C.subtle) }, typeof entryCount === "number" ? `条目 ${entryCount}` : summary ? `条目 ${summary.entries || 0}` : "条目 …"),
            h(
              "button",
              {
                type: "button",
                title: "重新读取面板状态与当前 tab 数据",
                onClick: refreshAll,
                style: { ...buttonStyle("ghost", false), padding: matrixFill ? "2px 8px" : "4px 10px", fontSize: 11.5 },
              },
              Icon("renew", 12),
              h("span", { style: { marginLeft: 4 } }, "刷新"),
            ),
            h(
              "button",
              {
                type: "button",
                title: "读取 GitHub 上 package.json 的版本并与本地比较（只提示，不自动安装）",
                onClick: checkUpdate,
                disabled: updateBusy,
                style: { ...buttonStyle("ghost", updateBusy), padding: matrixFill ? "2px 8px" : "4px 10px", fontSize: 11.5 },
              },
              Icon("renew", 12),
              h("span", { style: { marginLeft: 4 } }, updateBusy ? "检查中…" : "检查更新"),
            ),
            h(
              "button",
              {
                type: "button",
                title: "重新加载界面（插件已更新但页面还是旧 bundle 时用；不会重开整个应用）",
                onClick: reloadUi,
                style: { ...buttonStyle("ghost", false), padding: matrixFill ? "2px 8px" : "4px 10px", fontSize: 11.5 },
              },
              "重载界面",
            ),
          ),
          matrixFill ? null : h("div", { style: { marginTop: 5, color: C.subtle, fontSize: 12 } }, "跨项目 · 按版本 / 环境分区的经验层"),
          matrixFill ? null : h(
            "div",
            { style: { marginTop: 9, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
            summary && summary.stateDir ? h("span", { style: { ...pillStyle(C.muted), fontFamily: C.mono, fontSize: 10.5 } }, `state ${summary.stateDir}`) : null,
          ),
          matrixFill ? null : h("div", { style: { marginTop: 10 } }, h(BackgroundPicker, null)),
        ),
        updateError !== ""
          ? h("div", { style: { padding: matrixFill ? "10px 14px 0" : "12px 17px 0" } },
              h(Notice, { tone: "warn" }, "检查更新失败：", updateError),
            )
          : updateInfo && updateInfo.ok
            ? h("div", { style: { padding: matrixFill ? "10px 14px 0" : "12px 17px 0" } },
                h(Notice, { tone: updateInfo.hasUpdate ? "warn" : undefined },
                  updateInfo.hasUpdate
                    ? `发现新版本 ${updateInfo.latest}（当前 ${updateInfo.current}）`
                    : `已是最新版本（${updateInfo.current}）`,
                  updateInfo.hasUpdate && updateInfo.installSpec
                    ? h("div", { style: { marginTop: 4 } },
                        "在 DSH 插件页重装 ",
                        h("span", { style: { fontFamily: C.mono, fontSize: 11.5 } }, updateInfo.installSpec),
                        "，然后点上方「重载界面」。",
                      )
                    : null,
                ),
              )
            : null,
        hostError !== ""
          ? h("div", { style: { padding: "12px 17px 0" } },
              h(Notice, { tone: "warn" },
                "宿主没有响应 Lattice 面板接口（", h("span", { style: { fontFamily: C.mono, fontSize: 11.5 } }, hostError), "）。",
                h("div", { style: { marginTop: 4 } }, "请完全退出 DSH 桌面端再打开（不是刷新页面）。若仍出现，说明插件宿主未加载新代码。"),
              ),
            )
          : null,
        h(
          "div",
          { style: { display: "flex", gap: 6, padding: matrixFill ? "6px 14px 0" : "10px 17px 0" } },
          TABS.map((item) =>
            h(
              "button",
              {
                key: item.id,
                type: "button",
                onClick: () => setTab(item.id),
                style: {
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  border: `1px solid ${tab === item.id ? "transparent" : C.border}`,
                  background: tab === item.id ? C.accentSoft : "transparent",
                  color: tab === item.id ? C.accent : C.subtle,
                  borderRadius: 9,
                  padding: matrixFill ? "3px 10px" : "5px 12px",
                  fontSize: 12.5,
                  fontWeight: tab === item.id ? 600 : 500,
                  cursor: "pointer",
                  fontFamily: "inherit",
                },
              },
              Icon(item.icon, 13),
              item.label,
            ),
          ),
        ),
        h(
          "div",
          { key: `tabs-${reloadKey}`, style: matrixFill ? { flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column", padding: "8px 12px 12px" } : { padding: "12px 17px 17px" } },
          tab === "browse" ? h(BrowseTab, { onEntryCount: setEntryCount }) : null,
          tab === "matrix" ? h(MatrixTab, { fill: matrixFill }) : null,
          tab === "portable" ? h(PortableTab, null) : null,
          tab === "captures" ? h(CaptureTab, null) : null,
        ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* panel drawer: reachable from the chat header, not just settings     */
    /* ------------------------------------------------------------------ */

    const drawerStore = { open: false, subs: new Set() };

    // The host may run with the wallpaper-engine plugin, which sets
    // --dsw-alias-bg-base to transparent, and theme skins often declare
    // layer tokens with an alpha channel. Using a theme token as the
    // full-screen backdrop therefore lets the workspace/chat show through.
    // Pick an opaque pixel color instead (same dark/light probe that DSH
    // and the bundled plugins use: body[data-ds-dark-theme]).
    function pageIsDark() {
      if (typeof document === "undefined" || !document.body) return true;
      return document.body.hasAttribute("data-ds-dark-theme");
    }

    function opaquePage() {
      return pageIsDark() ? "#0f1115" : "#f6f7fb";
    }

    // When the wallpaper-engine plugin is active it paints the wallpaper in a
    // body-level .we-layer (z-index:-2) that sits *under* the app frame, so a
    // translucent full-screen backdrop would reveal the workspace, not the
    // wallpaper. Copy the wallpaper pixels into our own backdrop instead:
    // .we-layer holds an <img>/<video class="we-media"> or a live poster with a
    // background-image. Falls back to a flat opaque color when nothing matches.
    function wallpaperImage() {
      try {
        const layer = document.querySelector(".we-layer");
        if (!layer) return "";
        const media = layer.querySelector("img.we-media, video.we-media, .we-media");
        if (media) {
          if (media.tagName === "IMG" && media.currentSrc) return media.currentSrc;
          if (media.tagName === "VIDEO" && media.poster) return media.poster;
        }
        const poster = layer.querySelector(".we-live-poster");
        const bg = poster ? window.getComputedStyle(poster).backgroundImage || "" : "";
        const match = /url\("?([^")]+)"?\)/.exec(bg);
        if (match) return match[1];
      } catch {
        /* ignore: fall back to the flat color */
      }
      return "";
    }

    function pageBackground(override) {
      const image = wallpaperImage() || String(override || "");
      if (!image) return { background: opaquePage() };
      const scrim = pageIsDark()
        ? "linear-gradient(rgba(8, 10, 14, 0.74), rgba(8, 10, 14, 0.74))"
        : "linear-gradient(rgba(248, 250, 253, 0.82), rgba(248, 250, 253, 0.82))";
      const safe = String(image).replace(/"/g, "%22").replace(/\)/g, "%29");
      return {
        backgroundColor: pageIsDark() ? "#0b0d12" : "#f4f6fa",
        backgroundImage: scrim + ', url("' + safe + '")',
        backgroundSize: "cover, cover",
        backgroundPosition: "center, center",
        backgroundRepeat: "no-repeat, no-repeat",
      };
    }

    // Optional local-image backdrop for users without a wallpaper plugin.
    // The bytes are uploaded to the host (/lattice-panel/background) so the
    // choice survives restarts even though the desktop port changes.
    function BackgroundPicker() {
      const [meta, setMeta] = useState(undefined);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");

      useEffect(() => {
        let cancelled = false;
        getJson(API_STATE)
          .then((body) => {
            if (cancelled) return;
            const state = body && body.state ? body.state : body;
            setMeta(state && state.background ? state.background : null);
            syncHostBgFromState(state);
          })
          .catch(() => {
            if (!cancelled) setMeta(null);
          });
        return () => {
          cancelled = true;
        };
      }, []);

      const onPick = (event) => {
        const file = event.target.files && event.target.files[0];
        event.target.value = "";
        if (!file) return;
        if (!/^image\//.test(file.type)) {
          setError("请选择图片文件（PNG / JPEG / WebP / GIF / BMP）");
          return;
        }
        if (file.size > 8 * 1024 * 1024) {
          setError("图片超过 8MB，请先压缩再选");
          return;
        }
        setError("");
        setBusy(true);
        const reader = new FileReader();
        reader.onload = () => {
          fetch(API_BACKGROUND, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data_url: String(reader.result || "") }),
          })
            .then(async (res) => {
              const body = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error((body && body.error && body.error.message) || `HTTP ${res.status}`);
              setMeta(body.background || null);
              syncHostBgFromState({ background: body.background });
              setBusy(false);
            })
            .catch((err) => {
              setError(String((err && err.message) || err));
              setBusy(false);
            });
        };
        reader.onerror = () => {
          setError("读取本地图片失败");
          setBusy(false);
        };
        reader.readAsDataURL(file);
      };

      const onClear = () => {
        setError("");
        setBusy(true);
        fetch(API_BACKGROUND, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clear: true }),
        })
          .then(async (res) => {
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error((body && body.error && body.error.message) || `HTTP ${res.status}`);
            setMeta(null);
            syncHostBgFromState({ background: null });
            setBusy(false);
          })
          .catch((err) => {
            setError(String((err && err.message) || err));
            setBusy(false);
          });
      };

      const status =
        meta === undefined
          ? "读取中…"
          : meta
            ? `已设置 · ${meta.mime} · ${Math.max(1, Math.round((meta.bytes || 0) / 1024))} KB`
            : "未设置";

      return h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            padding: "8px 10px",
            border: `1px dashed ${C.border}`,
            borderRadius: 9,
            background: "transparent",
          },
        },
        h("span", { style: { fontSize: 11.5, color: C.subtle } }, "背景图"),
        h("span", { style: { fontSize: 11, color: C.muted } }, "（没有壁纸插件时，可给记忆库面板单独指定一张本地图片）"),
        h("span", { style: { flex: "1 1 auto" } }),
        h("span", { style: { fontSize: 11, color: meta ? C.ok : C.muted, fontFamily: meta ? C.mono : "inherit" } }, status),
        h(
          "label",
          { style: { ...buttonStyle("ghost", false), padding: "4px 10px", fontSize: 11.5, cursor: "pointer" } },
          "选择本地图片…",
          h("input", {
            type: "file",
            accept: "image/png,image/jpeg,image/webp,image/gif,image/bmp",
            onChange: onPick,
            disabled: busy,
            style: { display: "none" },
          }),
        ),
        meta ? h("button", { type: "button", onClick: onClear, disabled: busy, style: { ...buttonStyle("ghost", false), padding: "4px 10px", fontSize: 11.5 } }, "清除") : null,
        error !== "" ? h("span", { style: { fontSize: 11, color: C.error || C.warn } }, error) : null,
      );
    }

    function useDrawerOpen() {
      const [open, setOpen] = useState(drawerStore.open);
      useEffect(() => {
        const sub = () => setOpen(drawerStore.open);
        drawerStore.subs.add(sub);
        return () => drawerStore.subs.delete(sub);
      }, []);
      return open;
    }

    function setDrawerOpen(next) {
      drawerStore.open = typeof next === "boolean" ? next : !drawerStore.open;
      for (const sub of drawerStore.subs) sub();
    }

    // Host-stored panel background (used when no wallpaper plugin paints one).
    const bgStore = { url: "", subs: new Set() };

    function useHostBg() {
      const [url, setUrl] = useState(bgStore.url);
      useEffect(() => {
        const sub = () => setUrl(bgStore.url);
        bgStore.subs.add(sub);
        return () => bgStore.subs.delete(sub);
      }, []);
      return url;
    }

    function setHostBg(next) {
      const url = String(next || "");
      if (url === bgStore.url) return;
      bgStore.url = url;
      for (const sub of bgStore.subs) sub();
    }

    function hostBgUrl(meta) {
      return meta && meta.updatedAt ? `${API_BACKGROUND}?v=${encodeURIComponent(meta.updatedAt)}` : "";
    }

    function syncHostBgFromState(state) {
      setHostBg(hostBgUrl(state && state.background));
    }

    function LatticeHeaderButton() {
      return h(
        "button",
        {
          type: "button",
          title: "Lattice 记忆库",
          "aria-label": "Lattice 记忆库",
          onClick: () => setDrawerOpen(),
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            border: `1px solid ${C.border}`,
            background: "transparent",
            color: C.subtle,
            borderRadius: 8,
            padding: "4px 9px",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 12,
          },
        },
        Icon("library", 14),
        "记忆库",
      );
    }

    function LatticeDrawer() {
      const open = useDrawerOpen();
      const hostBg = useHostBg();
      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === "Escape") setDrawerOpen(false);
        };
        window.addEventListener("keydown", onKey);
        let cancelled = false;
        getJson(API_STATE)
          .then((body) => {
            if (!cancelled) syncHostBgFromState(body && body.state ? body.state : body);
          })
          .catch(() => {
            /* background is optional; the panel reports its own errors */
          });
        return () => {
          cancelled = true;
          window.removeEventListener("keydown", onKey);
        };
      }, [open]);
      if (!open) return null;
      return h(
        "div",
        {
          style: {
            position: "fixed",
            inset: 0,
            zIndex: 200,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: "68px 18px 16px",
            ...pageBackground(hostBg),
            color: C.text,
            pointerEvents: "auto",
            fontFamily: "inherit",
            overflow: "hidden",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
          h("span", { style: { display: "flex", color: C.accent } }, Icon("library", 17)),
          h("span", { style: { fontSize: 15, fontWeight: 650 } }, "Lattice 记忆库"),
          h("span", { style: { color: C.muted, fontSize: 11.5 } }, "Esc 或右上角「关闭」返回工作区"),
          h("span", { style: { flex: "1 1 auto" } }),
          h(
            "button",
            { type: "button", onClick: () => setDrawerOpen(false), style: { ...buttonStyle("ghost", false), padding: "5px 14px", fontSize: 12.5 } },
            "关闭",
          ),
        ),
        h(
          "div",
          { style: { flex: "1 1 auto", minHeight: 0, overflow: "auto", width: "100%", display: "flex", flexDirection: "column" } },
          h(
            "div",
            { style: { width: "100%", flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" } },
            h(LatticePanel, { fullBleed: true }),
          ),
        ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* plugin apply                                                        */
    /* ------------------------------------------------------------------ */

    const inject = ["slots"];

    function apply(ctx) {
      slotCtx = ctx;
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "lattice-onboarding", order: 40 },
          () => h(OnboardingCard, { ctx }),
        ),
      );
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "lattice-drawer", order: 60 },
          LatticeDrawer,
        ),
      );
      ctx.slots.inject("conversation.session.header.utilities", () =>
        ctx.slots.register(
          {
            name: "conversation.session.header.utilities",
            id: "dsh-lattice-memory:toggle",
            order: 60,
            registrant: "dsh-lattice-memory",
          },
          LatticeHeaderButton,
        ),
      );
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          { name: "settings.section", id: "lattice-library", order: 120, label: () => "Lattice 记忆" },
          LatticePanel,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
