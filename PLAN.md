# Lattice（`dsh-lattice-memory`）设计方案 v2

> 版本：v2.1（2026-11-01）— 依据 2026-11-01 拍板更新（公开发布 / 首启选库根弹窗 / overlay 关闭 / MVP=M0–M3 / 项目仓库已定）
> 状态：M0 已落地并在 DSH 桌面端实测通过（2026-11-02）；下一步 M1（检索）
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

### P2 — 协作与生态（M5）

| 功能 | 说明 |
| --- | --- |
| 导出通道 | `export`：子集导出为 `SKILL.md`（skills 通道）/ `AGENTS.md` 片段 / JSON（可迁移） |
| 导入 | `import`：从 JSON 或 `session-search` 结果导入候选（dry-run 先展示差异） |
| 面板 UI | client 侧 decoration 面板：浏览、检索、矩阵网格视图（可选，默认关闭） |
| 发布 | npm scoped + plugin market 索引条目 + README 快速上手 |

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
| `lattice_export` | `format: skill\|agmd\|json`、过滤条件、`outPath` | 导出文件（M5） |
| `lattice_import` | `source`、`dryRun=true` | 导入预览 / 结果（M5） |

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
| **M1 存储+检索+画像** | frontmatter/多根库、分词+BM25、`search/get/list`、`minecraft-mod` 预设、常驻注入 | 4–6 天 | fixtures 两套 MC 工作区画像正确；golden 检索集 top-3 命中 ≥ 80%；注入段 ≤ 1500 tokens 且顺序稳定 |
| **M2 写入闭环** | `record/verify`、相似去重、密钥扫描、stale 判定 | 2–3 天 | 重复条目被拒并给合并建议；含密钥被拒；verify 后排序上升 |
| **M3 矩阵与缺口** | `matrix`、`gaps`、`brief`（v0） | 3–4 天 | MC 矩阵正确标出 ✓/◐/✗；gaps 排序合理；brief 可直接指导移植 |
| **M4 通用性验证** | `node-package` 预设、自定义 extractor、`lint`、`stats`、主动注入（实验） | 3–4 天 | 在 node18/node20 两 fixture 上矩阵与 brief 可用；lint 无假阳性；主动注入可关、失败不阻塞 |
| **M5 协作发布** | `export`（skill/agmd/json）、`import`、面板 UI（可选）、**公开发布**（npm `dsh-lattice-memory`；撞名则 scoped）、market 条目、发布说明 | 5–7 天 | 导出 SKILL.md 被 skills 加载；两台机器共享 git 库可用；`npm i` 安装成功且首启引导正常 |

**MVP = M0–M3，约 2–3 周（单人，熟悉 Cordis 可 1.5 周）**；M4 的第二个预设是“通用性”的硬验收，建议不跳过。

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
| 4 | 发布目标 | **公开发布**（GitHub 仓库已建，README/LICENSE/快速上手从 M0 就写） | §10 M5、附录 B |
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
| `src/index.js` | Config（root/onboarding/inject/projectOverlay/staleDays）；`lattice_setup` / `lattice_status` / `lattice_profile` / `lattice_search`（M0 桩）；`/lattice/state`、`/lattice/setup` 路由；常驻提示段 |
| `src/client.js` | 手写 ModuleLoader bundle；`shell.overlay` 首启卡片（选择文件夹 → DSH 原生目录选择器 → 兜底手输；使用默认位置；稍后） |
| `README.md` / `LICENSE` / `.gitignore` | 安装、验证、配置、开发说明；MIT；忽略规则 |

验收方式（需在 DSH 内执行，本机 pwsh 不可用）：

1. `plugin_manager` 的 `install_bundle`（target = 本目录绝对路径）或 `dsh plugin --profile desktop add F:\温迪\dsh-lattice-memory`；
2. 让 agent 调 `lattice_status`，确认 `configured=false`、`state_dir`、`default_root`；
3. 刷新 Web GUI，确认首启卡片出现；分别验证「选择文件夹…」「使用默认位置」「稍后」；
4. 再次 `lattice_status` 确认 `configured=true`、`root_source=user|default`、`is_library=true`。

M0 刻意未做：真实检索（M1）、常驻索引注入与矩阵（M2）、写入闭环（M3）、导出与发布（M4–M5）。

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
