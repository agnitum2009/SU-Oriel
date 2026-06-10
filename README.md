# SU-Oriel

> **SU-CCB AI 工程协作框架的「视图层 / 驾驶舱」** —— 一个**只读投影 + 触发**的本地控制台。把一个项目的需求、任务、文档和运行记录从本地文件与数据库里投影成界面，让你**看得见、点得动**。

SU-Oriel 不是一个独立工具，它是 [**SU-CCB**](https://github.com/Im-Sue/SU-CCB) 这套 AI 工程协作框架的一部分。要看懂它，先得知道它在管什么、为什么这么管。

<a id="quick-eval"></a>

## 评估者 5 分钟看控制台

只想先看 SU-Oriel 控制台，不需要 clone SU-CCB 根仓。直接 clone 本仓、安装依赖、启动后端和前端：

```bash
git clone https://github.com/Im-Sue/SU-Oriel.git && cd SU-Oriel
pnpm install
pnpm build

# 终端 1：后端，首次会准备本地 SQLite DB
./scripts/dev-server.sh

# 终端 2：前端
./scripts/dev-web.sh
```

前端启动后按终端输出的 Vite 地址打开页面，登记一个本地项目路径即可查看项目、文档和任务投影。要从控制台投递 `/ccb:su-init`、打开 slot 终端或跑真实 agent，再按下面的「快速开始」补齐 plugin / skills / bridge。

---

## 一、先理解它属于什么：从 Vibe Coding 到 Vibe Engineering

AI 已经很会写代码了。但做项目时我们还是经常不放心 —— 问题已经不是 **AI 能不能写**，而是 **AI 能不能持续做对**：写得快但方向容易错、第二三轮开始跑偏、上下文漂移、返工和 review 成本高、很难复盘"为什么这么改"。

> **不是生成最贵，是"确认"最贵。** 真正烧钱的是方向走偏后的返工、上下文丢失后的重复沟通、审查时重新理解背景、协作时无法复盘。

**Vibe Engineering** 就是把 AI 协作当成一个**工程过程**来管理，而不是当成一个更聪明的补全工具。目标不是"写得快"，而是把高风险环节先管住，让结果**可控、可复用、可审计**：

| | 含义 |
|---|---|
| **可控** | 关键节点有审批门，避免"正确地执行了错误的目标" |
| **可复用** | 需求 / 设计 / 决策 / 状态写成结构化文档落在仓库里，可 diff、可恢复、可沿用 |
| **可审计** | 每一步都有节点、协商记录和归档证据 —— 谁、为什么、怎么验证，全程可复盘 |

> 完整理念见 SU-CCB 根仓 README。SU-Oriel 是这套理念**长出来的那块屏幕**。

## 二、它建在什么之上：claude-plugin + codex-skills + CCB 运行时

SU-CCB 的核心是**决策与执行分离**：Claude 负责想清楚，Codex 负责做出来，关键节点停下来确认。这套分工不是靠 prompt 堆出来的，而是靠一层**工程护栏（harness）**把两个 agent 套住：

| 它是什么 | 在哪个仓 | 干什么 |
|---|---|---|
| **Claude 决策侧 + 协议内核** | [`su-ccb-claude-plugin`](https://github.com/Im-Sue/su-ccb-claude-plugin) | 需求理解 / 技术方案 / 任务切片 / 审查把关；`references/kernel/` 是 7 节点工作流、审批门、转移规则的**真相源** |
| **Codex 执行侧** | [`su-ccb-codex-skills`](https://github.com/Im-Sue/su-ccb-codex-skills) | 落地实现 / 验证 / 协商 / 回执；遇到边界主动回抛不确定性 |
| **底层桥接运行时** | [`claude_codex_bridge`](https://github.com/SeemSeam/claude_codex_bridge) | `ccb` / `ccbd`，提供 Claude↔Codex 的多 agent 桥接、派工、slot / window 编排 |

**harness 是什么，打个比方**：raw 的 Claude、Codex 就像两个很能干但容易跑偏的人，不给流程、不给护栏，写得快但方向容易错。harness 就是套在他们外面那层东西 —— 协议内核定义 7 个节点（需求分析 → 技术设计 → 任务拆分 → 派工 → 实施 → 审查 → 归档），关键节点设**审批门**，执行方遇到边界**主动回抛**，做完给**结构化精简回执**，全程**留痕**。它把"和 AI 聊天写代码"套成"一条有工位、有质检、有签字的流水线"。这条流水线由上面三件东西一起组成。

## 三、SU-Oriel 在这套 harness 里是什么：流水线的中控大屏

SU-Oriel **不参与生产** —— 它不决策、不执行、不写业务真相。它是这条流水线的**中控大屏 / 驾驶舱**：

- **看得见**：把每个工位的状态画出来 —— 节点状态（`currentNode` / `nodeSubstate` / `runtimeState`）、任务看板、需求与文档、scan / parse / reconcile 运行记录与失败留痕。原来散在 `docs/` 和 `docs/.ccb/` 里的协作状态，一屏俯瞰。
- **点得动**：能按按钮触发动作 —— 创建 / 同步项目、扫描重索引、重新分析需求、上传资产、拉起内嵌 slot 终端（这一项运行时用到底层 CCB 桥接）。
- **不写真相**：业务真相始终在项目的人读文档里，控制台只读投影 + 触发。**控制台坏了也不丢数据** —— 没有它，项目照样靠文件系统、git 和编辑器跑得通；有它，多一双俯瞰全局的眼睛。

> 一句话定位：**真相源在协议层（kernel）和数据层（docs），SU-Oriel 是可选的一层视图。** 它让 harness 的内部状态变得"看得见、点得动"，但管不着流水线本身。

## 四、对项目管理的好处

| 痛点 | SU-Oriel 带来的 |
|---|---|
| AI 改了一堆，不知道做到哪了 | 节点 / 任务 / 需求一屏可视，进度与卡点一目了然 |
| 状态散在文件里，要翻目录才看得到 | 从 `docs/.ccb` 与本地投影库自动归并成看板，不用手翻 |
| 跑偏 / 失败没人发现 | 运行记录与失败留痕集中展示，问题早暴露 |
| 复盘"为什么这么改"成本高 | 需求、设计、决策、归档证据可点开就看，审计有据可查 |
| 多端项目结构乱 | 按"总-分"结构投影前端 / 后端 / 后台，全局清晰 |

> 它把 Vibe Engineering 的"可控 / 可复用 / 可审计"从**文档里的承诺**变成**屏幕上的实景**。

---

## 推荐的项目结构（总-分）

SU-Oriel 观测的是一个**带 `docs/.ccb` 的项目根**。多端产品**建议**按"总-分"组织，层次更清晰：

```text
my-product/                     ← 总：整个产品（SU-Oriel 观测的项目根）
├── docs/                       ← 一份 CCB 文档工作区（SU-Oriel 就看这里）
│   ├── .ccb/                   ← 契约 / 状态 / 索引（机器协调件）
│   ├── 00_项目总览.md  00_文档地图.md
│   ├── 01_架构设计/            ← 系统总架构 + 前端 / 后端 / 后台管理 各一份（按端拆）
│   ├── 02_需求设计/  03_开发计划/   ← 整份不拆（本就跨端）
│   ├── 04_模块规格/            ← 前端-X / 后端-X / 后台-X（按端拆）
│   └── 05_经验沉淀/  06_决策记录/  99_归档/
├── web/                        ← 分：前端
├── server/                     ← 分：后端
└── admin/                      ← 分：后台管理
```

- 一个**总**（整个项目 + 一份 `docs/`）下挂多个**分**（端）。
- `docs/` 里：**架构、模块规格按端拆**（前端 / 后端 / 后台 + 系统总），**需求、设计、任务整份不拆**（本就跨端）。
- 单端项目就退化成"一个根 + 一份 docs"，不必强分。

> 这是**建议结构，不是强制** —— SU-Oriel 只要求项目根有 `docs/.ccb`。

## 它如何"观测"一个项目

SU-Oriel 自己的代码（本仓）和它观测的项目是**两回事**：

- 运行时指向一个**项目根**：在控制台里登记项目的本地路径，或用 `CCB_PROJECT_ROOT`，或从启动目录向上自动发现 `.ccb/`。
- 只读项目的 `docs/.ccb`（契约、状态、草稿、索引）+ 本地 SQLite 投影库，**只读 + 触发**，不改你的业务文档。
- **不需要和被观测项目放在一起** —— 一个 SU-Oriel 可以观测任意带 `.ccb` 的项目，也**不要求**平级装了 plugin / skills（控制台经项目本地契约 + 内置 fallback 运行）。

## 技术栈

| 端 | 技术 |
|---|---|
| `web/` 前端 | React 19、Vite 7、React Router、Zustand、xterm.js、Vitest |
| `server/` 后端 | Node.js、Fastify 5、Prisma 6、SQLite、Zod、tsx、Vitest |

pnpm workspace（`web` + `server`），包名 `su-oriel-web` / `su-oriel-server`。

## 能做什么

| 能力 | 说明 |
|---|---|
| 项目管理 | 登记本地项目、查看路径 / 初始化 / 同步状态与概览统计；创建后触发扫描 + 文件 watcher |
| 文档中心 | 扫描并在线阅读项目 `docs/` 文档；只读投影 + governance 校验 |
| 任务看板 | 从文档归并任务，按**节点状态**（`currentNode` / `nodeSubstate` / `runtimeState`）投影；timeline、review intent、sprint |
| 需求入口 + 详情 | 录入需求（**md-first**）；详情页做编辑、重新分析、重索引、资产上传、内嵌 slot 终端 |
| 运行记录 | 查看 scan / parse / reconcile 运行记录与失败留痕 |

> 旧流程已退役并如实返回 `410`：`generate-task`（旧"立项生成任务"，现 md-first）、`task-run dispatch`（旧 worktree 派工入口）。

## 快速开始

> **环境**：仅支持 **WSL 与 macOS**（`node-pty` 等原生模块依赖 Unix；Windows 请在 WSL 内运行）。

### 1. 安装并启动 SU-Oriel

控制台用户只需要 clone 本仓，不需要 clone SU-CCB 根仓：

```bash
git clone https://github.com/Im-Sue/SU-Oriel.git && cd SU-Oriel
pnpm install
pnpm build
```

启动后端和前端需要两个 shell：

```bash
# shell 1：后端，首次会准备本地 SQLite DB
./scripts/dev-server.sh
```

```bash
# shell 2：前端
./scripts/dev-web.sh
```

### 2. 安装 plugin / skills

先按 [su-ccb-claude-plugin 安装说明](https://github.com/Im-Sue/su-ccb-claude-plugin#install) 完成系统级 Claude plugin 安装，并按 [su-ccb-codex-skills 安装说明](https://github.com/Im-Sue/su-ccb-codex-skills#install) 完成用户级 Codex skills 安装；两者都要先装好，再启动 CCB，这样 CCB 派生的 Claude / Codex agent 才会继承 plugin 与 skills。

### 3. 安装底层 bridge

安装 [claude_codex_bridge](https://github.com/SeemSeam/claude_codex_bridge#readme)（提供 `ccb` / `ccbd`、slot 终端和 project ccbd），按其 README 执行 `./install.sh install`。bridge 前置依赖包括 Python 3.10+、`tmux`、Claude / Codex CLI。

### 4. 接入每一个项目

在 SU-Oriel 控制台登记本地项目路径后，页面顶部会出现 `ProjectOnboardingBanner`：

- 可以点击一键投递，让主项目 `ccbd` 执行 `/ccb:su-init`。
- 也可以复制命令，在该项目终端里手动运行 `/ccb:su-init`。
- ready 判定以项目根下 `.ccb/ccb.config` 与 `docs/.ccb/docs-structure-contract.yaml` 同时存在为准。

### 5. 收尾与关闭

- 停 CCB/agent/tmux 运行时：先执行 `ccb kill`；仍有残留时执行 `ccb kill -f`。
- 停 SU-Oriel 后端和前端：回到运行 `./scripts/dev-server.sh`、`./scripts/dev-web.sh` 的终端，按 `Ctrl-C`，或直接关闭对应终端。
- 后台 project ccbd 是**有意常驻**：关闭控制台页面或停止 SU-Oriel dev server/web 后，已投递的后台 agent 长任务不会被打断。这不是 bug；需要彻底收尾时再用 `ccb kill` / `ccb kill -f`。

## Troubleshooting

| 症状 | 修法 |
|---|---|
| `pnpm: not found` | pnpm 由 corepack 管理：`corepack enable && corepack prepare pnpm@10.25.0 --activate`，重开 shell 后 `pnpm --version` 验证。无 sudo 时：`corepack enable --install-directory ~/.local/bin` 并把它加进 `PATH`。 |
| `node-pty Could not locate the bindings file` | 重建原生模块：`pnpm --filter su-oriel-server rebuild node-pty`，或重装依赖。 |
| `prisma` 无执行位 | `chmod +x server/node_modules/.bin/prisma`，或重装依赖。 |
| 依赖损坏 / 跨平台切换 | `rm -rf server/node_modules web/node_modules && pnpm install --frozen-lockfile`。 |
| `python: command not found` | 部分脚本用 `python3`，确认 `which python3` 可用。 |

## 架构与模块（简版）

- **后端**（`server/`）：Fastify API + Prisma/SQLite 投影库 + indexer（扫描 / 解析 / 归并 / 索引）+ 三 root 解析（sourceRoot / projectRoot / 契约）。
- **前端**（`web/`）：React 页面（项目 / 文档中心 / 任务看板 / 需求）+ Zustand stores + projection hooks。
- 模块：项目管理、文档中心、任务看板、需求入口、需求详情、同步与索引、TaskRun 状态机。

> 完整架构与模块规格见 SU-CCB 文档中枢 → [SU-CCB/docs](https://github.com/Im-Sue/SU-CCB/tree/main/docs)（`01_架构设计/su-oriel-*`、`04_模块规格/su-oriel-*`）。

## 生态全景

SU-Oriel 是 SU-CCB 四仓之一，其余三仓各司其职：

| 仓库 | 角色 |
|---|---|
| [`Im-Sue/SU-CCB`](https://github.com/Im-Sue/SU-CCB) | 根容器：人读文档中枢 + `docs/.ccb` 工作区 + 跨仓版本绑定 |
| [`Im-Sue/su-ccb-claude-plugin`](https://github.com/Im-Sue/su-ccb-claude-plugin) | Claude 决策侧 + 协议内核真相源（7 节点 / 审批门 / 转移规则） |
| [`Im-Sue/su-ccb-codex-skills`](https://github.com/Im-Sue/su-ccb-codex-skills) | Codex 执行侧（execute / consult / doc skills） |
| **`Im-Sue/SU-Oriel`**（本仓） | 视图层 / 驾驶舱：只读投影 + 触发 |

## 交流与讨论

有问题、想法，或想参与共建？扫码加微信（备注 **CCB**），拉你进讨论群：

<img src="assets/wechat.jpg" alt="微信二维码" width="220" />

GitHub [@Im-Sue](https://github.com/Im-Sue) · Telegram [@Sue_muyu](https://t.me/Sue_muyu)
