/**
 * Lattice — browser half (first-run onboarding card).
 *
 * Loaded as a hand-written `dsh.client` ModuleLoader bundle (no build step).
 * The card lives in the `shell.overlay` slot and only appears while the host
 * reports no configured library root. It talks to the host half through two
 * same-origin routes: GET /lattice/state and POST /lattice/setup.
 *
 * Picking a folder prefers the DSH directory pickers this client already has:
 * `ctx.uiWorkspace.pickDirectory()`, then the generated
 * `ctx.remote.directoryPicker.pick()` verb; when neither is reachable the card
 * degrades to a typed path (the host re-validates it anyway).
 */
window.__ModuleLoader__.load({
  id: "dsh-lattice-memory",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;

    const API_STATE = "/lattice/state";
    const API_SETUP = "/lattice/setup";
    const DISMISS_KEY = "dsh-lattice-memory:onboarding-dismissed";

    const COLOR = {
      text: "var(--dsw-alias-label-primary, #1f2328)",
      muted: "var(--dsw-alias-label-tertiary, #6e7781)",
      border: "var(--dsw-alias-border-l2, rgba(31,35,40,.15))",
      surface: "var(--dsw-alias-bg-layer-1, #ffffff)",
      layer3: "var(--dsw-alias-bg-layer-3, #f6f8fa)",
      accent: "var(--dsw-alias-state-business-primary, #3964fe)",
      accentText: "#ffffff",
      error: "var(--dsw-alias-state-error-primary, #cf222e)",
    };

    /** Session-scoped dismissal: "稍后" hides the card until the page reloads. */
    function isDismissed() {
      try {
        return window.sessionStorage.getItem(DISMISS_KEY) === "1";
      } catch (err) {
        return false;
      }
    }

    function markDismissed() {
      try {
        window.sessionStorage.setItem(DISMISS_KEY, "1");
      } catch (err) {
        /* private mode: dismissal is best-effort */
      }
    }

    function styleButton(primary) {
      return {
        border: `1px solid ${primary ? COLOR.accent : COLOR.border}`,
        background: primary ? COLOR.accent : COLOR.layer3,
        color: primary ? COLOR.accentText : COLOR.text,
        borderRadius: 8,
        padding: "6px 14px",
        fontSize: 13,
        fontFamily: "inherit",
        cursor: "pointer",
        lineHeight: 1.4,
      };
    }

    /**
     * Ask DSH for a folder. Returns the picked absolute path, or null when the
     * user cancelled or no picker service is reachable.
     */
    async function pickFolder(ctx) {
      try {
        const workspace = ctx.uiWorkspace;
        if (workspace && typeof workspace.pickDirectory === "function") {
          const picked = await workspace.pickDirectory();
          if (typeof picked === "string" && picked.trim() !== "") return picked;
        }
      } catch (err) {
        /* try the next seam */
      }
      try {
        const remote = ctx.remote;
        const picker = remote && remote.directoryPicker;
        if (picker && typeof picker.pick === "function") {
          const picked = await picker.pick();
          if (typeof picked === "string" && picked.trim() !== "") return picked;
        }
      } catch (err) {
        /* no picker in this composition: fall back to manual input */
      }
      return null;
    }

    function OnboardingCard(props) {
      const ctx = props.ctx;
      const [snapshot, setSnapshot] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState("");
      const [manual, setManual] = react.useState(false);
      const [manualPath, setManualPath] = react.useState("");
      const [doneRoot, setDoneRoot] = react.useState("");
      const [hidden, setHidden] = react.useState(false);
      const [loadError, setLoadError] = react.useState("");

      react.useEffect(() => {
        let cancelled = false;
        if (isDismissed()) {
          setHidden(true);
          return () => {
            cancelled = true;
          };
        }
        fetch(API_STATE, { headers: { Accept: "application/json" } })
          .then(async (response) => {
            if (!response.ok) {
              let detail = "";
              try {
                detail = (await response.text()).slice(0, 180);
              } catch (err) {
                detail = "";
              }
              const origin =
                typeof window !== "undefined" && window.location ? window.location.origin : "?";
              throw new Error(
                `HTTP ${response.status} from ${API_STATE}` +
                  (detail !== "" ? ` — ${detail}` : "") +
                  ` | page origin ${origin}`,
              );
            }
            return response.json();
          })
          .then((json) => {
            if (!cancelled) setSnapshot(json && json.ok === true ? json : null);
          })
          .catch((err) => {
            /* No usable host route: surface why instead of staying silently invisible. */
            if (!cancelled) {
              setSnapshot(null);
              setLoadError(String((err && err.message) || err));
            }
          });
        return () => {
          cancelled = true;
        };
      }, []);

      async function submit(body) {
        setBusy(true);
        setError("");
        try {
          const response = await fetch(API_SETUP, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          let json = null;
          try {
            json = await response.json();
          } catch (err) {
            json = null;
          }
          if (!response.ok || !json || json.ok !== true) {
            const message =
              json && json.error && (json.error.message || json.error.code)
                ? json.error.message || json.error.code
                : `setup failed (HTTP ${response.status})`;
            throw new Error(message);
          }
          setDoneRoot(typeof json.root === "string" ? json.root : "");
          setSnapshot((previous) =>
            previous ? Object.assign({}, previous, { configured: true, root: json.root || "" }) : previous,
          );
          window.setTimeout(() => setHidden(true), 2000);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      }

      async function browse() {
        if (busy) return;
        setError("");
        const picked = await pickFolder(ctx);
        if (picked === null) {
          setManual(true);
          return;
        }
        await submit({ path: picked });
      }

      function dismiss() {
        markDismissed();
        setHidden(true);
      }

      if (hidden) return null;

      const root = COLOR;

      if (doneRoot !== "") {
        return h(
          "div",
          {
            role: "status",
            style: {
              position: "fixed",
              right: 24,
              bottom: 24,
              zIndex: 60,
              pointerEvents: "auto",
              maxWidth: 420,
              padding: "10px 14px",
              borderRadius: 10,
              border: `1px solid ${root.border}`,
              background: root.surface,
              color: root.text,
              fontSize: 13,
              lineHeight: 1.5,
              boxShadow: "0 8px 24px rgba(0,0,0,.12)",
            },
          },
          h("div", { style: { fontWeight: 600 } }, "Lattice 已就绪"),
          h("div", { style: { color: root.muted, wordBreak: "break-all" } }, doneRoot),
        );
      }

      if (loadError !== "") {
        return h(
          "div",
          {
            role: "status",
            style: {
              position: "fixed",
              right: 24,
              bottom: 24,
              zIndex: 60,
              pointerEvents: "auto",
              width: 380,
              maxWidth: "calc(100vw - 48px)",
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: "12px 14px",
              borderRadius: 12,
              border: `1px solid ${root.border}`,
              background: root.surface,
              color: root.text,
              fontSize: 13,
              lineHeight: 1.5,
              boxShadow: "0 12px 32px rgba(0,0,0,.16)",
            },
          },
          h("div", { style: { fontWeight: 700, fontSize: 14 } }, "Lattice"),
          h("div", { style: { color: root.muted } }, "读取本地状态接口失败，首启引导暂时不可用。"),
          h("div", { style: { color: root.muted, fontSize: 12, wordBreak: "break-all" } }, loadError),
          h(
            "div",
            { style: { color: root.muted, fontSize: 12 } },
            "可以完全退出并重开 DSH 桌面端；或在对话里让我运行 lattice_setup 手动配置库根。",
          ),
          h(
            "div",
            { style: { display: "flex", gap: 8 } },
            h("button", { type: "button", onClick: dismiss, style: styleButton(false) }, "关闭"),
          ),
        );
      }

      if (snapshot === null) return null;
      if (snapshot.configured === true) return null;
      if (snapshot.onboarding === false) return null;

      const card = {
        position: "fixed",
        right: 24,
        bottom: 24,
        zIndex: 60,
        pointerEvents: "auto",
        width: 380,
        maxWidth: "calc(100vw - 48px)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "14px 16px",
        borderRadius: 12,
        border: `1px solid ${root.border}`,
        background: root.surface,
        color: root.text,
        fontSize: 13,
        lineHeight: 1.55,
        boxShadow: "0 12px 32px rgba(0,0,0,.16)",
      };

      return h(
        "div",
        { role: "dialog", "aria-label": "Lattice 首次设置", style: card },
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", gap: 8 } },
          h("div", { style: { fontWeight: 700, fontSize: 15 } }, "Lattice"),
          h("div", { style: { color: root.muted, fontSize: 12 } }, "共享项目记忆库未配置"),
        ),
        h(
          "div",
          { style: { color: root.muted } },
          "选择一个文件夹作为共享记忆库。所有工作区共用它；条目按版本/环境标签区分，检索时只召回与应用当前项目相关的部分。可以放在任意位置，建议之后放进 git 仓库。",
        ),
        h("div", { style: { color: root.muted, fontSize: 12 } }, `默认位置：${snapshot.defaultRoot || ""}`),
        manual
          ? h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: 8 } },
              h("input", {
                type: "text",
                value: manualPath,
                spellCheck: false,
                placeholder: "输入绝对路径，例如 D:\\Lattice",
                onChange: (event) => setManualPath(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === "Enter" && manualPath.trim() !== "") void submit({ path: manualPath });
                },
                style: {
                  border: `1px solid ${root.border}`,
                  background: root.layer3,
                  color: root.text,
                  borderRadius: 8,
                  padding: "6px 10px",
                  font: "inherit",
                  fontSize: 13,
                  outline: "none",
                },
              }),
              h(
                "div",
                { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
                h(
                  "button",
                  {
                    type: "button",
                    disabled: busy || manualPath.trim() === "",
                    onClick: () => void submit({ path: manualPath }),
                    style: styleButton(true),
                  },
                  "使用此路径",
                ),
                h(
                  "button",
                  { type: "button", disabled: busy, onClick: () => setManual(false), style: styleButton(false) },
                  "取消",
                ),
              ),
            )
          : h(
              "div",
              { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
              h(
                "button",
                { type: "button", disabled: busy, onClick: () => void browse(), style: styleButton(true) },
                busy ? "处理中…" : "选择文件夹…",
              ),
              h(
                "button",
                {
                  type: "button",
                  disabled: busy,
                  onClick: () => void submit({ action: "default" }),
                  style: styleButton(false),
                },
                "使用默认位置",
              ),
              h("button", { type: "button", disabled: busy, onClick: dismiss, style: styleButton(false) }, "稍后"),
            ),
        error !== ""
          ? h("div", { role: "alert", style: { color: root.error, fontSize: 12, wordBreak: "break-word" } }, error)
          : null,
      );
    }

    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("shell.overlay", () => {
        return ctx.slots.register(
          {
            name: "shell.overlay",
            id: "lattice-onboarding",
            order: 40,
            label: () => "Lattice",
          },
          () => h(OnboardingCard, { ctx }),
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
