# Lattice（`dsh-lattice-memory`）设计方案 v2

> 版本：v2.1（2026-11-01）— 依据 2026-11-01 拍板更新（公开发布 / 首启选库根弹窗 / overlay 关闭 / MVP=M0–M3 / 项目仓库已定）
> 状态：M0 已落地并在 DSH 桌面端实测通过（2026-11-02）；M1 检索已实现并实测通过（2026-11-02）；M2 常驻注入 + 矩阵/缺口 + overlay 已实现并实测通过（2026-11-02）；M3 写入闭环已实现并实测通过（2026-11-02）；M4 通用性（projects.json 覆盖 + 条目缓存 + 多预设自测）已实现并实测通过（2026-11-02）；M5 导出/导入 + 设置面板已实现并实测（2026-11-02）；M6 半自动捕获已实现并实测（2026-11-02）；M7 全自动捕获（失败链 + 人类纠正）已实现并实测通过（2026-11-02，含跨轮纠正修复）；公开发布暂缓
> 宿主：DeepSeek Harness 0.2.x（Cordis 插件体系 + bundle 安装）
> 名字：品牌 **Lattice**，npm 包名 `dsh-lattice-memory`（2026-11-01 查重：registry.npmjs.org 返回 404，未注册；公开发布前再查一次，撞名则改用 scoped 包名 `@<scope>/dsh-lattice-memory`，展示名保持 Lattice）
> 仓库：**https://github.com/19136644525lxy/dsh-lattice-memory.git**（本机 DSH 网络当前无法直连 github.com：web_fetch 报 `hostname resolves to a non-public IP address`；本地先 `git init`，由用户推送或使用现有远程）
> 定位一句话：**给「同一功能在多个版本 / 变体 / 环境下需要不同实现」的项目，提供可验证、可共享、自动召回的经验层。**

---

## 0. 从 v1 到 v2：为什么改

v1（ModMemory）把 Minecraft 模组当成了插件本身，v2 把它降级为**第一个预设（preset）**。原因是内核算术与 Minecraft 无关：

> 条目 = **feature（功能）× dims（维度组合：版本 / 加载器 / 平台 / 宿主 / 产品线）**，
> 价值 = **(a) 跨工作区共享已确认经验；(b) 用矩阵暴露“哪些组合还没验证”；(c) 在正确的工作区自动召回。**

v2 的三条不可妥协的设计支柱（任何新增功能必须服务其中至少一条）：

1. **结构化**：条目是带维度、状态、证据的 Markdown，而不是自由聊天记录；
2. **矩阵化**：能一眼看出 `feature × dims` 网格里哪些格已验证、哪些是缺口；
3. **自动召回**：按当前工作区画像自动注入，不依赖“人记得去搜”。

非目标（明确不做，避免变成通用笔记应用）：不做通用聊天记忆（那属于 `dsh-memory` 类插件）、不做向量语义搜索（预留接口）、不自动生成项目代码、不做 IDE、不替代会话压缩 / 会话搜索。

---

## 1. 核心概念

### 1.1 维度（Dimension）
维度是**键值对**，含义由项目自己定义；插件只负责“存、筛、比、展示”。

内置维度（作为默认建议，不强制）：

| 维度 | 典型值 | 说明 |
| --- | --- | --- |
| `game` | `minecraft` / `factorio` / `skyrim` | 游戏模组场景；跨游戏防串味 |
| `mcver` | `1.20.1` / `1.21.1` / `1.21.x` | Minecraft 版本 |
| `loader` | `forge` / `neoforge` / `fabric` / `quilt` | 加载器 |
| `host` | `vscode` / `obsidian` / `wordpress` | 宿主平台（插件类项目） |
| `runtime` | `node18` / `node20` / `jdk17` / `python3.11` | 运行时 |
| `platform` | `ios` / `android` / `windows` / `linux` | 平台 |
| `sdk` | `spring-boot-2` / `spring-boot-3` | 依赖 / SDK 大版本 |
| `product` | `pro` / `lite` / `白标A` | 产品线 / 品牌变体 |
| `branch` | `1.20.1-dev` | 兜底维度（从 git 分支名猜） |

维度值支持三种写法，方便表达“兼容区间”：

- 精确值：`1.21.1`
- 列表：`["1.21", "1.21.1"]`（任一命中即算匹配）
- 区间 / 通配：`">=1.21 <1.22"`、`"1.20.x"`

### 1.2 条目（Entry）
一条经验 = 一个 Markdown 文件，YAML frontmatter + 正文。

```yaml
---
id: ore-gen/1.21.1-neoforge
kind: contract            # contract | decision | gotcha | port | checklist | reference | note
title: "1.21.1 NeoForge 矿物生成：用 BiomeModifier + Codec，别用 1.20 的 OreFeature"
summary: "1.21 起 worldgen 改为 datapack codec 驱动；直接移植 1.20 的 OreFeature 会在加载期报错"
feature: ore-generation   # 矩阵键：同一功能跨版本/变体聚合
dims:
  game: minecraft
  mcver: 1.21.1
  loader: neoforge
  mod: examplemod
status: verified          # draft | verified | stale | deprecated | superseded
confidence: high          # low | medium | high
verified_on: 2026-09-12
evidence:
  - file: src/main/java/.../OreGen.java#L42-L67
  - run: "gradlew build → 通过（1.21.1-neoforge 分支）"
  - url: https://docs.neoforged.net/...
supersedes: []
related: []
applies_when:             # 可选：让「主动注入」知道何时该冒出来（M4）
  files: ["src/main/java/**/OreGen*.java", "src/main/resources/data/**/worldgen/**"]
  symbols: ["BiomeModifier", "OreFeature"]
tags: [worldgen, datapack, codec]
created: 2026-09-01
updated: 2026-09-12
---

> TL;DR：1.21 的 worldgen 必须走 datapack（JSON + codec），不要调用旧 OreFeature API。

## 结论
…

## 为什么
…

## 反例 / 别这么做
…

## 移植步骤
…

## 验证方法
…
```

正文模板不强制，但 `summary`（或正文首行 `> TL;DR`）会用于检索摘要与提示注入，lint 会提示缺失。

### 1.3 工作区画像（Profile）
每次会话开始时，插件把“当前工作区是什么”识别成一组维度：

```json
{
  "root": "F:\\projects\\examplemod",
  "preset": "minecraft-mod",
  "dims": { "game": "minecraft", "mcver": "1.21.1", "loader": "neoforge", "mod": "examplemod" },
  "sources": { "mcver": "gradle.properties:minecraft_version", "loader": "build.gradle:net.neoforged.moddev" },
  "confidence": "high"
}
```

识别失败不报错，退化为「无维度画像」：检索仍可用，但所有带维度的条目都会被标为“跨环境参考”。

### 1.4 矩阵（Matrix）
`feature × dimA × dimB` 的二维视图（维度对由预设或参数指定）：

| feature: ore-generation | forge | neoforge | fabric |
| --- | --- | --- | --- |
| 1.20.1 | ✓ `ore-gen/1.20.1-forge` | ◐ `ore-gen/1.20-common`（draft） | ✗ 缺口 |
| 1.21.1 | ✗ 缺口 | ✓ `ore-gen/1.21.1-neoforge` | ✗ 缺口 |

图例：✓ verified；◐ 仅 draft / stale；✗ 无条目；+ 其他 feature 的已验证经验存在于此格（迁移提示）。

**缺口不是装饰**：`lattice_gaps` 会按“其他格已有多少条已验证经验”给缺口排序，提示“这个组合最值得补”。

---

## 2. 完整功能清单（按优先级）

### P0 — MVP 必须（M0–M3 交付）

| 功能 | 说明 |
| --- | --- |
| 画像识别 | 预设式探测 + 自定义 extractor + 显式 override，显示来源与置信度 |
| Markdown 库 | 多根存储（共享库 + 可选工作区 overlay）、原子写、frontmatter 解析与校验 |
| 索引 | 字段加权倒排 + BM25；中英文与驼峰/下划线标识符分词；增量重建 |
| 检索 | `search / get / list`：维度重合打分、跨环境降权标注、状态与新鲜度加权、结果摘要限 token |
| 写入闭环 | `record`（默认 draft、evidence 必填、相似去重、密钥扫描）+ `verify`（升 verified / 降 stale） |
| 矩阵与缺口 | `matrix`（任意两个维度）+ `gaps`（按重要性排序的缺口） |
| 提示注入 | 常驻“画像 + 相关条目摘要”段，预算可控、稳定排序（保 KV cache） |
| 质量检查 | `lint`：证据缺失、过期、重复、冲突、孤立 feature、未知维度 |

### P1 — 首批增强（M4）

| 功能 | 说明 |
| --- | --- |
| 第二个非 MC 预设 | `node-package`（验证通用性，见 §7 工作流） |
| 自定义维度 / 预设 | 用户级 extractor（regex / JSONPath）与维度定义，不写代码也能扩 |
| 主动注入 | 依据 `applies_when.files` 在编辑/写入前注入 1–2 条相关 gotcha（依赖 `tools/pre-execute`，实验项） |
| `brief` | 某 feature（或某个目标版本）的「移植/重建指南」Markdown：逐格现状 + 已知坑 + 缺口清单 |
| `stats` | 条目数、验证率、按维度覆盖率、过期数 |

### P2 — 导出/导入与设置面板（M5，发布暂缓）

| 功能 | 说明 |
| --- | --- |
| 导出通道 | `lattice_export`：子集导出为 JSON（可再导入）/ `SKILL.md`（skills 通道）/ `AGENTS.md` 片段（已实现） |
| 导入 | `lattice_import`：从 Lattice JSON 导入，默认 dry-run 展示新增/id 冲突/近似重复/凭证/非法记录（session-search 候选导入留作后续） |
| 面板 UI | 设置页 `settings.section`：「Lattice 记忆」分节，含浏览 / 检索 / 矩阵网格 / 导出导入（已实现，默认可见） |
| 发布 | npm + plugin market 索引条目 → **暂缓**（2026-11-02 用户拍板） |

不做的候选（记入 open questions）：自动从会话末尾生成 draft、跨设备同步（交给 git）、语义 embedding（接口预留）、质量门禁拦截（误伤风险高）。

---

## 3. 工作区画像与预设

### 3.1 内置预设

| preset | 识别来源（示例） | 产出维度 |
| --- | --- | --- |
| `minecraft-mod` | `gradle.properties`（minecraft_version / forge_version / neoforge_version / fabric_loader_version / quilt_loader_version / loom.platform）、`META-INF/mods.toml`、`neoforge.mods.toml`、`fabric.mod.json`、`build.gradle` 插件 id、分支名兜底 | game, mcver, loader, mod |
| `node-package` | `package.json`：`engines.node`、`peerDependencies`、`packageManager`、`version`；分支名兜底 | runtime(node18/20/22…), host(可选), product(可选) |
| `python` | `pyproject.toml`（requires-python、classifiers）、`tox.ini`、`.python-version` | runtime(python3.10+) |
| `rust` | `rust-toolchain.toml`、`Cargo.toml`（rust-version） | runtime(rust1.75…) |
| `android` | `build.gradle(.kts)`：compileSdk / minSdk / AGP / Kotlin | platform(android), sdk(agp-8.x), runtime(kotlin-2.x) |
| `gradle-jvm` | Java toolchain、Spring Boot / Kotlin 插件 id | runtime(jdk17), sdk(spring-boot-3) |
| `generic` | 仓库名 + 分支名（无维度，提示用户配置 extractor） | branch |

### 3.2 识别优先级

1. **显式 override**：库根 `projects.json`（glob 路径 → dims）；
2. **用户 extractor**（Config `detect.extractors`，见 §9）；
3. **内置预设自动探测**；
4. **分支名兜底**（`1.20.1`、`1.21-neoforge`、`node18` 等模式）。

每条维度的 `sources` 记录“值从哪来”，注入段里原样展示——错了一眼能看出是哪个文件读错了。

### 3.3 缓存与失效

- 按工作区绝对路径缓存画像；检测文件 mtime 变化或超过 `detect.cacheSeconds`（默认 300s）时重算；
- 重算只在下次会话开始 / 工具调用时发生，绝不阻塞编辑器操作；
- 同一会话内画像不变，保证提示词稳定（KV cache 友好）。

---

## 4. 存储、索引与检索

### 4.1 目录结构

**库根 = 用户自己选的目录**（不再默认写死 `$DSH_HOME/lattice`，见 §14 首启引导）。插件状态目录与库根分离：

```
$DSH_HOME/lattice/                  # 插件状态目录（不是记忆库本体）
├── root.json                       # 首启选择的库根路径 + 版本号（唯一真源，见 §14）
└── onboarding.json                 # 引导状态（未完成 / 已跳过 / 版本）
```

```
<用户选择的库根>/                    # 例如 F:\Lattice 或 D:\Notes\lattice
├── entries/                        # 共享层：跨工作区
│   ├── ore-gen__1.21.1-neoforge.md
│   └── node-fetch__node20.md
├── projects.json                   # 路径 → 维度的显式覆盖
├── .lattice-root.json              # 标记文件：确认真实库根，防误选（只读用途）
└── .index.json                     # 派生索引（自动生成，建议 gitignore）
```

- 库根由首启弹窗「选择文件夹」决定，可随时在设置页/命令中更换（见 §14.4）；
- 条目文件名 = `<feature>__<id-suffix>.md`，id 全库唯一；
- 写文件用「临时文件 + rename」原子替换；
- `.index.json` 记录文件 mtime，增量重建；
- 共享库本身就是一个 git 仓库，`readOnly` 模式只读共享；
- **项目层 overlay（`<workspace>/.lattice/`）已关闭**（2026-11-01 拍板），代码保留开关能力但默认不启用、文档不宣传。

### 4.2 分词与索引

- 英文/代码标识符：按非字母数字切分，再拆 camelCase 与 snake_case，小写化；
- 中文：二元组（bigram）切分；
- 字段权重：title ×3、feature ×3、tags ×2、body ×1（summary 并入 body，但摘要匹配额外 +0.5 系数）。

### 4.3 排序公式

```
final = BM25(query)
      × (1 + 0.25 × clamp(dimMatch, -1, 1))     # 维度重合度：一致 +1，兼容 +0.6，冲突 -1，未知 0
      × statusWeight                            # verified 1.0 / draft 0.55 / stale 0.5 / deprecated 0.2
      × freshness                               # verified_on 90 天内 ×1.0，之后每 90 天 ×0.9（下限 0.6）
```

- `deprecated` / `superseded` 默认不出现在结果里（`status:` 过滤可显式查看）；
- 维度冲突不隐藏：结果里带 `⚠ 不同环境，仅作参考` 标记。

### 4.4 工具清单（`lattice_*`）

| 工具 | 参数（要点） | 输出 |
| --- | --- | --- |
| `lattice_profile` | `root?`、`refresh?` | 画像：dims、sources、preset、confidence；含一句“如何纠错”的提示 |
| `lattice_search` | `query`、`kinds?`、`dims?`、`status?`、`tags?`、`limit=10`、`maxTokens=1200` | 排序后的摘要列表（id/title/summary/维度/状态/证据数） |
| `lattice_get` | `ids: string[]`、`format: markdown \| json` | 完整条目（正文 + 证据 + 关联） |
| `lattice_list` | `feature?`、`dims?`、`status?`、`page` | 条目清单（不含正文） |
| `lattice_record` | `title`、`kind`、`feature`、`dims?`（缺省取画像）、`summary?`、`body`、`evidence[]`、`scope: library\|project`、`status?: draft` | 新 id + 校验结果（去重 / 密钥 / 维度未知警告） |
| `lattice_verify` | `id`、`verdict: verified\|stale\|deprecated`、`note?` | 更新状态 + 日期；返回该条目的矩阵影响 |
| `lattice_matrix` | `row?`、`col?`（缺省取预设轴，如 mcver × loader）、`feature?`、`status?` | Markdown 矩阵 + 每格条目 id + 图例 |
| `lattice_gaps` | `feature?`、`dims?`（目标环境）、`includeDraft=false` | 缺口列表，按重要性排序（附“为什么值得补”） |
| `lattice_brief` | `feature` 或 `dims` 目标、`includeEvidence=false` | 移植/重建指南 Markdown（M4） |
| `lattice_lint` | `fix=false`、`severity?` | 问题清单（重复 / 过期 / 冲突 / 孤立 / 缺证据），M4 起可 `fix` 安全项 |
| `lattice_stats` | `groupBy: feature\|dim\|status` | 计数与覆盖率（M4） |
| `lattice_export` | `format: json\|skill\|agents`、`ids?/feature?/kind?/status?` | 导出内容（M5） |
| `lattice_import` | `data`、`dry_run=true` | 导入合并预览 / 结果（M5） |

实现说明：全部用 `defineTool` 声明参数与 `output.render`（Markdown 表格 / 清单），返回结构化 JSON 供其他工具链使用。

---

## 5. 上下文注入

### 5.1 常驻段（每次会话，默认开启）

```
【Lattice】当前工作区画像：game=minecraft, mcver=1.21.1, loader=neoforge, mod=examplemod（来源：gradle.properties / build.gradle）
相关经验（按环境相关度排序，最多 8 条）：
1. [verified] 1.21.1 NeoForge 矿物生成：用 BiomeModifier + Codec…（ore-gen/1.21.1-neoforge）
2. [draft] NeoForge 注册 API 变更速查…（api-registration/1.21）
…
用法：需要更多用 lattice_search / lattice_get；写新经验用 lattice_record；跨版本对照用 lattice_matrix。
```

- 预算：`maxTokens` 默认 1500（上限 2000）；超限截断最近条目并显式提示“已截断”；
- 稳定排序：同一画像下顺序固定，避免每轮抖动破坏 KV cache；
- 刷新时机：画像变化、条目增删改（hash 变化）、显式调用 `lattice_search` 后的下一轮；否则复用缓存内容。

### 5.2 主动注入（M4，实验性）

- 通过 `tools/pre-execute` 观察 `edit` / `write` 的目标路径；
- 匹配条目 `applies_when.files` / `symbols`，命中则 `agent.inject()` 一条 300–400 tokens 的“该文件相关经验”（每 agent 每条最多注入一次，同一工具调用最多 2 条）；
- 若事件不提供路径或字段，静默跳过，绝不报错阻塞工具调用；
- 开关 `inject.proactive: false` 默认关闭，验证收益后再默认开。

---

## 6. 写入与质量闭环

```
写代码/踩坑 ──▶ record（draft，evidence 必填）──▶ verify（人工确认）──▶ verified
                       │                                   │
                       ├─ 相似去重 → 建议合并 / supersede    ├─ 下次 search / 注入自动召回
                       ├─ 密钥扫描 → 拒绝                    └─ 90 天未更新 → 检索降权
                       └─ 未知维度 → 提示补全
```

| 规则 | 默认行为 |
| --- | --- |
| draft 参与注入 | 否（只在 search 中以 ◐ 出现） |
| evidence 必填 | 是（`record.requireEvidence: false` 可关） |
| 相似去重 | 同 feature + 维度重合 ≥ 60% + 正文 shingle Jaccard ≥ 0.85 → 拒绝并给合并建议 |
| 过期降级 | `verified_on` 超过 180 天 → 运行时标记 stale（不回写文件，避免 git 抖动） |
| 冲突检测 | 同 feature 同维度组合、多条 verified 且 summary 指纹不同 → lint 报“可能冲突” |
| 密钥扫描 | 正文与 evidence 扫描常见 token 模式（`sk-`、`ghp_`、`AKIA`、私钥头），命中拒绝写入 |
| 只读共享 | `store.readOnly: true` 时 record/verify 返回明确错误 |
| 事务性 | 写入先落临时文件，校验通过后 rename；索引更新失败不影响条目文件 |

---

## 7. 典型工作流（验证设计是否成立）

### 7.1 MC 版本移植（最初动机）
1. 切到 `1.21.1-neoforge` 分支 → 画像自动识别 `mcver=1.21.1, loader=neoforge`；
2. `lattice_gaps({ feature: "ore-generation" })` → 发现 1.21.1 × neoforge 是缺口；
3. `lattice_brief({ feature: "ore-generation" })` → 拿到 1.20.1 forge 的实现摘要 + 已知坑；
4. 实现 → `lattice_record` → `lattice_verify`；
5. 下次在 fabric 分支做同一功能，直接搜到两种实现 + 缺口标记。

### 7.2 Node 多 major 库（证明通用性）
- `node-package` 预设读 `engines.node` → 画像 `runtime=node20`；
- 条目 dims `{ runtime: "node20", package: "my-lib" }`；matrix 轴用 `runtime × kind` 或 `runtime × feature`；
- 从 node18 升级到 node20 时 `lattice_brief` 列出“fetch 行为变化、test runner 差异”等已验证坑。

### 7.3 跨平台产品
- 条目 dims `{ platform: ios, sdk: "swift-5.9" }`，matrix 看 `platform × feature` 缺口。

### 7.4 团队共享
- 库根指向私有 git 仓库；成员各机 `store.roots` 指向同一路径或各自 clone + 定期 merge；`readOnly` 用于 CI / 只读共享盘。

---

## 8. 配置项（`config:` in `cordis.patch.yml`）

```yaml
- id: lattice
  name: '@your-scope/dsh-lattice-memory'
  config:
    store:
      roots: []                    # [] => 使用首启引导选定的库根（§14）；显式配置则优先、忽略引导结果
      workspaceOverlay: false      # 已拍板关闭；保留开关但默认关、不写文档
      readOnly: false
    detect:
      enabled: true
      preset: auto                 # auto | minecraft-mod | node-package | python | rust | android | gradle-jvm | generic
      overrides: {}                # { 'F:\proj\legacy-*': { mcver: '1.20.1', loader: forge } }
      extractors: []               # 自定义抽取器，见下
      cacheSeconds: 300
    dims: {}                       # 自定义维度定义（label / description / 示例）
    presets: {}                    # 自定义预设（覆盖内置）
    inject:
      enabled: true
      topK: 8
      maxTokens: 1500
      proactive: false             # M4
    record:
      requireEvidence: true
      defaultScope: library
      similarityThreshold: 0.85
    verify:
      staleDays: 180
    lint:
      secretScan: true
      similarThreshold: 0.85
    matrix:
      defaultRow: auto             # auto → 预设提供的轴
      defaultCol: auto
```

自定义 extractor 示例（不用写代码就能扩维度）：

```yaml
extractors:
  - name: pyproject-version
    file: pyproject.toml
    type: regex
    dims:
      runtime: 'requires-python\s*=\s*".*?>=\s*(\d+\.\d+)"'
  - name: engines
    file: package.json
    type: json
    dims:
      runtime: engines.node      # JSON 路径，值支持 ">=18 <21"
```

配置校验失败在插件加载期显式报错（不静默兜底），错误信息指出字段与期望类型。

---

## 9. 架构与工程结构

```
dsh-lattice-memory/
├── PLAN.md
├── package.json                 # "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
├── cordis.patch.yml             # 加载行 + 默认 config
├── tsconfig.json
├── src/
│   ├── index.ts                 # apply(ctx)：装配各模块
│   ├── config.ts                # schemastery Config
│   ├── detect/
│   │   ├── presets/             # minecraft-mod.ts / node-package.ts / ...
│   │   ├── extractors.ts        # regex / json 抽取
│   │   └── profile.ts           # 优先级合并、缓存
│   ├── store/
│   │   ├── frontmatter.ts       # YAML 解析 + 校验 + 原子写
│   │   ├── library.ts           # 多根条目读写
│   │   └── projects.ts          # projects.json 覆盖
│   ├── index/
│   │   ├── tokenize.ts          # camelCase / snake_case / CJK bigram
│   │   ├── bm25.ts
│   │   └── build.ts             # 增量索引
│   ├── retrieve.ts              # 过滤 + 排序 + 跨环境标注
│   ├── tools/                   # 每个 lattice_* 一个文件
│   ├── prompt.ts                # 常驻段渲染与缓存
│   ├── inject.ts                # M4 主动注入
│   └── lint.ts
├── test/
│   ├── fixtures/
│   │   ├── mc-1.20.1-forge/     # gradle.properties + mods.toml
│   │   ├── mc-1.21.1-neoforge/
│   │   ├── node-18/             # package.json
│   │   └── node-20/
│   ├── golden/                  # 检索用例与期望结果
│   └── *.test.ts
└── examples/
    └── library/                 # 可直接拷贝的示例记忆库（6–10 条）
```

依赖：`@deepseek-ai/dsh-tools`、Cordis 提供的宿主 API；MVP 零外部依赖（YAML 解析用现成轻量库或自带子集解析器，避免 SQLite / 向量库）。

---

## 10. 里程碑与验收

| 阶段 | 交付 | 估算 | 验收标准 |
| --- | --- | --- | --- |
| **M0 骨架** | bundle 包、Config 加载、**首启引导（选库根弹窗 + `lattice_setup` 兜底）**、`lattice_profile` + `lattice_search` 桩、提示段、README/LICENSE | 2–3 天 | `install_bundle` 成功；首启卡片弹出、选目录后写入 `root.json` 并生效；无目录选择器时降级可用；重启保留；非法 config 加载报错 |
| **M1 存储+检索+画像** | 条目 frontmatter 模型、分词+BM25、`search/get/list`、维度过滤、自测与示例 | 4–6 天 | 条目往返不丢字段；CJK/驼峰分词正确；golden 检索集 top-3 命中 ≥ 80%；`mode=strict` 排除跨版本、`prefer` 标 `applicable=false` |
| **M2 注入+矩阵+overlay** | 常驻索引注入（≤1500 tokens，顺序稳定）、`brief` 摘要、`matrix`/`gaps` 工具、项目 overlay（`<workspace>/.lattice` 覆盖共享库） | 4–6 天 | 注入段 ≤1500 tokens 且仅注入匹配维度的条目；matrix 正确标出各维度组合的条目数与最佳状态；gaps 能与 brief 的 coverage gap 呼应；overlay 同 id 覆盖生效 |
| **M3 写入闭环** | `record`/`verify`、相似去重、密钥扫描、stale 判定、lint/stats | 4–5 天 | 重复条目被拒并给合并建议；含密钥被拒；verify 后排序上升；stale 条目自动降权 |
| **M4 通用性** | `projects.json` 工作区覆盖（绝对路径前缀 / 相对目录名）、条目读取缓存（mtime+size 指纹失效）、多预设自测（minecraft-mod / python / node-package / rust / generic） | 1–2 天 | 覆盖写入后 `lattice_profile` 显示 `source: projects.json` 且 dims 被替换；缓存命中时注入段不重复解析文件，编辑条目后立即反映；非 MC 预设检测正确 |
| **M5 导出/导入 + 设置面板** | `lattice_export`（JSON / SKILL.md / AGENTS.md 片段，可过滤）、`lattice_import`（合并计划 + dry-run 差异预览）、设置界面面板（`settings.section`：浏览 / 检索 / 矩阵网格 / 导出导入） | 3–5 天 | 三种导出产物格式正确；导入 dry-run 能区分新增/id 冲突/近似重复/凭证/非法；面板在设置页可见并完成检索、矩阵、导出、导入 |
| **M6 半自动捕获** | 监听 `tools/result`：工具失败→同一 agent 重试成功 → 候选队列（`<stateDir>/captures.json`）、常驻提示提醒、`lattice_capture` list/accept/discard、`capture.enabled/mode(notify\|draft)/maxPending` | 2–3 天 | 失败+重试能生成候选且不写库；accept 走与 record 相同的密钥/近重复/readOnly 校验并落成 draft；discard 不写库；候选项有上限与去重合并；`lattice_*` 自身工具不参与捕获 |
| **M7 全自动捕获** | `session/event` 监听：人类纠正（`user/message` + `source.kind === "user"`）挂到未恢复的工具失败；`turn/end` 收敛失败链 → 候选；`capture.mode` 增加 `auto`；`detectUserCorrections` / `incidentMinutes` | 2–3 天 | 用户说"不对/应该…"后改对 → 生成带纠正引用的候选；未被纠正也未恢复的失败被丢弃；会话隔离；`mode=auto` 直接落 draft；`notify` 仍不自动写库 |

**MVP = M0–M3，约 2–3 周（单人，熟悉 Cordis 可 1.5 周）**；M4 的第二个预设是“通用性”的硬验收，建议不跳过。

**进度**：M0 ✅（2026-11-02 实测）；M1 ✅（2026-11-02 实测）；M2 ✅（2026-11-02 实测）；M3 ✅（2026-11-02 实测）；M4 ✅（2026-11-02 实测）；M5 ✅（2026-11-02 实测）；M6 ✅（2026-11-02 实测）；M7 ✅（2026-11-02 实测，含跨轮纠正修复）。**公开发布暂缓**（用户 2026-11-02 拍板：先完善功能与体验，不发布到市场；仓库推送仍按 M0 交付说明由用户执行）。

---

## 11. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 用户不填维度 → 矩阵退化 | `record` 只要求 title/feature/body/evidence；dims 缺省自动取画像；lint 提示补全但不禁写 |
| 检索质量差（词面漏语义） | 字段加权 + feature 硬聚合 + 维度降权标注；预留 embedding 适配层；golden 用例随功能迭代回归 |
| 注入挤占上下文 | 默认 ≤1500 tokens；只注摘要；正文按需 `get`；稳定排序；主动注入默认关 |
| 画像误判（升级后旧文件残留） | 来源可追溯 + override 优先级最高 + 分支名兜底；注入段展示来源 |
| 记忆库演进/污染 | evidence 必填、去重、stale、只读模式、git review、密钥扫描 |
| `tools/pre-execute` 行为不达预期 | 主动注入设计为可关、失败静默；M4 先做实验开关，收益不佳就砍 |
| 与通用记忆插件功能重叠被误解 | README 明确「结构化经验层」定位与分工；提示段不与 dsh-memory 争预算 |
| DSH 升级破坏插件 | 只依赖 `defineTool` / `ctx.tools.register` / `ctx.systemPrompt.section` / Config 等稳定面；所有可调值走 Config |

---

## 12. 与 DSH 现有能力的分工

- **compaction**：会话内压缩，管“单次会话太长”——不重复；
- **session-search**：翻旧会话，管“原始对话检索”——Lattice 存的是**人工确认过的结构化结论**；
- **skills / AGENTS.md**：Lattice 是“可导出”的兜底通道（`export`），两条通道互补；
- **workspace 长期记忆**：Lattice 把“跨工作区”的记忆从会话临时状态提升为独立、可共享、可版本化的仓库；
- **通用 memory 插件（dsh-memory 类）**：Lattice 不存自由记忆，只存带维度与证据的经验条目；两者可并存。

---

## 13. 已拍板（2026-11-01）

| # | 决策项 | 结论 | 落点 |
| --- | --- | --- | --- |
| 1 | 库根 | **首次运行弹窗让用户自己选**（公开版体验），不写死默认路径 | §14 首启引导；§4.1 库根结构 |
| 2 | 项目层 overlay（`<workspace>/.lattice`） | **关闭**（默认 false，不宣传） | §4.1、§8 |
| 3 | MVP 范围 | **M0–M3**（2–3 周）；M4 通用性验证紧接其后 | §10 里程碑 |
| 4 | 发布目标 | ~~公开发布~~ → **暂缓**（2026-11-02 更新：先完善功能与体验，不发布到市场；导出/导入/面板优先） | §10 M5、附录 E |
| 5 | 项目仓库 | `https://github.com/19136644525lxy/dsh-lattice-memory.git` | 页首、§14.5 |

> 关于 `$DSH_HOME/lattice`：它不再作为默认库根，只保留为**插件状态目录**（存 `root.json` 等），记忆库本体放在用户所选目录，天然可 git、可云盘、可共享。

---

## 14. 首启引导：选择库根（公开版核心体验）

目标：**安装插件后第一次打开会话，弹一个引导卡片/对话框，用户点「选择文件夹…」，弹系统目录选择框，选好后立即生效**；全程不要求用户手改 YAML。

### 14.1 触发条件

插件加载时按顺序解析库根（`resolveRoot()`）：

1. Config `store.roots` 非空 → 用配置值（用户显式覆盖，跳过引导）；
2. `$DSH_HOME/lattice/root.json` 存在且路径可写 → 用该路径；
3. 都没有 → **进入首启引导状态**：本会话工具处于「只读/待配置」模式，注入段提示「先完成 1 步设置」，并打开引导 UI（每个 profile 只弹一次，`onboarding.json` 记住；可手动重开）。

### 14.2 引导 UI（client 侧）

- 形式：会话主区浮层卡片（不阻塞输入），标题「Lattice · 选择你的记忆库位置」，正文说明「经验库会以普通 Markdown 文件存在你选的目录里，可随时迁移/共享/git 管理」；
- 按钮：**[选择文件夹…]** · **[使用默认位置]**（兜底：`$DSH_HOME/lattice`）· **[稍后]**；
- 点击「选择文件夹…」→ 调 DSH 现成目录选择器（见 14.3）→ 选中绝对路径后显示路径 + 「可写」检测结果 → **[使用此文件夹]** 确认；
- 失败态：路径不可写 / 无权限 / 路径不存在 → 行内报错并保留重试按钮；取消选择 → 留在卡片，不报错。

### 14.3 目录选择器实现（基于 DSH 现成 seam，不自己造轮子）

- Host 侧已有抽象服务 `ctx.directoryPicker`（`@deepseek-ai/dsh-host-directory-picker`），capability 两种：
  - `native`：弹系统原生选择框（Windows IFileOpenDialog / macOS NSOpenPanel / Linux Zenity/KDialog）；
  - `browse`：应用内单层浏览 + 新建目录（远程 / 无 GUI 时可用）。
- Client 侧经 `ctx.remote.directoryPicker` 的 wire verbs 访问：`directoryPicker/pick`（返回 `string | null`）、`directoryPicker/list`、`directoryPicker/createDirectory`；DSH 自己的「添加工作区」流程就走 `ctx.uiWorkspace.pickDirectory()`。
- Lattice 客户端引导组件优先调用 **`ctx.uiWorkspace.pickDirectory()`**（拿到绝对路径，`null`=取消）；不可注入时退回 `ctx.remote.directoryPicker.pick()`；再不可用则用 `list/createDirectory` 做应用内浏览选择器。
- **M0 必须实测**：client 插件上下文能否获取 `uiWorkspace` / `remote.directoryPicker`；不行就走降级链，最底兜底是工具参数 `lattice_setup(root)` + 提示手填路径。

### 14.4 选定之后的动作

1. 校验：路径存在（或可创建）、可写、不是系统目录、库结构合法（`entries/` 不存在则初始化）；
2. 写 `$DSH_HOME/lattice/root.json`（`{ "root": "<abs path>", "version": 1 }`），原子写 + 备份旧值；
3. 生成/加载 `.index.json`，注入段立即可用（无需重启）；
4. 「更换库根」：设置面板 + 命令 `lattice_migrate_root`（预览 + 移动/复制确认，绝不静默删旧库），写 `root.json` 后重扫索引；
5. 只换路径不搬数据时提示「旧库将不再被读取，数据仍在原处」。

### 14.5 仓库与发布

- 仓库：`https://github.com/19136644525lxy/dsh-lattice-memory.git`；本机当前网络无法访问 github.com（DNS 解析到非公网 IP），无法 clone/push —— 先在本地 `F:\温迪\dsh-lattice-memory` 内 `git init` + 提交，用户在自己网络环境推送到该仓库；
- 发布：公开到 npm（`dsh-lattice-memory`；若发布时撞名改用 scoped 包名，展示名仍为 Lattice），README 第一屏放「安装 → 首启选库根 → 第一次搜索」三步。

---

## 附录 A：实现需核对的 DSH 事实（来自本机 app.asar）

- bundle 清单：`package.json` 中 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`（行 324853、325034、325069、817305）；
- 安装：`plugin_manager` 的 `install_bundle`，`target` = 包绝对目录或 registry spec；profile 级、跨会话、重启保留（行 324795、325122）；文档明确禁止手写 profile 的 `package.json` / `cordis.patch.yml`、禁止在 `$DSH_HOME` 下建包或在 profile 里跑 pnpm（行 324905）；
- 工具：`defineTool`（`@deepseek-ai/dsh-tools`）→ `ctx.tools.register`；`output: { schema, render }`（行 794467、1945430、1672334）；
- 提示段：`ctx.systemPrompt.section({ name, text })`，`text` 可基于 `{ scope }` 动态生成（行 324930、1617560、1932667）；
- 注入：`agent.inject()`，记录为 `agent/inbox/spliced`，下一步生效（行 324930）；
- 工具观察：`tools/pre-execute` / `tools/post-execute` / `tools/result`（行 324922、324929）；
- 配置：插件导出 schemastery `Schema` Config，用户 `cordis.patch.yml` 行的 `config:` 覆盖，patch 层升级保留（行 324934、1673358）；
- 可选服务：`ctx.inject([...])`（行 324932）；
- 模板：内置 skill `cordis-plugin-development` 的 `templates/decoration`（package.json 含 `dsh.client`、cordis.patch.yml、index.js、client.js、locale、icon；client 用 `ctx.slots.inject` / `ctx.slots.register` 挂到 `conversation.composer.dock`）（行 10823–10853、324833、324953、324961）；
- 参考近亲：`dsh-compaction*`、`dsh-experimental-session-search`、`dsh-session-log-export`、`dsh-skill*`（行 104803–104906）。

## 附录 B：命名与查重

- 品牌：**Lattice**（格点 / 网格：维度组合即格点，缺格即未验证）；
- npm 包名：`dsh-lattice-memory` — 2026-11-01 查询 registry.npmjs.org 返回 404（未注册）；`lattice` 单词在 npm 上已被大量占用，故用组合名；
- 公开发布：**目标公开发布**（2026-11-01 拍板）；优先用 `dsh-lattice-memory`（2026-11-01 查询 404 可用），发布前复核一次，撞名则改用 `@<scope>/dsh-lattice-memory` 保证唯一；展示名保留 Lattice，副标「多环境经验矩阵」；
- v1 的 `ModMemory` 名称退役，仅保留为「Minecraft 预设」的示例语境。

## 附录 C：M0 落地记录（2026-11-01）

M0 已按本计划实现并写入本目录（9 个文件，均为新增）：

| 文件 | 内容 |
| --- | --- |
| `package.json` | `dsh-lattice-memory` 0.1.0；`type: module`；`exports "."` / `"./client"`；`dsh.bundle.patch`；`dsh.client.platform: "web"`；peerDeps（cordis / dsh-tools / schemastery） |
| `cordis.patch.yml` | bundle 挂载行 `- insert: - id: lattice / name: dsh-lattice-memory` |
| `src/state.js` | `DSH_HOME` / 状态目录 / `root.json`；路径校验与 `~` 展开；库标记 `.lattice-root.json`、`entries/`、`projects.json` 的幂等初始化与可写探测 |
| `src/detect.js` | 工作区画像：gradle/mod 元数据、package.json、pyproject、Cargo、Android、git 分支 → preset + dims |
| `src/index.js` | Config（root/onboarding/inject/projectOverlay/staleDays）；`lattice_setup` / `lattice_status` / `lattice_profile` / `lattice_search`（M0 桩）；`/lattice/state`、`/lattice/setup` 路由（M5 起整体迁到 `/lattice-panel/*`）；常驻提示段 |
| `src/client.js` | 手写 ModuleLoader bundle；`shell.overlay` 首启卡片（选择文件夹 → DSH 原生目录选择器 → 兜底手输；使用默认位置；稍后） |
| `README.md` / `LICENSE` / `.gitignore` | 安装、验证、配置、开发说明；MIT；忽略规则 |

验收方式（需在 DSH 内执行，本机 pwsh 不可用）：

1. `plugin_manager` 的 `install_bundle`（target = 本目录绝对路径）或 `dsh plugin --profile desktop add F:\温迪\dsh-lattice-memory`；
2. 让 agent 调 `lattice_status`，确认 `configured=false`、`state_dir`、`default_root`；
3. 刷新 Web GUI，确认首启卡片出现；分别验证「选择文件夹…」「使用默认位置」「稍后」；
4. 再次 `lattice_status` 确认 `configured=true`、`root_source=user|default`、`is_library=true`。

M0 刻意未做（后续已补）：真实检索（M1 已补）、常驻索引注入与矩阵（M2 已补）、写入闭环（M3）、导出/导入与面板（M5 已补）；公开发布暂缓。

### M0 验收结果（2026-11-02，DSH 桌面端）

- 安装：`dsh plugin --profile desktop add F:\温迪\dsh-lattice-memory` 成功；profile `package.json` 出现 `link:F:/温迪/dsh-lattice-memory`，`dsh.profile.bundles` 末尾出现该包；插件 fiber APPLIED，4 个工具进入会话。
- 排障记录：装好后首启卡片先不出现（页面仍是旧 boot graph，客户端 bundle 未加载）；补上错误上报后卡片可见但报 `HTTP 403 from /lattice/state`；**完全退出并重开 DSH 桌面端**后恢复正常。日志 `GET /lattice/state` 记录 `admitted: true`、`connection: present`，确认 403 只是重启前的旧页面残留。
- 实测通过项：
  1. 首启卡片出现在页面右下角，显示默认位置 `C:\Users\...\.dsh\lattice-library`；
  2. 「选择文件夹…」→ DSH 原生目录选择器 → 选 `F:\Lattice` → `POST /lattice/setup` 成功；
  3. 库根落盘 `~/.dsh/lattice/root.json`：`{"root":"F:\\Lattice","source":"user"}`（`config.root` 优先于此）；
  4. 库结构创建：`F:\Lattice\.lattice-root.json`（`{schema:1,name:"lattice"}`）+ `projects.json` + `entries/`；
  5. 成功后卡片显示"Lattice 已就绪"并自动消失，`configured=true`。
- 修正项：`shell.overlay` 条目默认 click-through → 卡片根元素加 `pointerEvents: "auto"`；首启路由诊断写入 `<stateDir>/route-debug.log` 改为 `config.debug` 开关（默认关）。
- 桌面端 UI 事实：`Ctrl+R` 不生效（需完全退出重开）、`Ctrl+Shift+I` 打不开 DevTools；装/改插件后必须整窗重启。

## 附录 D：M1–M2 落地记录（2026-11-02）

M1 已实现并写入本目录。相对 M1 原始计划的两处偏差：

1. **常驻注入挪到 M2**：M1 先把「条目模型 + 检索 + 读取」做扎实，注入段（阈值/排序稳定性）与 `matrix/gaps` 一起在 M2 做，避免一次改太多；
2. **检索增加维度亲和度与适用性标记**：`mode=prefer`（默认）对跨版本条目降权并标 `applicable: false`，`mode=strict` 直接排除——这是「同一功能不同版本做法不同」定位的直接落点。

| 文件 | 内容 |
| --- | --- |
| `src/frontmatter.js` | 零依赖 YAML 子集编解码（标量/映射/一层嵌套/内联与块数组/引号规则；非法形状保留为字符串） |
| `src/entries.js` | 条目模型：kind/status/confidence 枚举、`validateEntry`、`normalizeEntry`、序列化（固定字段序）、`loadEntries`（坏文件上报）、`getEntry`、`saveEntry`（overwrite 保护、原子写） |
| `src/search.js` | `tokenize`（拉丁 + CJK 二元组 + 版本 token）、`buildIndex`（字段加权）、BM25（k1=1.2, b=0.75）、`matchDimensionValue`（`*` / `1.20.x` / 区间 / 数组）、`dimensionAffinity`（strict/prefer）、`freshness`（半衰期=staleDays）、`rankEntries` |
| `src/index.js` | 新增 `lattice_get`、`lattice_list`；`lattice_search` 重写（query/feature/dims/mode/kinds/status/limit，dims 缺省自动画像）；常驻提示段改为真实检索流程 |
| `scripts/selftest.mjs` | 零依赖自测：`node scripts/selftest.mjs`，12 项断言（YAML/条目往返、分词、维度匹配、BM25、读写） |
| `examples/entries/` | 3 条示例：1.20.1 Forge / 1.21.4 NeoForge 的「药水持续时间」跨版本条目 + 一条无版本维度的通用 gotcha |
| `package.json` | 版本号保持 `0.1.0`（约定：只有用户明确要求升级时才升版本）；`files` 增加 `examples` |
| `README.md` | 重写：状态表、能力、配置、工具表、条目格式与字段表、检索说明、自测、库布局、路线图 |

**M1 验收结果（2026-11-02，DSH 桌面端实测通过）**：
1. 重启桌面端后 `lattice_status` → `configured=true is_library=true`、库根 `F:\Lattice`、6 个工具进入会话；
2. 示例条目已写入 `F:\Lattice\entries\`（3 条），`lattice_list` 正确解析 frontmatter（`dims.mcver` 保持字符串 `"1.20.1"`，未被 YAML 数字化）；
3. `lattice_search(query="药水持续时间")` → 2 条命中；
4. `lattice_search(query="药水持续时间", dims='{"mcver":"1.21.4","loader":"neoforge"}')` → NeoForge 条目 `applicable: true` score 4.30；Forge 条目 `applicable: false` score 1.72，`dim_notes` 明确列出 `mcver: 1.20.1 does not match 1.21.4` / `loader: forge does not match neoforge`；
5. 同查询 `mode=strict` → 只剩 1 条（NeoForge）；
6. `lattice_search(query="attribute 顺序", dims='{"mcver":"1.20.1","loader":"forge"}')` → 无版本维度的通用 gotcha 排第一且 `applicable: true`，版本匹配的 Forge 条目第二，NeoForge 条目 `applicable:false` 降权——通用知识 + 版本过滤组合符合预期；
7. `lattice_get(id=...)` 返回 body；`lattice_profile(path=...)` 在 node 包目录正确识别 `preset=node-package`、dims；
8. 验收中发现 `lattice_profile`/`lattice_search` 未传 path 时用的是**宿主进程 cwd**（`~/.dsh/profiles/desktop`），不是调用方 agent 的会话工作区——已改为经 `exec.agent` + `workingDirectory.ensure()` 解析真实工作区（需再次重启桌面端生效）。

未执行：`node scripts/selftest.mjs`（本机无可用 shell/Node，改由运行期实测覆盖）；该自测脚本保留给有 Node 的开发环境。

**M1 已知限制**：无 embedding（纯词面 + 维度，M4 预留适配层）；条目正文是 Markdown，检索权重只到字段级；`lattice_list` 默认最多 200 条。

### M2 落地记录（2026-11-02）

相对 M2 原始计划（当时把「注入+写入闭环」与「矩阵/缺口」拆在两段），实际执行顺序调整为：**M2 = 常驻注入 + 矩阵/缺口 + overlay**，**M3 = 写入闭环**（里程碑表已同步改写）。理由：注入、矩阵、overlay 共享同一份加载与维度亲和逻辑，一起落地成本最低；写入闭环涉及去重/密钥/状态迁移，单独一段更稳。

| 文件 | 内容 |
| --- | --- |
| `src/matrix.js`（新增） | `DIM_KEY_ORDER`（game/mcver/loader/host/platform/runtime/sdk/product/branch）、`signatureOf`、`pickDims`、`chooseKeys`（显式优先，否则按已知顺序取前 4）、`scopeByFeature`、`buildMatrix`（feature × 维度组合网格 + 每格条目数与最佳状态）、`findGaps`（feature 在当前维度无可用条目 → 缺口，并列已覆盖组合）、`STATUS_RANK` |
| `src/brief.js`（新增） | 常驻简报：`estimateTokens`（CJK 逐字、拉丁按 4 字符≈1 token）、`renderResidentLine`、`selectResident`（只取 `applicable`，同 feature ≤2 条，score = 亲和 × 状态权重 × 新鲜度）、`buildBrief`（header/footer、预算截断、coverage gap 提示） |
| `src/entries.js` | 新增 `loadEntriesFromDir`、`loadEntriesMerged(root, overlayRoot)`（overlay 同 id 覆盖）、`getEntryMerged`；`loadEntries` 保留为单根版本 |
| `src/index.js` | 提示段改为 `renderPromptSection(config, context)`：未配置时给首启提示，已配置时注入简报（`inject.enabled` 可关）；工作区从 `context.agent.session.header.cwd` 同步读取（不再依赖 `process.cwd()`）；新增 `lattice_brief`（预览注入全文 + token 估计）、`lattice_matrix`、`lattice_gaps`；`lattice_status` 输出 overlay 状态；search/get/list 统一走合并条目；`lattice_gaps`/`lattice_search` 在「工作区维度未识别」时明确提示"未过滤适用性，请显式传 dims"，不再假装全部适用 |
| `scripts/selftest.mjs` | 增加 7 项 M2 断言：chooseKeys 顺序/上限、矩阵分组与 best_status、gaps 判定、简报预算与不匹配排除、coverage gap、estimateTokens、overlay 合并与回退 |
| `README.md` / `package.json` | README 更新 M2 能力/配置/工具/注入章节/overlay/路线图；package.json description 提及 M2，版本仍 `0.1.0` |

**M2 验收（2026-11-02 重启后实测通过）**：
1. `lattice_status` 输出含 `overlay=false` ✅；
2. `lattice_brief` 输出常驻简报全文 ✅：无维度时 3/3 条、~261 tokens；`dims={"mcver":"1.20.1","loader":"forge"}` 时 2/3 条、~212 tokens，Forge 条目 + 通用 gotcha 入选、NeoForge 条目被排除（`applicable:false` 不入简报）✅；
3. `lattice_matrix(feature="药水持续时间", keys="mcver,loader")` 返回 1 行 × 2 列网格 ✅（实测：`mcver=1.20.1|loader=forge → 1 (verified)`、`mcver=1.21.4|loader=neoforge → 1 (verified)`）；
4. `lattice_gaps(dims='{"mcver":"1.21.4","loader":"fabric"}')` 实测 `1/2 covered`，缺口列出「药水持续时间」并给出已覆盖组合；`dims={"mcver":"1.21.4","loader":"neoforge"}` 实测 `2/2 covered` ✅；
5. 工作区维度未识别时（空目录 `F:\温迪` → generic），`lattice_gaps` 返回"维度未识别，请显式传 dims"提示、不再假报 covered ✅；
6. `node scripts/selftest.mjs` 未运行（本机无 Node/shell；脚本保留给有 Node 的环境）。

**已知问题（实测中发现，已修）**：`lattice_gaps` 在 dims 为空对象（工作区检测不到维度）时把全部 feature 判为 covered，容易误导——已改为显式返回"维度未识别，请传 dims"；`lattice_search` 同样在 dims 为空时附加"适用性未过滤"提示。

**M2 已知限制**：注入段是每轮同步渲染（条目数大时略慢，M4 加缓存）；`projects.json` 覆盖画像尚未消费（M4）；矩阵列数默认最多 4 个维度键；gaps 不区分「完全没有条目」与「条目都存在但 status 太旧」。

### M3 落地记录（2026-11-02 已实测通过）

| 文件 | 内容 |
| --- | --- |
| `src/write.js`（新增） | 写入闭环纯函数：`SECRET_RULES`（私钥块 / AWS AKIA\|ASIA / `gh[pousr]_` / `sk-` / JWT / `password=` / `*_token=` / dsh launch token；掩码预览）、`scanSecrets`、`similarityTokens`（title+summary+feature）、`similarity`（Jaccard）、`findSimilar`、`isoDate`/`daysSince`、`staleCandidates`（仅 verified 且超过 staleDays）、`lintReport`（stale/无证据/近重复对/疑似凭证/坏文件汇总） |
| `src/index.js` | Config 新增 `readOnly`、`record.requireEvidence`（默认 true）、`lint.similarityThreshold`（默认 0.85）+ `resolveConfig` 同步；新增 `ensureWritable`/`parseEvidence`（JSON 数组或换行/分号列表）/`rejectSecrets`；新增 `lattice_record`（title/kind/feature 必填；status 仅 draft/verified；evidence 默认必填；id 缺省由 title slug 化；已存在 id / 近重复（Jaccard≥阈值）/ 疑似凭证 → 拒写）、`lattice_verify`（必须带新 evidence；合并证据、刷新 verified_on、可调 confidence；readOnly 拒绝）、`lattice_lint`（合并库+overlay 做健康检查）；`lattice_status` 增加 `read_only`；工具注册达 12 个 |
| `scripts/selftest.mjs` | 新增 4 项 M3 断言：密钥扫描与掩码、Jaccard 相似/近似查重、stale 判定、lintReport（stale/无证据/重复/notes） |
| `README.md` | 版本状态表 M3 行、当前能力（写入闭环）、配置（readOnly/record/lint）、工具表三件套、新增「写入闭环」章节（record→verify→lint 流程与安全阀）、自测覆盖、文件分工加 `write.js`、路线图 |

**M3 验收（2026-11-02 重启后实测，全部通过）**：
1. `lattice_status` 显示 `read_only=false`，12 个工具就位。
2. `lattice_record` 录中文标题 draft（显式 id `dsh-desktop-restart-required`）→ 落盘 `F:\Lattice\entries\dsh-desktop-restart-required.md`，提示"draft stored"。
3. 同内容换 id 再录 → 被拒：`refused as a near-duplicate of dsh-desktop-restart-required (1)`。
4. `lattice_verify(id=..., evidence=...)` → `draft -> verified (low, verified 2026-11-02, 3 evidence item(s))`。
5. 含 `AKIA…` 的 record → 被拒：`refused to store credential-like content (aws-access-key)`。
6. `lattice_lint` → `4 entries, 0 invalid file(s)`，无 finding；`lattice_brief` 显示 4/4 条目、~300 tokens，新 verified 条目进入常驻索引。
7. 顺带修掉一个可用性问题：中文标题自动 id 曾生成非法 slug（`dsh-桌面端…`）→ 现在非法时回退 `feature-kind-标题哈希`，并在错误信息里提示显式传 `id`。

**设计取舍**：record 只写共享库（不写 overlay，避免"项目私有记忆"被误认为共享）；draft 不进常驻注入，只有 verified 才进注入与 `applicable: true`；近似重复「拒写」而非自动合并，把合并决策留给作者（lint 给出重复对）；verify 从不改 body，只动状态/证据/日期。
**M3 已知限制（记录在此，M4 再说）**：supersedes 目前只是元数据，不会自动把旧条目降为 superseded；无 embedding 去重（纯 Jaccard）；stale 只是报告，不自动降权写入；`lattice_lint` 全库两两比对，条目数很大时是 O(n²)。

### M4 落地记录（2026-11-02 已实测通过）

| 文件 | 内容 |
| --- | --- |
| `src/projects.js`（新增） | `readProjects(root)`（读 `<root>/projects.json` 的 `projects` 映射，坏文件归零）、`normalizePathKey`（反斜杠→斜杠、去尾斜杠、小写）、`matchProject(projects, workspace)`：绝对键命中"工作区本身或子目录"并按最长前缀胜；相对键按路径目录名匹配；返回 `{key, preset, dims}` |
| `src/entries.js` | `loadEntriesFromDir` 增加模块级缓存：指纹 = Markdown 文件数 + 最新 mtimeMs/size，命中直接复用结果；新增/编辑（mtime 变）或删除（数量变）立即失效；`loadEntries`/`loadEntriesMerged`/`getEntryMerged` 自动受益 |
| `src/index.js` | 新增 `detectForWorkspace(config, workspace)`：检测后套 `projects.json` 覆盖（preset 覆盖、dims 逐键合并），返回 `source: detected|projects.json`；`lattice_profile` 输出新增 `source` 且 render 显示；常驻提示段、`lattice_search`/`lattice_brief`/`lattice_gaps` 的 dims 检测统一走它（`dims_source` 为 `projects:<preset>` 或 `workspace:<preset>`） |
| `scripts/selftest.mjs` | 新增 3 项断言：缓存命中/失效（新增文件、编辑内容）、预设检测（minecraft-mod / python / node-package / rust / generic）、`projects.json` 覆盖匹配（绝对 vs 相对、最长前缀胜） |
| `README.md` | 版本状态 M4 行、当前能力（工作区覆盖 / 读取缓存）、新增「工作区覆盖（projects.json）」章节、自测覆盖、文件分工加 `projects.js`、库布局注释更新、路线图 |
| `package.json` | description 补 M4；version 保持 0.1.0 |

**M4 验收（2026-11-02 重启后实测，全部通过）**：
1. `lattice_profile(path=F:\温迪\dsh-lattice-memory)` → `preset=node-package`、`source: detected`，signals 只有 package.json。
2. 往 `F:\Lattice\projects.json` 写入 `F:\温迪` 覆盖（dims.product=windy-workspace）后，`lattice_profile`（无参数）→ `source: projects.json`，dims.product 被替换为 `windy-workspace`，signals 含 `projects.json`。
3. `lattice_brief` → `dims_source: projects:node-package`，header 显示覆盖后的维度。
4. 写入/提升条目后 `lattice_brief` 立即从 4/4 变 5/5 且含新条目 → 缓存失效正确。
5. 删除覆盖后 `lattice_profile` 回到 `source: detected`、`preset=generic`（空工作区）。
6. `lattice_lint` → `5 entries, 0 invalid file(s)`，无 finding。

**设计取舍**：`projects.json` 只影响"当前工作区用什么维度"，不改写条目本身；覆盖是"显式优先"，因此项目作者可以钉死错误检测；缓存用廉价指纹而不是文件监听（无 watcher 依赖、跨平台一致），代价是每次注入多几次 `stat`，在几百条目规模可忽略；非 MC 预设靠内置 detect 覆盖（node/python/rust/android/gradle-jvm），自定义 extractor 按需再加。

---

## 附录 E：M5 落地记录（2026-11-02，待重启实测）

**范围调整**：按用户 2026-11-02 拍板，M5 不做 npm/market 公开发布，改为把「导出 / 导入 / 设置界面面板」三件事做完（原计划里的发布流程移到"暂缓"）。

| 文件 | 内容 |
| --- | --- |
| `src/portable.js`（新增） | `EXPORT_SCHEMA="lattice-export/1"`；`filterEntries`；`entryToPortable` / `portableToEntry`；`exportJson` / `exportSkill` / `exportAgents`；`parseImportPayload`（对象 / JSON 串 / 裸数组）；`planImport`（新增 / `id-exists` / `credentials` / `near-duplicate` / problems）；`applyImport` |
| `src/background.js`（新增） | 面板背景图存取：`readBackgroundMeta` / `readBackgroundBytes` / `saveBackgroundDataUrl`（只接受 `data:image/(png\|jpeg\|webp\|gif\|bmp);base64,…`，≤8MB）/ `clearBackground`；落盘 `<stateDir>/background.bin` + `background.json`，`BACKGROUND_LIMITS.bodyLimit = 12MB`；因为桌面端每次启动端口会变（页面 origin 变），存 host 侧才能跨重启保留 |
| `src/index.js` | 工具 `lattice_export`、`lattice_import`；14 个工具注册；面板与首启接口注册为**单条 prefix 路由** `/lattice-panel/*`（`version/state/setup/entries/entry/matrix/export/import`），由 `route` handler 分发并整体 try/catch → 500 JSON；旧 `/lattice/*` 精确路由改名 `mountRoutesLegacy` 不再调用（M5.1 清理）；`entryView` / `panelWorkspace` 助手 |
| `src/client.js` | 保留首启卡片；`LatticePanel` 同时注册到 `settings.section`（label「Lattice 记忆」，order 120）与**对话页头部** `conversation.session.header.utilities`（按钮「记忆库」→ **全屏覆盖层** `shell.overlay` 条目 `lattice-drawer`：`position:fixed; inset:0`，遮住工作区，Esc/右上角「关闭」返回）；不用主题的 `--dsw-alias-bg-*` token 作全屏底色（壁纸插件把 `--dsw-alias-bg-base` 置 transparent、皮肤主题 layer token 带 alpha，会透出工作区）；**背景 = 壁纸透传 + 压暗层**：`pageBackground()` 从壁纸插件的 `.we-layer .we-media`（img 的 `currentSrc` / video 的 `poster`）或 `.we-live-poster` 的 `background-image` 取壁纸 URL，铺 `cover` 再叠 scrim（深色 rgba(8,10,14,.74) / 浅色 rgba(248,250,253,.82)），取不到才退回实色 `opaquePage()`（`pageIsDark()` 读 `body[data-ds-dark-theme]`，深色 `#0f1115` / 浅色 `#f6f7fb`）；取不到壁纸时用宿主保存的本地图片（`src/background.js` + `GET /lattice-panel/background`，面板头部「背景图」上传/清除，优先级：壁纸插件 → 本地图片 → 实色）；顶部 `padding-top: 68px` 避开桌面端窗口按钮与应用菜单；三个 tab：浏览/检索、矩阵（**3D 神经网络视图**：手写透视投影 + SVG 连线，feature 环与维度组合环在 3D 空间连线，拖拽旋转（带惯性）/ 滚轮缩放 / 悬停高亮，贝塞尔曲线边、线宽=条目数、颜色=最佳状态、虚线=缺口；增强视觉：球体径向渐变 + 高光、节点辉光、背景星点、双环轨道虚线、沿实线流动的脉冲光点、深度排序与景深透明；**矩阵 tab 激活时进入 fullBleed 布局**：面板 `display:flex` 撑满抽屉、隐藏副标题/state 行/背景图行、画布 `flex:1` 铺满剩余高度，`ResizeObserver` 把画布实际像素写入 `size` state 作为投影坐标系 `W/H`（随窗口实时变化，`K=min(W,H)*0.56` 自适应））、导出导入（复制 + 预检/写入）；自绘 inline SVG 图标与状态徽标；启动先 `GET /lattice-panel/version` 自检，失败显示宿主未响应提示 |

**路由排障（2026-11-02 追加）**：重启后 `/lattice-panel/*` 仍 404/405，判定为宿主侧路由未生效。`src/index.js` 增加 `bootLog()`（写入 `$DSH_HOME/lattice/boot.log`：`apply: start`、`panel: registered prefix …`、`apply: ready`、异常栈）与 `mountPanelRoutes` 双通道：优先 `resolveWebServer`（`ctx.get("webServer") ?? ctx.webServer`）直接注册，失败再回落 `ctx.inject(["webServer"])`；两种路径各写一条 boot 日志，供下次重启判读。

**面板收尾（2026-11-02 追加）**：新增「捕获」tab（`/lattice-panel/captures`，候选列表 + 接受为 draft / 丢弃）；新增「清除记忆库」危险操作（浏览 tab 底部红色区块 → 30 秒倒计时警告弹窗，取消即中止；`POST /lattice-panel/clear` 要求 `confirm: true`，`readOnly` 时 409；宿主删除库内全部 `entries/*.md` 并调用 `clearEntriesCache()` 让下一轮读取立即生效；保留库目录与 `projects.json`，不影响 capture 队列）。

**M8 备份与矩阵缩放（2026-11-02 追加）**：新增 `src/backup.js`——备份 = 库根目录快照到 `<backup.dir>/lattice-YYYYMMDD-HHmmss[-<自定义名称>]/`（复制 `entries/*.md`、`projects.json`、`.lattice-root.json`，写 `manifest.json` 记录来源、名称与条目 id 列表），按 `backup.keep`（默认 10）保留最新 N 份并清理更旧的；`backup.dir` 为空时默认到**插件安装位置旁边的 `backups/`**：`defaultBackupDir()` 用 `pluginInstallDir()` 在 `<DSH_HOME>/profiles/*/node_modules/dsh-lattice-memory`（含 `link:` 符号链接）中定位插件实际安装的 profile，返回 `<profile>/backups`；找不到时回退 `$DSH_HOME/lattice/backups`。**注意不要跟随 link 的实体路径**：DSH 用 `link:` 安装时插件包目录就是用户的项目 checkout，备份写那里会污染项目；相对路径仍相对插件根解析。面板接口 `GET/POST /lattice-panel/backup`（GET 返回默认目录、当前目录、最近备份列表；POST `{dir?, keep?, name?}` 立即备份，`readOnly` 不影响——备份是只读操作）。**恢复备份**：`POST /lattice-panel/restore` `{name}`——从选中的备份把 `entries/*.md` 覆盖回库、恢复 `projects.json`/`.lattice-root.json`，清条目缓存；只覆盖同名文件，不删除备份后新增的条目；`readOnly=true` 时 409。**目录选择**：`POST /lattice-panel/pick-directory` 由宿主解析 `ctx.get("directoryPicker")` 的 capability，native 时直接弹系统目录选择器并返回路径（browse-only 或取不到时返回空串，client 再回退到 `ctx.uiWorkspace.pickDirectory()` / `ctx.remote.directoryPicker.pick()`）。浏览 tab 顶部新增「备份记忆库」行（目录输入 + 选择文件夹 + 用默认（点击后把默认目录直接填进输入框，而不是清空）+ 自定义名称 + 立即备份 + 备份总数与下拉选择 + 恢复所选备份…带确认框）。矩阵 3D 视图新增「＋/－」缩放按钮，与滚轮共用 `dist` 限位 1.2–9。**滚轮缩放修复（2026-11-02 追加）**：3D 场景在数据加载前不渲染（`matrixRows.length === 0` 时显示空状态），而滚轮监听 effect 的依赖只有 `[]`，首次挂载时 `wrapRef.current` 还是 null，导致监听器永远没绑上；现改为把监听器挂在始终存在的 wrapper 上并把 `data` 加入依赖，数据到达后自动重绑，滚轮与按钮都生效。

**面板收尾 ②（2026-11-02 追加）**：`GET /backup` 新增 `packageDir`（`pluginPackageDir()` = `realpath(<profile>/node_modules/dsh-lattice-memory)`），面板把「插件安装位置」与「插件包实体」分开显示——`link:` 安装时实体路径就是用户项目 checkout，只展示、不作默认备份目录；新增 `POST /lattice-panel/compose`（标题/feature 必填，kind 默认 note，id 由标题 slug 或 `memory-<时间>` 生成，走 `normalizeEntry` + `rejectSecrets` + id 冲突 + 近似重复校验，`saveEntry` 后 `clearEntriesCache()`），「导出/导入」tab 底部新增「写一条记忆」表单；`PANEL_ENDPOINTS` 加 `compose` 并按新增接口顺序更新。
| `scripts/selftest.mjs` | 新增 portable 断言（三种导出产物、roundtrip 导入、id 冲突、近重复、凭证、非法记录） |

**设计取舍**
- 导出只读共享库、不含 overlay：项目本地经验不外流；导入只写共享库，避免把别人的 overlay 混进来。
- 导入默认 `dry_run` 且永不覆盖已有 id：导入失败可预期，冲突显式列出而不是静默跳过或覆盖。
- SKILL.md 用 YAML frontmatter（`name: lattice-memory`）+ 按 feature 分节，能被 skills 扫描根直接加载；AGENTS.md 输出纯 Markdown 片段，便于粘贴进没有 Lattice 的环境。
- 面板数据走同源 HTTP 路由复用宿主栅栏，而不是另起 IPC 通道；因此桌面端与 web 端行为一致，且不需要额外信任配置。
- 面板主入口放在对话页头部（`conversation.session.header.utilities`）浮层抽屉：随时可开、不打断对话；设置页分节保留作为第二入口（用户 2026-11-02 要求把入口从设置里挪出来）。

**已知限制**
- 面板检索/矩阵用宿主进程工作区（无参数时 `process.cwd()` → DSH 安装目录），想看某项目的维度需从该项目的会话里调用工具；面板暂不支持指定工作区路径。
- 导入的 session-search 候选（原计划）未做，只支持 Lattice JSON；`lattice_export` 不写文件，内容由调用方自己保存（面板提供复制）。
- 面板未做虚拟滚动，条目上千时浏览列表会变慢（检索与矩阵是分页/聚合的，不受影响）。


**M4 已知限制**：缓存键不含文件内容哈希（极端情况下同 size 同 mtime 的改写可能漏检，概率可忽略）；`projects.json` 尚无 UI 编辑入口；缓存不跨进程共享（每次 DSH 启动重建，符合预期）。

## 附录 F：M6 落地记录（2026-11-02，待重启实测）

| 文件 | 内容 |
| --- | --- |
| `src/capture.js`（新增） | `CAPTURE_LIMITS`（`maxPending=5`、`errorChars=320`、`forgetAfterMs=30min`）；候选队列 `<stateDir>/captures.json`：`readCaptureQueue` / `writeCaptureQueue`（tmp+rename 原子写）/ `listCandidates` / `findCandidate` / `addCandidate`（同工具+同首行错误合并计数，超 `maxPending` 丢最旧）/ `removeCandidates`；`errorStem`（首行错误，用于标题/摘要/去重）、`extractErrorText`（content 文本块 / value / error.message）；`createCaptureTracker({forgetAfterMs})` 只观察 `(exec, result, now)`：失败记入 `agent::tool`，同 agent 同工具成功后返回 `{tool, errorText, failedAt, recoveredAt}`，`lattice_*` 工具与其它 agent 不配对，超时失败自动遗忘；`buildCandidate({hit,dims,workspace,now})` 生成 gotcha 候选（中文标题「自动捕获：<tool> 先失败、后成功（待补充修复步骤）」，body 含失败原文 + 待补充 + 验收口径，evidence 写 `run:<tool>` 和 `file:<workspace>`） |
| `src/index.js` | Config 新增 `capture.enabled`（默认 true）/ `capture.mode`（`notify` 默认 / `draft`）/ `capture.maxPending`；`resolveConfig` 同步；`storeCandidate(config, candidate, overrides)`（readOnly 拒绝、密钥扫描、id 冲突、Jaccard 近重复拒写、落 draft+low，id 形如 `capture-<suffix>`）；`captureTool`（`lattice_capture`：action=list/accept/discard、id/all、可覆盖 title/kind/feature/summary/body/evidence/dims/tags，accept 返回写入文件列表）；`attachCapture(ctx, config)` 用 `ctx.effect(() => ctx.on("tools/result", onResult))` 挂监听，失败→重试成功后按 `capture.mode` 直接写 draft 或入队，整体 try/catch 保证绝不打断工具执行；`renderPromptSection` 在队列非空时追加一行待确认提醒；15 个工具注册 |
| `scripts/selftest.mjs` | 新增 capture 断言：失败+同 agent 重试成功配对、`errorStem`、`buildCandidate` 字段（kind/feature/dims/evidence/title/body）、跨 agent 不配对、`lattice_*` 不捕获、超时遗忘 |
| `README.md` / `PLAN.md` | 进度、工具表、配置项、新增「半自动捕获（M6）」章节、文件分工、路线图与本事录 |

**设计取舍**
- 只做"失败→重试成功"这一种可验证信号：它能证明"某条路不通、后来走通了"，但无法自动知道修好的是什么，所以候选正文明确写"待补充"，强制模型改写后再 `verify`。
- 默认 `notify` 而不是 `draft`：自动写库容易产生错误结论与噪音；用户 2026-11-02 明确要求先做半自动。
- 候选队列落 `<stateDir>` 而不是库根：队列是插件运行状态，不属于记忆库内容；库导出/分享不会带上未确认候选。
- accept 复用 `lattice_record` 的校验路径（readOnly / 密钥 / id 冲突 / 近重复），避免第二条写入通道绕过安全阀。

**已知限制**：只能识别工具级失败（模型推理走错路但工具都成功的情况捕获不到）；不做"用户纠正"识别与跨轮链路归因（属全自动 M7 范畴）；候选上限 5 条，超出丢最旧；`lattice_capture` 一次 accept 多个候选时只要有一个校验失败就整体报错（前面的已写入属部分成功）。

## 附录 G：M7 落地记录（2026-11-02，已实测通过）

**验收实测（2026-11-02）**：`read F:\温迪\dsh-lattice-memory\quickstart-broken-path.md` 失败 → 用户回「不对，应该先读 README.md」→ `read README.md` 成功 → `lattice_capture list` 出现候选「自动捕获：用户纠正后 read 才成功」，正文含 `> 不对，应该先读 README.md`，evidence 3 条（`run:read (auto-captured user-correction at …)`、`run:user-correction (quoted in the body)`、`file:F:\温迪`），reason=`user-correction`。由此定位并修复：原先 `turn/end` 直接丢弃未纠正失败，导致"跨轮纠正"永远捕获不到；现改为窗口期内保留（`capture.incidentMinutes`），仅在超窗时丢弃。

| 文件 | 内容 |
| --- | --- |
| `src/capture.js`（扩展） | 新增 `looksLikeCorrection`（中英纠正用语表）、`messageText`（字符串 content 或 text 块数组 → 纯文本）、`createSessionCaptureTracker({forgetAfterMs, maxIncidents, maxAttempts})`：按会话隔离；`recordTool({sessionKey, tool, isError, errorText, now})` 记录每次工具结果（`lattice_*` 忽略），失败开 incident（同工具合并 count），同工具成功或"带纠正的 incident 被任意成功"时关闭并返回 `recovered`；`userMessage({sessionKey, text, now})` 只在命中纠正用语且有未恢复 incident 时把这句话挂上去（每条 incident 最多 3 句）；`endTurn({sessionKey, now})` 收敛：有纠正的 incident 即使没有后续成功也返回（`reason: "user-correction"`），没纠正也没恢复的直接丢弃；`buildIncidentCandidate({incident, dims, workspace, now})` 生成候选（标题区分 用户纠正/失败后找回/先失败后成功，body 含失败原文 + `> 用户纠正` 引用 + 待补充 + 验收口径；evidence `run:<tool>` + `run:user-correction` + `file:<workspace>`） |
| `src/index.js` | Config：`capture.mode` 接受 `notify \| draft \| auto`；新增 `capture.detectUserCorrections`（默认 true）与 `capture.incidentMinutes`（默认 10，映射到 tracker 的 `forgetAfterMs`）。`attachCapture` 重写：`tools/result` 用会话 key（`exec.agent.session.id`）记录工具结果并发布恢复的 incident；新增 `ctx.on("session/event", …)`：`user/message` 且 `source.kind === "user"` 时调用 `tracker.userMessage`，`turn/end` 时 `tracker.endTurn` 并发布；发布逻辑 `publish(incident, workspace)`：`mode !== "notify"` → `storeCandidate`（失败回落队列），否则 `addCandidate`；两处 handler 均整体 try/catch，绝不打断工具执行或会话管线；提示段文案改为「Memory capture (M7) … pending candidate(s) from recent tool failures / human corrections」 |
| `scripts/selftest.mjs` | 新增 M7 断言：失败→纠正挂接→同工具成功收敛为 `user-correction` 且候选正文含纠正原文、evidence 3 条；普通闲聊不挂接；未恢复未纠正的失败在 `endTurn` 被丢弃；带纠正的 incident 即使没有后续成功也在 `endTurn` 返回；会话隔离；重复 `endTurn` 不重复返回 |
| `README.md` / `PLAN.md` | 进度行/版本表/进度行/路线图加 M7；README「自动捕获（M6/M7）」章节重写（宿主侧 M6/M7 两段、纠正用语、模式说明）；配置示例加 `detectUserCorrections` / `incidentMinutes`；文件分工与本事录 |

**设计取舍**
- 用户纠正只在"已有未恢复失败"时挂接：没有失败时随口一句"其实可以…"不生成记忆，避免把普通讨论误记为踩坑。
- `turn/end` 收敛而不在每条消息上即时写入：一轮结束时才能判断"失败后来到底修好了没有"，也能把同一轮的多条信号合成一条候选。
- 被纠正但从未成功的失败仍然捕获（`user-correction`）：人明确指出哪里不对，本身就是可复用的经验；正文注明"未验证修复"。
- 默认仍 `notify`；`auto` 供愿意接受 draft 噪音的用户显式开启（清掉一个 draft 的成本远低于漏记）。



