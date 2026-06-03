# SU-Oriel

> 一个**只读投影 + 触发**的本地协作控制台 / 驾驶舱 —— 把一个项目的需求、任务、文档和运行记录从本地文件与数据库里投影成界面，让你看得见、点得动。

SU-Oriel **观测**一个项目：读它的 `docs/.ccb` 与本地投影库，把协作状态画出来，并能触发分析、重索引等动作。它**不写业务真相** —— 真相始终在项目的人读文档里，控制台坏了也不丢数据。没有它，项目照样靠文件系统、git 和编辑器跑得通；有它，多一双俯瞰全局的眼睛。

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
- **不需要和被观测项目放在一起** —— 一个 SU-Oriel 可以观测任意带 `.ccb` 的项目。

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
>
> **前置必装**：先装底层运行时 [claude_codex_bridge](https://github.com/SeemSeam/claude_codex_bridge)（提供 `ccb` / `ccbd`，slot 终端等能力依赖它）——
> ```bash
> # 从 Releases 下载 ccb-*.tar.gz 后
> tar -xzf ccb-*.tar.gz && cd ccb-* && ./install.sh install
> # 或源码：git clone https://github.com/SeemSeam/claude_codex_bridge.git && cd claude_codex_bridge && ./install.sh install
> ```
> bridge 前置依赖：Python 3.10+、`tmux`、至少一个 agent CLI。

```bash
pnpm install
pnpm --filter su-oriel-server db:prepare   # 首次：准备本地 SQLite DB
pnpm dev:server                            # 启动后端（一个终端）
pnpm dev:web                               # 启动前端（另一个终端）

# 构建 / 测试
pnpm build
pnpm test
```

启动后在控制台里登记你的项目（填本地路径），即可开始观测。

> 也可以用 `scripts/` 下的一键脚本（自动 db 准备 + 构建 + 启动）：bash 用 `./scripts/dev-server.sh`、`./scripts/dev-web.sh`；Windows 用同名 `.ps1`。

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
