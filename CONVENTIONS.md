# CONVENTIONS.md — 编码规范与接口约定

> 最后更新 2026-11-13。改动代码前先读本文件；新增路由/模块/页面时沿用既有形状。

## 1. 代码风格

- 全部 CommonJS：`'use strict';` 置于文件首行；`require()` 引入、`module.exports = { ... }` 具名导出（不导出默认对象、不用 ESM）。
- 2 空格缩进、单引号、语句末分号、驼峰命名；文件名小写中划线（`broadcast-config.js`）。Electron 主进程固定 `electron/main.cjs`（.cjs 后缀）。
- 文件开头写 1–2 行中文注释说明该模块职责（如 `src/app-state.js` 的「应用状态：初始值、mock 数据与配置持久化」）。
- 零运行时依赖：只用 Node 内置模块（`node:http/https`、`node:fs`、`node:path`、`node:crypto`、`node:child_process`、`node:net`、`node:test`、`node:assert/strict`）。新增外部依赖前先确认是否真的必要；OBS 客户端用的是 Node 22 内置 `WebSocket`。
- 纯函数优先、依赖注入：API 子处理器统一 `handleXApi(req, res, url, context = {})`，`context` 注入 `{ json, readBody, state, broadcast, saveConfig, ... }`，返回 `true` 表示路由已认领。这样单测可直接调用而不起 HTTP 服务。
- 不要复制粘贴补丁式修复；用户明确要求「从根因解决问题」。同一逻辑只在一处实现（如归一化统一放 `normalizeXXX()`）。

## 2. HTTP 接口约定

- 统一响应助手 `json(res, code, body)`：`Content-Type: application/json; charset=utf-8`、`Access-Control-Allow-Origin: *`、`if (res.headersSent) return;` 防重复响应。
- 响应形状：成功 `{ok:true, ...}`；失败 `{ok:false, error:'<snake_case_code>'}`。已知码：`invalid_phase`、`invalid_mode`、`invalid_scene_name`、`invalid_auto_switch`、`invalid_tournament_name`、`invalid_cue_type`、`method_not_allowed`、`payload_too_large`、`obs_not_connected`。
- 状态码：参数非法 400（用 `badRequest(message)`，它会给 error 挂 `statusCode=400`）；body > 1MB → 413 `payload_too_large`；方法不对 405；OBS 未连接时相关接口统一 **HTTP 200 + `{ok:false,error:'obs_not_connected'}`**（不是 500，便于控台识别）；其他 OBS 错误 500。
- `readBody(req, res)`：`MAX_BODY_BYTES = 1024*1024`；`content-length` 预检与分块累加双重限制；超限先发 413 再 reject。**注意现有缺陷 M1**：`raw += chunk` 把 Buffer 拼字符串会损坏跨 chunk 中文，且 `JSON.parse` 失败静默 `resolve({})`；修复见 `TASKS.md`。
- **每个 `.then()` 链必须有 `.catch()`**：Node 15+ 默认 `--unhandled-rejections=throw`，本仓库没有全局兜底，一条漏掉的 Promise 链会杀掉整个本地服务（B1' 就是这么来的）。新写入口应补 `process.on('unhandledRejection')` / `uncaughtException` 日志。
- 输入一律走白名单归一化：`normalizePhase()` 只接受 `draft|in_game|post_game`；`normalizeAutoSwitch()` 只取 `draft/in_game/post_game` 且字符串 ≤128；`normalizeSceneName()` 非空且 ≤128；`normalizeTournamentName()` ≤80；`/overlay/:type` 用 `OVERLAY_TYPES = ['bp','ingame-top','ingame-bottom','postgame']` 白名单；`/styles.css` 固定路径，不拼用户输入。
- 环境变量：`PORT`、`LIVE_CLIENT_URL`、`REPLAY_BASE`、`RIOT_CLIENT_COMMAND_LINE`、`RIOT_LCU_PORT`、`RIOT_REMOTING_AUTH_TOKEN`、`RIOT_LOCKFILE`、`RIOT_LEAGUE_CLIENT_DIR`、`OBS_PASSWORD`、`RIFTBRIDGE_SMOKE`、`RIFTBRIDGE_SMOKE_REPORT`、`ELECTRON_RUN_AS_NODE`。不要把 token / OBS 密码写进代码、日志或仓库。

### 2.1 完整路由表（`src/main.js`）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/health` | `{ok:true,mode,phase}` |
| GET | `/api/state` | `cloneState()` 全量状态（obsConfig 不可枚举，不回显） |
| GET/POST | `/api/broadcast/cue` | 广播 cue；类型 `bp-in / hud-in / result-in / wipe / reset` |
| GET/POST | `/api/broadcast-config` | 读/写 `config/broadcast.json` |
| GET/POST | `/api/director/rules` | 自动导播规则 |
| GET | `/api/highlights` | 精彩事件 |
| GET | `/api/sources?refresh=1` | LCU / Live Client 探测结果 `{results,live}` |
| GET | `/api/datadragon-url?version=&kind=&id=` | 返回 `{url}`；只拼 CDN URL，不读文件 |
| GET | `/api/replay`；POST `/api/replay/camera`、`/api/replay/playback`、`/api/replay/sequence` | Replay API |
| GET | `/api/obs`；POST `/api/obs/scene`、`/api/obs/autoswitch` | OBS 快照 / 切场景 / 自动切换映射 |
| `/api/obs/*` | `/api/obs/connect`、`/api/obs/record`、`/api/obs/stream`、`/api/obs/replay-buffer`、`/api/obs/sources`、`/api/obs/scene-package` | 由 `handleObsApi()` 分发 |
| GET | `/events` | SSE |
| POST | `/api/phase` | `{phase}` 切阶段 |
| POST | `/api/config` | `{tournamentName, mode, phase}` |
| GET | `/` | 控台 `consolePage(PORT)` |
| GET | `/overlay/bp-broadcast` 或 `/broadcast/bp` | BP 广播页 |
| GET | `/overlay/hud-broadcast` 或 `/broadcast/hud` | 局内 HUD |
| GET | `/overlay/result-broadcast` 或 `/broadcast/result` | 赛后庆典 |
| GET | `/overlay/transition` | 转场页 |
| GET | `/overlay/{bp,ingame-top,ingame-bottom,postgame}` | 旧版 4 页，兼容保留 |
| GET | `/styles.css` | 控台与旧版页面样式 |

### 2.2 SSE 约定

`/events` 响应头 `Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`、`Access-Control-Allow-Origin: *`；**首帧立即推一份完整状态快照**，格式为 `data: <cloneState() 的 JSON>\n\n`；之后每次 `broadcast()` 推全量快照（不是增量 diff）。`clients` 是 Set，`MAX_SSE_CLIENTS=500`，超过时 `addSseClient()` 逐出最旧；`broadcast()` 对每个客户端 try/catch 清理；`req.on('close')` 删除。页面侧 `EventSource` 的 `onmessage` 必须非空 catch（当前 L2 缺陷是 4 处空 catch）。

## 3. 状态与配置约定

- `state` 单例来自 `src/app-state.js`；任何修改后调用 `broadcast()`，需要持久化时调用 `saveConfig()`。**`live` 模式初始必须为空比分/空选手**，不得把 mock 数据带上直播。
- `cloneState() = JSON.parse(JSON.stringify(state))`；`state.obsConfig` 用 `Object.defineProperty` 设为不可枚举，保证密码不回显。
- `saveConfig()` 只写白名单字段 `{tournamentName, mode, phase, autoSwitch, obs:{url}, director}` 到 `data/config.json`，`{mode:0o600}` + `chmodSync(0o600)`；**密码绝不落盘**。空 catch 是已知缺陷 M2，改时一并修。
- 枚举：`mode ∈ {mock, live}`；`phase ∈ {draft, in_game, post_game}`；`BROADCAST_CUE_TYPES = Object.freeze(['bp-in','hud-in','result-in','wipe','reset'])`；队伍 `blue=ORDER / red=CHAOS`；`OVERLAY_TYPES` 见上表。
- `state.broadcastCue` 只保留当前 cue（`{type,payload,seq,at}`，`seq` 自增），不积累历史；`state.timeline` 最多 50 条、`highlights` 有上限，防止长时间运行无限增长。
- `config/broadcast.json` 所有字段经 `normalizeBroadcastConfig()` 归一化、缺值回默认；页面渲染取自可编辑 JSON 的字段必须过 `escapeHtml()`。

## 4. 页面 / 样式 / 动画约定

- **一切页面按 1920×1080 设计**；`html, body` 透明背景（OBS 透明底），页面根容器负责自己的底板；1366×768 需保证关键行不裁切（BP 页此处曾溢出 21px）。
- 所有页面经 `htmlShell(title, body, scripts)` 生成；`htmlShell` 对 body/scripts 做 `typeof==='string'` 校验，title 与 `escapeHtml()` 转义 `&<>"'`。
- 视觉 token（`docs/VISUAL-SPEC.md`）：`--bg:#05070a; --panel:#0b0f14; --cyan:#22d3ee; --blue:#3b82f6; --red:#ef4444; --gold:#f5c451; --text:#e5e7eb; --muted:#94a3b8`。转场 token（`public/transitions.css`）：`--tr-color:#22d3ee --tr-accent:#f5c451 --tr-duration:350ms --tr-ink:#05070a`。
- **DEMO 空态约定**：mock 模式显示 `DEMO DATA`；live 模式仅当 `state.live.draft.parsed===true`（BP）或 `state.live.game.parsed===true`（HUD）才读真实数据，否则用 `config/broadcast.json` 名单占位并显示 `DEMO DATA` / `DEMO · 等待比赛数据`；赛后 `postGame===null` 时显示「赛后数据不可用 / DEMO」，**绝不回退 mock 比分**。这是 t28 B1/H1 的根因防线。
- 动画用 CSS keyframes + Web Animations API；全部包在 `@media (prefers-reduced-motion: reduce)` 下降级（转场页 `.tr-layer{animation-duration:1ms!important}`，`anim.js` 的 `tweenNumber/staggerIn/sceneWipe` 在 `prefersReducedMotion()` 时直接跳终值）。
- 转场页（`/overlay/transition`）URL 参数：`color`、`accent`、`direction=left|right|up|down`、`duration=100..2000`、`mode=cover|pass`、`preview`（paused + 负延迟定帧）、`debug`、`noplay`（立即加 `tr-play`）；`mode=pass` 在 `play()` 内 `setTimeout(duration+80)` 移除 `tr-play`；`RBTransition.play()` 可重放；SSE cue `wipe/transition` 触发。样式只来自 `public/transitions.css`（注入在 body 末尾，注意选择器特异性，head 里的同特异性 !important 会输给 `body{background:transparent}`）。
- 页面内 `EventSource` / fetch 必须有异常兜底；控台三个轮询 interval 需判 `document.visibilityState !== 'hidden'`。

## 5. 测试与验证约定

- `npm test` = `node --test`；测试文件 `test/<模块>.test.js` 一一对应；真实数据快照放 `test/fixtures/`（`session-real-draft.json`、`live-real-game.json`）。
- 断言用 `node:assert/strict`；端到端用 `tools/fake-lcu.js` 与 `tools/fake-live-server.js` 起假服务。
- **端口隔离**：e2e 只扫 3212–3219，全部占用则快速失败；**绝不访问/重启/关闭 3210**（用户常驻服务），也不触碰 3215 上其他进程。临时服务用完即停。
- 每次改动后：`npm test` + `node --check src/main.js`、`node --check src/data-sources.js`、`node --check electron/main.cjs`；视觉改动用 `npm run shot -- --base-url http://127.0.0.1:3211 --out .tmp/shots` 出 1920×1080 PNG 与 manifest。
- 真实客户端 / 真实 OBS / 安装包需人工验收，文档中须注明「未实测」而不是声称已验证；未看到具体 .exe 前不要声称安装包已生成。

## 6. 安全约定

- LCU token 与 OBS 密码只在内存；不写日志、不写 `data/config.json`、不进仓库。`/api/sources` 只回 `{ok,source,phase,port,discovery,reason}`，不含 password。
- 本地服务只监听 `127.0.0.1`；`json()` 与 `/events` 目前带 `Access-Control-Allow-Origin: *`，这意味着任意网页可用简单请求打本地接口（B1' 的远程触发面），新接口不要放宽，修 B1' 时一并评估。
- 页面注入面：`htmlShell/escapeHtml`、`OVERLAY_TYPES` 白名单、`/styles.css` 固定路径；`electron/main.cjs` 的 `shell.openExternal` 需补 http/https scheme 白名单（M5）；保持 `contextIsolation:true, sandbox:true`。
- 合规红线见 `PROJECT.md` 第 1 节，任何「读内存 / OCR 观战画面 / 模拟操作」的提议都先确认是否触碰红线。

## 7. 文档约定（每类改动写哪里）

| 改了什么 | 更新哪个文件 |
| --- | --- |
| 重要改动 / 修复 / 里程碑 | `CHANGELOG.md`（按日期倒序或正序补一条，写清文件行号与验证结果） |
| 架构决策、模块增删、技术选型变化 | `ARCHITECTURE.md` |
| 任务状态、待办、阻塞、开放问题 | `TASKS.md` |
| 接口/枚举/规范变化 | `CONVENTIONS.md` |
| 目标或功能范围变化 | `PROJECT.md` |
| 用户操作说明、OBS 配置、排障 | `docs/USER-GUIDE.md`、`README.md` |
| 视觉排版与动画规格 | `docs/VISUAL-SPEC.md` |
| 审查结论与缺陷清单 | `REVIEW.md`；验证结果 `VERIFICATION.md` / `VISUAL-QA.md` |
| 历史开发日志（旧） | `DEVELOPMENT_LOG.md`（保留不改，新记录写 `CHANGELOG.md`） |
