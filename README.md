# Lattice (`dsh-lattice-memory`)

跨项目、按版本/环境区分的**项目经验记忆层**，给 DeepSeek Harness（DSH）用。

同一个功能在不同版本、不同加载器、不同技术栈里往往需要不同做法。Lattice 把这些"此版本应当这样做"的经验沉淀成一个**共享记忆库**：所有工作区共用同一个库，条目按维度（`game / mcver / loader / platform / branch / ...`）打标签，检索时只召回与当前项目匹配的部分。

> 设计文档见 [`PLAN.md`](./PLAN.md)。当前进度：**M0（骨架 + 配置 + 首启引导 + 工具桩）已落地**，检索/矩阵/写入闭环在 M1–M3。

## 当前状态（M0）

已实现：

- DSH 插件骨架：`cordis.patch.yml` bundle 行 + `package.json` 的 `dsh.bundle` / `dsh.client` 声明；无构建步骤（纯 ESM + 手写 web client bundle）。
- schemastery `Config`：`root` / `onboarding` / `debug` / `inject` / `projectOverlay` / `staleDays`，非法配置在加载期报错。
- 首启引导：web 卡片（`shell.overlay`，右下角）通过 `GET /lattice/state`、`POST /lattice/setup` 与宿主通信；"选择文件夹…"优先调用 DSH 原生目录选择器（`ctx.uiWorkspace.pickDirectory()`，其次 `ctx.remote.directoryPicker.pick()`），不可用时降级为手动输入路径。**2026-11-02 已在 DSH 桌面端实测通过**：选文件夹 → 建库 → 卡片消失，库根 `F:\Lattice`。
- 库根状态：`<DSH_HOME>/lattice/root.json`；库内标记 `<root>/.lattice-root.json`，可区分"已有 Lattice 库（接管）"与"无关的非空目录（原地初始化）"。
- 项目画像检测：`lattice_profile` 读取工作区自带元数据（`gradle.properties`、`mods.toml` / `neoforge.mods.toml` / `fabric.mod.json`、`package.json`、`pyproject.toml`、`Cargo.toml`、`AndroidManifest.xml`、git 分支），输出 preset + dims。
- 工具桩：`lattice_setup` / `lattice_status` / `lattice_profile` / `lattice_search`（检索为 M0 stub，返回库状态），以及常驻提示段（告诉模型库在哪、什么条件才可信）。

未实现（后续里程碑）：BM25 检索与维度过滤（M1）、常驻索引注入与矩阵/缺口（M2）、记录/校验闭环与去重（M3）、导出 SKILL/发布（M4–M5）。

## 安装

本机验证请在 DSH 里执行（本地路径安装，按你的 DSH 版本二选一）：

```bash
# 方式 A：DSH CLI
dsh plugin --profile desktop add F:\温迪\dsh-lattice-memory

# 方式 B：让 DSH 里的 agent 调用 plugin_manager 的 install_bundle，
# target 传包的绝对路径（F:\温迪\dsh-lattice-memory）
```

安装后重启会话（或让 DSH 重新加载插件），然后：

1. 在对话里让 agent 调用 `lattice_status`，确认 `configured`、`state_dir` 是否符合预期；
2. 完全退出并重开 DSH 桌面端（客户端 bundle 在页面启动时组装，装插件后必须重启；`Ctrl+R` 在桌面端可能不生效）；
3. 页面右下角会出现 **Lattice 首启卡片**（若 `onboarding: true` 且尚未配置库根）；
4. 点「选择文件夹…」挑一个空目录或已有 Lattice 库，或点「使用默认位置」（`<DSH_HOME>/lattice-library`）。

> 桌面端若使用 `file://` + IPC 下发前端（没有 `webServer` 服务），HTTP 路由不会挂载，卡片不会出现；此时直接让 agent 调 `lattice_setup` 传路径即可。

## 配置

配置写在**当前 profile 的 `cordis.patch.yml`** 里（用户 patch 层在升级后保留）：

```yaml
- id: lattice
  config:
    root: "D:/Lattice"        # 留空 = 用首启卡片选的库根
    onboarding: true          # 未配置时是否显示首启卡片
    debug: false              # true = 把首启路由诊断写入 <stateDir>/route-debug.log
    staleDays: 180            # verified_on 超过多少天视为过期
    inject:                   # 预留（M2 常驻索引）
      enabled: true
      topK: 8
      maxTokens: 1500
    projectOverlay: false     # 预留：是否额外读 <workspace>/.lattice
```

优先级：`config.root` > 首启结果（`root.json`）。`config.root` 非法（不存在或不是目录）时回退到首启结果。

排查首启卡片问题：把 `debug: true` 写进配置并重启桌面端，卡片每次请求会向 `<stateDir>/route-debug.log`（默认 `~/.dsh/lattice/route-debug.log`）追加一行 JSON，含 `method/url/host/origin/admitted/code/connection`；`admitted: true` 表示已过 DSH 信任栅栏。

## 工具

| 工具 | 作用 |
| --- | --- |
| `lattice_status` | 报告是否已配置、库根、条目数、状态目录、生效配置（排查安装用） |
| `lattice_setup` | 首次配置/更换库根；`path=...` 或 `use_default=true`；幂等，已有库原样接管，无关非空目录原地初始化 |
| `lattice_profile` | 识别当前工作区的 preset 与维度（不跑构建工具）；`path=...` 可指定工作区 |
| `lattice_search` | **M0 桩**：校验库并返回库状态；M1 起做 BM25 + 维度过滤检索 |

## 记忆库目录布局

```text
<library-root>/
  .lattice-root.json     # 标记文件：schema 版本、创建时间
  projects.json          # 工作区 → 项目画像的显式覆盖（M2 起用）
  entries/               # 每条记忆一个 Markdown 文件（M1 起写入）
```

插件自身状态（不是记忆库）：

```text
<DSH_HOME>/lattice/root.json   # 首启选定的库根、来源、更新时间
```

`DSH_HOME` 与 DSH 一致：默认 `~/.dsh`，启动器可覆盖。

## 开发

- 无构建步骤：`src/*.js` 即发布物；`src/client.js` 是手写的 `dsh.client` ModuleLoader bundle（`window.__ModuleLoader__.load({ id, factory })`，`id` 必须等于 loader 行名 `dsh-lattice-memory`）。
- 文件分工：`src/index.js`（宿主：Config、工具、路由、提示段）、`src/state.js`（状态目录/库根/初始化）、`src/detect.js`（项目画像）、`src/client.js`（首启卡片）。
- 改完直接让 DSH 重新加载插件；需要最小验证时先 `lattice_status` 再点卡片。

## 路线图

| 里程碑 | 内容 |
| --- | --- |
| M0（已完成） | 骨架、Config、首启引导、画像检测、工具桩 |
| M1 | 条目 frontmatter 模型、BM25 + CJK 二元组检索、维度过滤、`lattice_get` / `lattice_list` |
| M2 | 常驻索引注入（≤1500 tokens）、`lattice_matrix` / `lattice_gaps`、overlay |
| M3 | `lattice_record` / `lattice_verify` 写入闭环、去重、密钥扫描、stale 处理 |
| M4–M5 | git 协作、导出 SKILL、发布到 npm / plugin market |

## 仓库

`https://github.com/19136644525lxy/dsh-lattice-memory.git`

## 许可

MIT
