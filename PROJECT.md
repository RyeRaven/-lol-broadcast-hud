# PROJECT.md — Khada Jhin 项目总览

> 切换模型后的第一入口。阅读顺序：本文件 → `ARCHITECTURE.md`（技术选型/模块/设计决策）→ `TASKS.md`（当前任务、进度、待办）→ `CONVENTIONS.md`（编码与接口约定）→ `CHANGELOG.md`（改动时间线）。
> 最后更新：2026-11-16。项目根：`C:/Users/RyeRaven/Documents/Codex/2026-11-12/windows-lol-mvp-1-lol-2`。现名 Khada Jhin（原 RiftBroadcast），version 0.2.2。
> git 仓库（2026-11-16 起）：GitHub 公开库 <https://github.com/RyeRaven/-lol-broadcast-hud.git>（GPL-3.0，origin=main 已推送）。改动时间线仍以 `CHANGELOG.md` 为准，请每次改动后 commit 并补记。

## 1. 项目目标

Windows 本地《英雄联盟》赛事导播辅助工具。把 LCU（客户端 API）、Live Client Data API（`https://127.0.0.1:2999`）和 Data Dragon 公开数据，转换成 OBS Studio Browser Source 可采集的赛事 Overlay（赛前 BP、局内 HUD、赛后、转场），并提供本地三栏导播控台。

交付形态：可双击运行的 Electron 托盘程序 + NSIS 安装包 / 免安装目录；所有页面由本机 HTTP 服务提供，默认 `http://127.0.0.1:3210/`。

**合规红线（不可协商）**：
- 不读游戏内存、不注入进程、不修改游戏文件、不绕过反作弊（Vanguard）、不模拟游戏操作；只用 Riot 官方本地接口、公开 Data Dragon/CDN 资源、本地配置。
- LCU `--remoting-auth-token` 只在内存中用于本机 Basic Auth；不写日志、不写配置、不进仓库。
- 本地 HTTP 只绑定 127.0.0.1，不向局域网/公网开放。
- 不伪造官方数据：拿不到的字段宁可置 null / 显示 DEMO 空态，也不编造（见 `ARCHITECTURE.md` 第 8 节）。

## 2. 功能总览

| 领域 | 能力 | 主要文件 |
| --- | --- | --- |
| 数据源 | LCU 自动发现（启动参数 / 环境变量 / 国服 LeagueClientUx 日志 / WMI / 缓存端口）；Gameflow 轮询；ChampSelect session；Data Dragon 英雄与装备缓存 | `src/data-sources.js`、`src/draft.js`、`src/champions.js`、`src/assets.js` |
| 局内数据 | `liveclientdata/allgamedata` 每秒轮询，归一化为 10 人名单；事件时间线、精彩事件评分、自动导播规则、经济估算 | `src/live-data.js`、`src/timeline.js`、`src/highlights.js`、`src/director.js` |
| 赛后 | EOG stats block 优先，:2999 关闭前冻结快照兜底；伤害占比 / 参团率 | `src/post-game.js`、`src/main.js`（frozenSnapshot） |
| 广播页 | BP / 局内 HUD / 赛后庆典 / 转场，1920×1080 透明底，SSE 实时刷新 | `src/pages/*.js`、`public/*.css`、`public/anim.js` |
| 控台 | 三栏导播台：阶段与模式切换、LCU/LiveClient/OBS/Replay 健康灯、10 人 KDA 名单、30 条事件流、广播配置编辑、OBS/回放/自动导播控制 | `src/pages/console.js`、`public/console.css` |
| OBS | obs-websocket v5 连接/鉴权、场景切换、录制/推流/回放缓冲、场景集合与 Browser Source 创建、阶段自动切场景 | `src/obs.js`、`tools/setup-obs-scenes.js` |
| 回放镜头 | Replay API 镜头 / 播放 / 关键帧序列（仅录像，直播观战不可用） | `src/replay.js`、`/api/replay/*` |
| 桌面壳 | 端口 3210 起自增最多 50、单实例锁、系统托盘、关闭到托盘、退出时 taskkill 子服务、冒烟模式 | `electron/main.cjs` |
| 打包 | NSIS 安装包 / 免安装目录，`asar:false` 复用本地 Electron 运行时 | `package.json`、`build-windows.bat` |

无客户端时可用 mock 模式演示完整 BP → 局内 → 赛后流程。

## 3. 整体架构

单向数据流：数据源轮询 → 归一化 → 单一 `state` → SSE/HTTP → 浏览器页面渲染 → OBS Browser Source 采集。

```text
  LCU (LeagueClientUx / app-port)       Live Client Data (:2999)       Data Dragon CDN
          |                                      |                            |
  data-sources.js / draft.js          live-data.js / timeline.js      assets.js / champions.js
          |                                      |                    highlights.js / director.js
          +------------------+-------------------+                    post-game.js (frozenSnapshot)
                             v
                 src/main.js   (HTTP 路由 + 轮询 + SSE broadcast)
                             | 写
                             v
              src/app-state.js  <- 唯一状态源 state（单例）
                             | SSE /events + GET /api/state
        +--------------------+--------------------+--------------------+
        v                    v                    v                    v
   consolePage()      bpBroadcastPage()   hudBroadcastPage()   resultBroadcastPage()/transitionPage()
    (控台 /)          (/broadcast/bp)     (/broadcast/hud)     (/broadcast/result, /overlay/transition)
        +--------------------+--------------------+--------------------+
                             v   OBS Browser Source (1920x1080, 透明背景)
                    OBS Studio  <-  obs.js (ws://127.0.0.1:4455, v5)

  electron/main.cjs : spawn src/main.js (ELECTRON_RUN_AS_NODE=1) -> 等 /health 200 -> 开窗口 / 托盘
```

架构要点：
- **零运行时依赖**：`package.json` 只有 devDependencies（electron ^45.3.1、electron-builder ^26.18.0）；服务全用 Node 内置模块（node:http / node:https / crypto / child_process，以及 Node 22 内置 `WebSocket`）。这是 `npmRebuild:false` 和离线可运行的前提。
- **状态单点**：`src/app-state.js` 持有唯一 `state`；`src/main.js` 只负责轮询与写状态，`src/pages/*` 只把状态渲染成 HTML 字符串，不反向写。
- **服务端生成 HTML**：无前端框架、无构建步骤。每个页面是一个返回完整 HTML 字符串的 Node 函数；CSS 由 `/styles.css` 或内联 style 提供；动画用 CSS keyframes + Web Animations API。
- **SSE 而非 WebSocket 推浏览器**：`/events` 首帧即推全量状态，之后每次 `broadcast()` 推全量快照；页面用 `EventSource` 全量重渲染，简单且幂等。
- **OBS 控制旁路**：`src/obs.js` 通过 obs-websocket v5 直连 OBS，与浏览器数据流正交；阶段变化时 `applyAutoScene()` 触发切场景，`lastAutoPhase` 去重。

## 4. 运行形态与端口

| 项 | 值 | 说明 |
| --- | --- | --- |
| 本地 HTTP | `http://127.0.0.1:3210/` | `npm start`/Electron 从 3210 起自增最多 50 个端口；`npm run server` 无自增，需 `PORT` 环境变量 |
| 健康检查 | `/health` | 返回 `{ok:true,mode,phase}` |
| Live Client Data | `https://127.0.0.1:2999` | 仅真实对局开放；`LIVE_CLIENT_URL` 可覆盖 |
| Replay API | `https://127.0.0.1:2999/replay/*` | `REPLAY_BASE` 可覆盖；仅回放 |
| OBS WebSocket | `ws://127.0.0.1:4455` | obs-websocket v5；密码只存内存 |
| 浏览器推流 | `/events`（SSE） | 客户端上限 500，超出逐出最旧 |

OBS 场景包 `RB-BP` / `RB-HUD` / `RB-RESULT` / `RB-TRANSITION` 四个 Browser Source 均为 1920×1080、透明背景、关闭「不可见时关闭」与「激活时重载」，地址分别指向 `/overlay/bp-broadcast`、`/overlay/hud-broadcast`、`/overlay/result-broadcast`、`/overlay/transition`。

## 5. 关键目录

| 路径 | 内容 |
| --- | --- |
| `src/` | 服务端全部逻辑（16 个 .js + `src/pages/` 6 个页面模块） |
| `public/` | 7 个 CSS + `anim.js`；`transitions.css` 是转场页唯一样式源 |
| `electron/main.cjs` | 桌面壳入口 |
| `config/` | `broadcast.example.json`（模板）与 `broadcast.json`（队伍/选手/教练/赞助商/系列赛） |
| `data/` | 运行时产物：`config.json`（0o600）、`champions-16.22.1.json`、`items-16.22.1.json` |
| `docs/` | `USER-GUIDE.md`、`VISUAL-SPEC.md`、`docs/reference/` 两张用户提供的参考图 |
| `tools/` | 假 LCU / 假 Live Client、截图、OBS 场景脚本、观察器 |
| `test/` | 20 个 `node --test` 文件 + `test/fixtures/` 两份真实快照 |
| `README.md` / `DEVELOPMENT_LOG.md` / `REVIEW.md` / `VERIFICATION.md` / `VISUAL-QA.md` | 用户文档、开发日志、第 3 轮代码审查、验证报告、视觉验收 |

## 6. 当前阶段（一句话）

0.2.0 迭代收尾：团队已因审查/修复循环触顶而 escalated、成员已按用户要求全部移除，7 个任务回池 pending；同时用户正在讨论**底部 HUD 重做（一整块 + 中心对称）与 BP 锁定动效**，目前**只做拆解理解、未动任何代码**，等他明确说「开工」。详见 `TASKS.md`。
