# Lattice (`dsh-lattice-memory`)

给 DeepSeek Harness（DSH）用的**跨项目经验记忆库**：同一个功能在不同版本、加载器、技术栈里的不同做法，记成一条条 Markdown，按维度（`game / mcver / loader / platform / branch …`）打标签；所有工作区共用一个库，检索时只召回与当前项目匹配的部分。

---

## 安装

在 DSH 里用本地路径安装（按你的 DSH 版本二选一）：

```bash
# 方式 A：DSH CLI
dsh plugin --profile desktop add <插件目录绝对路径>

# 方式 B：让 DSH 里的 agent 调用 plugin_manager 的 install_bundle，
# target 传同一个绝对路径
```

装完**完全退出并重开 DSH 桌面端**（客户端 bundle 在页面启动时组装，桌面端 `Ctrl+R` 不一定生效）。

## 首次使用

1. 在对话里让 agent 调 `lattice_status`，确认 `configured: false`（还没配置库根）。
2. 页面右下角出现 **Lattice 首启卡片**，点「选择文件夹…」挑一个空目录或已有库目录；也可以点「使用默认位置」（`<DSH_HOME>/lattice-library`，即 `~/.dsh/lattice-library`）。
3. 选空目录 → 原地初始化；选已有 Lattice 库 → 直接接管。完成后卡片消失，库根记在 `<DSH_HOME>/lattice/root.json`。

> 桌面端若没有 `webServer` 服务（HTTP 路由不挂载），卡片不会出现，直接让 agent 调 `lattice_setup(path=...)` 配置即可。

## 配置

配置写在**当前 profile 的 `cordis.patch.yml`**（用户 patch 层，升级插件后保留）：

```yaml
- id: lattice
  config:
    root: "D:/Lattice"        # 留空 = 用首启卡片选的库根
    onboarding: true          # 未配置时是否显示首启卡片
    debug: false              # true = 把首启路由诊断写入 <stateDir>/route-debug.log
    staleDays: 180            # 检索时按天数做新鲜度衰减
    inject:                   # 常驻索引注入
      enabled: true
      topK: 8                 # 最多注入多少条
      maxTokens: 1500         # 注入段 token 预算
    projectOverlay: false     # true = 额外读 <workspace>/.lattice 的 overlay 条目
    readOnly: false           # true = 拒绝所有写入
    record:
      requireEvidence: true   # true = 无 evidence 的条目拒绝写入
    lint:
      similarityThreshold: 0.85  # 近似重复判定阈值（Jaccard）
    capture:                  # 自动捕获
      enabled: true
      mode: notify            # notify=只排队；draft/auto=直接写 draft（auto 还会纳入用户纠正）
      maxPending: 5
      detectUserCorrections: true
      incidentMinutes: 10
    backup:                   # 备份
      dir: ""                 # 留空 = <profile>/backups（插件安装位置旁边）
      keep: 10
```

优先级：`config.root` > 首启卡片选的库根（`root.json`）。

## 模型侧工具

| 工具 | 作用 |
| --- | --- |
| `lattice_status` | 是否已配置、库根、条目数、状态目录（排查安装用） |
| `lattice_setup` | 配置/更换库根（`path=...` 或 `use_default=true`） |
| `lattice_profile` | 识别当前工作区的 preset 与维度 |
| `lattice_search` | 关键词检索（自带维度过滤，命中带 `applicable`；`mode=strict` 排除跨版本条目） |
| `lattice_get` / `lattice_list` | 按 id 读全文 / 按 feature、kind、status 列条目 |
| `lattice_brief` | 预览当前会注入系统提示的常驻简报与 token 估算 |
| `lattice_matrix` / `lattice_gaps` | feature × 维度组合矩阵 / 找出还没覆盖的维度组合 |
| `lattice_record` / `lattice_verify` / `lattice_lint` | 写 draft / 带证据提升为 verified / 库健康检查 |
| `lattice_export` / `lattice_import` | 导出 JSON · SKILL.md · AGENTS.md / 导入 JSON（默认只预检差异） |
| `lattice_capture` | 查看/接受/丢弃自动捕获的候选（`list` / `accept` / `discard`） |

典型用法：让 agent 先 `lattice_profile` 看当前项目维度，再 `lattice_search`（命中后 `lattice_get` 读全文）；收工时让它 `lattice_record` 记一条 draft，确认没问题再 `lattice_verify` 提升为 verified。

## 面板

两个入口，打开的是同一块界面：

1. **对话页头部「记忆库」按钮** —— 全屏打开（盖住工作区，右上角「关闭」或 Esc 返回）。
2. **设置页「Lattice 记忆」分节** —— 内嵌在设置里。

面板里的功能：

- **浏览**：列出库内条目，点开看全文与证据；顶部输入框留空 = 浏览，回车 = 检索。
- **矩阵**：feature 与维度组合的 3D 神经网络视图，可拖拽旋转（松手带惯性）、滚轮或「＋/－」缩放；实线 = 有条目（粗细 = 条数、颜色 = 最佳状态），虚线 = 覆盖缺口。
- **捕获**：自动捕获的候选队列（`capture.mode=notify` 时才有），可直接「接受为 draft」或「丢弃」，点「查看详情」看完整正文与证据。
- **导出/导入**：一键导出 JSON / SKILL.md / AGENTS.md 并复制；粘贴 JSON 先「预检」再写入；也可「导入单条记忆」（选一个带 YAML frontmatter 的 `.md`）。
- **写一条记忆**：手填标题、feature、kind、正文、证据等，直接以 draft 写入库。
- **刷新**：面板右上角「刷新」会重新读取状态并重挂当前 tab。
- **删除**：每条右侧「删除」；勾选多条可「删除所选（N）」；底部「清除记忆库…」是清空全部（30 秒倒计时警告，可取消）。
- **备份**：可自定义备份目录（留空 = 插件安装位置旁边的 `backups/`）与备份名称；面板显示默认目录、插件安装位置、插件包实体、已有备份数，可选择某份备份「恢复」（确认后覆盖同名条目）。
- **背景图**：没有壁纸插件时，可上传一张本地图片当面板背景（存在宿主，重启后仍在）；装了壁纸插件会自动透传壁纸并压暗。

## 条目格式

每条记忆是 `entries/<id>.md`，YAML frontmatter + Markdown 正文：

```markdown
---
id: potion-duration-forge-1-20-1
kind: contract
title: 1.20.1 Forge 药水持续时间必须走 Attribute 修饰符
summary: 一句话结论（检索摘要用）
feature: 药水持续时间
tags: [potion, attribute, forge]
dims:
  game: minecraft
  mcver: "1.20.1"
  loader: forge
status: verified
confidence: high
verified_on: 2026-10-30
evidence: ["file:src/main/java/com/example/PotionHandler.java"]
---

## 结论
...
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | `^[a-z0-9][a-z0-9._-]*$`，≤80 字符，即文件名 |
| `kind` | ✅ | `contract` / `decision` / `gotcha` / `port` / `checklist` / `reference` / `note` |
| `title` | ✅ | 人类可读标题 |
| `feature` | ✅ | 功能/能力名（矩阵与缺口按它聚合） |
| `status` | ✅ | `draft` / `verified` / `stale` / `deprecated` / `superseded`（draft 不进常驻注入） |
| `dims` | 强烈建议 | 维度→值；值可写区间（`">=1.21 <1.22"`）或通配（`"1.20.x"`） |
| `summary` / `tags` / `confidence` / `verified_on` / `evidence` | 建议 | `evidence` 用 `file:` / `run:` / `url:` |
| `supersedes` / `related` / `applies_when` | 可选 | 取代关系 / 相关条目 / 适用文件与符号 |

> 版本值务必加引号（`mcver: "1.20"`）：YAML 会把未加引号的 `1.20` 解析成数字 `1.2`，导致维度匹配失效。

也可以直接用面板「写一条记忆」或「导入单条记忆」写入，不必手写 frontmatter。

## 自动捕获

宿主会观察工具执行和用户消息，把"踩坑后又修好"的过程记成**候选**（默认不写库）：

- 某工具先失败、之后同一 agent 里同一工具又成功 → 生成候选；
- 人类纠正（"不对 / 应该 / 改成 / 而不是 …"）会挂到当前未恢复的失败上，轮次结束或修好时收敛成候选；
- 候选里有：失败原文、涉及文件、时间线、你说过的纠正原话；
- 默认 `capture.mode: notify`：候选进面板「捕获」tab，模型用 `lattice_capture` 查看、接受（写成 draft）、丢弃；改成 `draft` 或 `auto` 则直接写 draft。

## 备份

- 一键备份 = 把库目录快照到 `<backup.dir>/lattice-YYYYMMDD-HHmmss-<名称>/`（含 `entries/*.md`、`projects.json`、`.lattice-root.json`、`manifest.json`），默认保留最近 10 份。
- 留空目录时默认在**插件安装位置旁边**（`<DSH_HOME>/profiles/<profile>/backups`），不跟着你的项目目录走。
- 恢复 = 从选中的备份把条目与元数据覆盖回库（只覆盖同名文件，不删备份后新增的条目）。

## 库目录布局

```text
<库根>/
  .lattice-root.json   # 标记文件
  projects.json        # 可选：工作区 → 显式维度/预设
  entries/             # 每条记忆一个 .md
<workspace>/.lattice/  # 可选 overlay（projectOverlay: true 时生效，同 id 覆盖共享库）

<DSH_HOME>/lattice/    # 插件状态（不是记忆库）：root.json、background.bin、captures.json、boot.log …
```

## 故障排查

- **面板报"宿主没有响应"或 404**：先完全退出再重开桌面端；仍不行看 `<DSH_HOME>/lattice/boot.log`（每次加载会记录 `apply: start` / `panel: registered …` / 异常栈）。
- **首启卡片不出现**：确认 `onboarding: true` 且没配过库根；桌面端没有 `webServer` 时改用 `lattice_setup(path=...)`。
- **首启/卡片请求异常**：配置里临时开 `debug: true`，请求记录会写到 `<DSH_HOME>/lattice/route-debug.log`（`admitted: true` 表示已过 DSH 信任栅栏）。
- **改了插件代码不生效**：宿主与客户端都要重新加载——完全退出并重开桌面端。

## 许可

MIT
