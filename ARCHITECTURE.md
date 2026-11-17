# ARCHITECTURE.md — 技术选型、模块关系、设计决策

> 配套：`PROJECT.md`（目标与整体架构）、`CONVENTIONS.md`（编码与接口约定）。最后更新 2026-11-13。

## 1. 技术选型（含选型理由）

| 选择 | 值 | 为什么 |
| --- | --- | --- |
| 运行时 | Node.js >= 18（开发机 v22.14.0） | Node 22 内置 `WebSocket`，用于 obs-websocket v5，避免引入 ws 依赖 |
| 模块系统 | CommonJS（`require` / `module.exports`），文件首行 `'use strict';` | 与 Electron 主进程 .cjs、打包后 spawn 的 src/main.js 一致，无需 ESM 兼容层 |
| HTTP | 原生 `node:http`，无 Express | 只有一个服务、约 30 条路由，零依赖比框架更可控 |
| 浏览器推流 | SSE（`/events`） | 单向服务端→浏览器、浏览器原生 `EventSource` 自动重连；历史上 README 曾误写「WebSocket 实时推送」，已更正 |
| OBS 控制 | obs-websocket v5（Hello/Identify 鉴权、op6 Request、op5 Event） | OBS 28+ 自带；用 Node 22 内置 `WebSocket` 自己实现，5 秒断线重连 |
| 前端 | 服务端拼 HTML 字符串 + 原生 CSS/JS | 页面运行于 OBS Browser Source 与本地控台，无打包步骤、无框架、离线可渲染 |
| 动画 | CSS keyframes + Web Animations API，`prefers-reduced-motion` 降级 | OBS Chromium 兼容、无需依赖、可被 reduced-motion 关闭 |
| 桌面 | Electron 45.3.1 + electron-builder 26.18.0（NSIS） | 托盘常驻、单实例、可双击安装 |
| 打包 | `asar:false`、`electronDist: node_modules/electron/dist`、`npmRebuild:false` | `src/main.js` 需被 spawn 成子服务，asar 内无法直接执行；复用本地运行时免二次下载；零运行时依赖无需 rebuild |
| 测试 | `node --test` + `node:assert/strict` | 内置运行器，无测试框架依赖 |
| 视觉验收 | `tools/shot-overlays.cjs`（Electron offscreen capturePage） | 与 OBS Browser Source 同一 Chromium，能截到透明底真实效果 |

**版本**：`package.json` version = `0.2.3`，Data Dragon `DEFAULT_VERSION = '16.22.1'`（`src/assets.js`）。

## 2. 模块关系

`src/main.js` 是组合根（composition root），require 所有模块；其余模块之间只按需互相引用，页面模块不写状态。

```text
 electron/main.cjs
   └─ spawn -> src/main.js  ─────────────┬─ app-state.js        (state 单例、mock、saveConfig、cue)
                                        ├─ data-sources.js     (requestJson / LCU 发现 / probe / DataDragon URL)
                                        │    └─ champions.js   (英雄表加载与缓存)
                                        ├─ draft.js            (normalizeDraftSession / resolvePicks)
                                        ├─ assets.js           (图标 URL、urlCache、escapeHtml 后的 iconMarkup)
                                        ├─ live-data.js        (normalizeLiveState / estimateTeamGold / 两个 watchdog)
                                        ├─ timeline.js         (buildTimeline / latestTimeline)
                                        ├─ highlights.js       (buildHighlights / handleHighlightsApi)
                                        ├─ director.js         (createDirectorEngine / handleDirectorApi)
                                        ├─ replay.js           (Replay API)
                                        ├─ post-game.js        (buildPostGame / normalizeEogStats)
                                        ├─ obs.js              (ObsClient / handleObsApi / SCENE_PACKAGE)
                                        ├─ broadcast-config.js (readBroadcastConfig / handleBroadcastConfigApi)
                                        └─ pages/
                                             ├─ html.js            (htmlShell / escapeHtml) <- 所有页面
                                             ├─ overlays.js        (旧版 4 页，兼容保留)
                                             ├─ console.js         (控台)
                                             ├─ bp-broadcast.js    (BP 广播页)
                                             ├─ hud-broadcast.js   (局内 HUD 广播页)
                                             └─ result-broadcast.js(赛后页 + 转场页)
 tools/ : fake-lcu.js / fake-live-server.js / shot-overlays.cjs / setup-obs-scenes.js / watch-*.js
 test/  : 每个 src 模块一个 .test.js + e2e.test.js + fixtures/
```

**模块导出契约**（新增处理器时沿用）：API 子处理器统一签名 `handleXApi(req, res, url, context)`，把 `json` / `readBody` / `state` / `broadcast` 等作为 context 注入，便于单测直接调用而不起服务。返回值 `true` 表示该路由已认领。

## 3. 关键数据流

1. **LCU / BP**：`discoverLcuConnection()` 按「启动参数/环境变量 → LeagueClientUx 日志尾部 → WMI 进程命令行 → 缓存端口」找 `app-port` 与 token；`createLcuConnectionManager()` 缓存连接，失败即失效、下一轮 1.2s 重发现（只有发现本身失败才 4s 退避）。每 1.2s 拉 `/lol-gameflow/v1/gameflow-phase` 与 `/lol-champ-select/v1/session`，`normalizeDraftSession()` 只认 `actions` 中 `completed===true` 的 pick/ban；`resolvePicks()` 在 actions 为空或 `FINALIZATION/GAME_STARTING` 时用 `myTeam/theirTeam.championId` 补齐；championId 经 Data Dragon zh_CN 英雄表转中文名。
2. **局内**：每 1s 拉 `/liveclientdata/allgamedata`，`normalizeLiveState()` 产出 10 人名单、队伍比分与目标物计数，写 `state.players` / `state.blue|red`；`createLiveClientWatchdog()` 在 :2999 连续失败 5s 且局内 >=60s 时用 frozenSnapshot 进 post_game。
3. **赛后**：:2999 在结算瞬间关闭，所以局内每秒把 live 数据冻结成 `frozenSnapshot`。LCU 进入 `PreEndOfGame/EndOfGame/WaitForStatsScreen` 时优先拉 `/lol-end-of-game/v1/eog-stats-block`（有金币/伤害/视野/装备），否则用冻结快照（`source='frozen'`）；eog 缺名字时按 championId 从快照补；计算 `damagePct` 与 `kp`。
4. **广播**：任何状态变更后 `broadcast()` 依次执行 `applyAutoScene()`、`runDirector()`（自动导播规则评估）、刷新 `state.obs` 与 `updatedAt`，然后把 `cloneState()` 序列化推给全部 SSE 客户端。`state.broadcastCue` 只保留当前 cue（`seq` 自增），不积累历史。
5. **OBS**：`ObsClient` 用 v5 op6 请求；`SCENE_PACKAGE` 定义独立集合 `RiftBroadcast` 与四个场景；`POST /api/obs/scene-package` 幂等创建/更新；`state.autoSwitch` 保存 `draft/in_game/post_game → 场景名` 映射并持久化。

## 4. 设计决策（含理由，勿轻易推翻）

| # | 决策 | 理由 |
| --- | --- | --- |
| 1 | 只用官方本地接口，禁读内存 | 合规红线；2026-10-06 起 Riot 官方已默认阻止未知第三方读游戏内存，floh22/LeagueBroadcast 因此失效 |
| 2 | LCU token 从 LeagueClientUx 日志取最后一组 `--app-port` / `--remoting-auth-token` | 国服客户端不写 lockfile 且 WMI 拿不到 CommandLine；实测解析耗时 25ms、token 22 位。只解析日志尾部 96–128KB 的命令行行，不写日志 |
| 3 | `state.obsConfig` 用 `Object.defineProperty` 设为不可枚举 | `cloneState() = JSON.parse(JSON.stringify(state))` 会用于 /api/state 与 SSE；不可枚举可保证 OBS 密码绝不回显 |
| 4 | 配置只持久化白名单字段（tournamentName/mode/phase/autoSwitch/obs.url/director），文件 0o600 | 密码只存内存；避免 UI 显示「已保存」但密码落盘 |
| 5 | live 模式初始为空比分、空选手（`initialPlayersForMode('live') → []`） | 实盘模式在真实数据到达前绝不能把演示选手 TopStar/RiftKing 带上直播画面；这是 t28 审查 B1 的根因 |
| 6 | `DEMO DATA` 空态约定：live 且未 parsed 时显示 DEMO 占位，不读 `state.players` | 防止 mock 或上一局数据串到真实直播；页面必须以 `state.live.draft.parsed / state.live.game.parsed===true` 为门槛 |
| 7 | Live Client Data 没有金币字段 → `estimateTeamGold()` 用 `GOLD_WEIGHTS = {cs:20, kill:300, assist:150, passivePerSecond:2.4}` 估算，并置 `goldEstimated / goldSource` 标记 | 不伪造官方金币；live 模式 `blue.gold/red.gold` 为 null。注意：赛事 feed（lolesports livestats）逐人给 totalGold，那是另一个数据源 |
| 8 | BP 只认 `completed===true` 的 actions；BAN_PICK 阶段的 championId 视为悬停值绝不采用 | 真机实测：真实匹配 actionCount=21（10 pick + 10 ban + 1 phase_transition）；自定义对局 actions 零散，阵容只在 myTeam/theirTeam |
| 9 | 目标物归属用 `stripTag()` + 塔名兜底（`Turret_TOrder_*` → 红方、`Turret_TChaos_*` → 蓝方） | 真实事件 `KillerName` 不带 #tag 而 `summonerName` 带，曾导致 6 个 TurretKilled 全部匹配不到人、塔数恒 0:0 |
| 10 | frozenSnapshot 兜底赛后 | :2999 在游戏结束瞬间关闭；没有兜底就取不到结算数据 |
| 11 | SSE 客户端上限 500，逐出最旧；请求体上限 `MAX_BODY_BYTES = 1024*1024` → 413 | 防止长时间运行资源无限增长与超大 body 打爆服务 |
| 12 | Electron 端口从 3210 自增（`PORT_SCAN_LIMIT=50`）、单实例锁、关闭到托盘 | 用户 3210 上常驻另一个服务；不可为换端口去结束别人的进程 |
| 13 | OBS Browser Source 固定 1920×1080、透明、关闭「不可见时关闭」/「激活时重载」 | 切场景时重载会重播入场动画、丢状态 |
| 14 | 转场页 URL 参数驱动（color/accent/direction/duration/mode/preview/debug/noplay），CSS 变量 token | 便于导播在 OBS 里直接改参数、便于截图工具冻结任意帧 |
| 15 | 页面全部走 `htmlShell()` + `escapeHtml()` | 所有广播配置字段来自可编辑 JSON，必须转义，防注入 |

## 5. 状态模型（`src/app-state.js`）

`state` 顶层：`mode`(mock|live)、`phase`(draft|in_game|post_game)、`tournamentName`、`patch`、`gameTime`、`blue/red` {name,short,score,gold,towers,dragons,barons,heralds,logo}、`goldEstimated`、`goldSource`、`draft`、`players[]`、`highlights[]`、`updatedAt`。
由 app-state.js 追加：`live` {lcu,draft,game}（各带 `parsed/source`）、`postGame`、`obs`、`autoSwitch`、`replay`、`broadcastCue` {type,payload,seq,at}、`director`。
由 main.js 追加：`timeline[]`（最多 50）、`highlights[]`、`broadcastConfig`。
`player` 字段：`name, team, champion, level, kills, deaths, assists, cs, wardScore, alive, respawnTimer, items, summoners, position, isBot`。

## 6. 配置与持久化

- `data/config.json`（运行时，0o600）：当前值 `mode=mock, phase=in_game, autoSwitch={draft:'RB-BP',in_game:'RB-HUD',post_game:'RB-RESULT'}, obs.url='ws://127.0.0.1:4455', director={enabled:false,threshold:77,cue:'result-in',cooldownMs:4321,phaseCues:{draft:'bp-in',post_game:'wipe'}}`。
- `config/broadcast.json`（示例见 `broadcast.example.json`）：`teams.{blue,red}` {name,shortName,region,rank,logo,color}、`players[]` {gameName,displayName,team,role,photo}、`coaches[]`、`sponsors[]` {name,image,slot}、`series` {name,stage,patch,bestOf,records}、`fearless` {pbPct,pickPct,wins,losses}。经 `normalizeBroadcastConfig()` 归一化，缺字段回默认值。
- `data/champions-16.22.1.json` / `data/items-16.22.1.json`：Data Dragon 缓存（英雄表缓存 7 天）。

## 7. 已知架构风险

`REVIEW.md`（t28 第 3 轮审查，verdict needs_revision）列出 1 Blocker / 1 High / 5 Medium / 2 Low；其中 Blocker B1' 是 `/api/obs/connect` 的 Promise 链缺外层 `.catch`，>1MB body 或 req error 会触发未处理 rejection 并按 Node 15+ 默认行为终止本地服务（直播全部 overlay 断流）。修复清单与回归要求见 `TASKS.md`。

## 8. 数据来源边界（底部 HUD 重做的关键输入，务必先读）

用户参考图里的「十人逐行 + 三条状态条」是**赛事服 GRID 商业数据**的效果，不是本机 Live Client Data。已核实的字段边界：

| 元素 | Live Client Data（本项目） | lolesports livestats feed | 赛事服 GRID / 内存读取 |
| --- | --- | --- | --- |
| 视野得分 / 等级 / CS / KDA / 英雄 / 装备图标 / 召唤师技能 | 有（`scores.wardScore` 等） | 有 | 内存读取反而拿不到聚合统计 |
| 逐人金币 / 对位经济差 | 无（只有 `activePlayer.currentGold`）→ 默认估算；0.2.3 起可经经济面板 OCR（`tools/pixel-bars/econ_ocr.py`）或 0xdd 协议流拿到逐人真值 | 有 `totalGold/totalGoldEarned`，可真算 | 有，但商业授权 |
| 绿色生命条 | 仅 activePlayer | 有 `currentHealth/maxHealth` 十人 | 内存读取 Health/Max Health（已封） |
| 资源条（蓝/特殊机制/无蓝条英雄） | 仅 activePlayer | 无 | Mana/Max Mana（已封） |
| 紫色经验条 / 分路任务 / 大招就绪圆徽 | 无 | 无（`abilities` 只是加点顺序） | prod-toolkit 曾做出 XP leaderboards（已封） |
| 符文基石 / 装备数量角标 | `items` 被压成 displayName 丢 itemID/count/slot；`runes` 未解析 | 7 个 item id、perkMetadata | 无 |

结论：四缺项（紫经验条、资源条、大招圆徽、分路任务）+ 装备角标语义 + 召唤师技能 CD 现在**没有合规渠道**拿到；参考图是把两类数据源拼在一起的产物。开源项目的做法见 `CHANGELOG.md` 2026-11-13 调研条目与 `TASKS.md` 第 3 节。四缺项建议按 rofllens 的 `verified/candidate/unknown` 三档标注，宁缺毋假。
