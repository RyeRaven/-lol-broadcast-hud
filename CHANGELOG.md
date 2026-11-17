# CHANGELOG.md — 重要修改记录

> 按时间正序。本目录不是 git 仓库，本文件与 `DEVELOPMENT_LOG.md` 是唯一改动时间线。`DEVELOPMENT_LOG.md` 是早期原始日志（保留不动），本文件是后续统一记录。
> 格式：日期 / 阶段 → 改了什么（含文件与行号）、为什么、验证结果。

## 2026-11-12 · 初版 MVP（第一位 agent）

- 建立 `src/main.js`：原生 `node:http` 本地服务（`127.0.0.1:3210`）、SSE `/events`、模拟状态、4 个旧版 Overlay（`/overlay/bp`、`/overlay/ingame-top`、`/overlay/ingame-bottom`、`/overlay/postgame`）、控台 HTML、`/health`、`/api/sources`、`/api/config`、`/api/phase`。
- `src/data-sources.js`：LCU 发现（启动参数 / 环境变量 / lockfile / 进程命令行 / 缓存端口）、Data Dragon URL、`requestJson`。
- `electron/main.cjs` 与 NSIS 打包配置初版；`build-windows.bat`、`start-riftbroadcast.bat`。
- 验证：4 个 Node 测试通过，三个 JS 文件 `node --check` 通过，`/api/sources` 返回 200。
- **遗留阻塞**：国服不写 lockfile、WMI 拿不到 CommandLine，端口能发现但无 token → LCU 401，BP 只能显示模拟数据。日志明确要求「不要声称真实 BP 已接通」。

## 2026-11-12 深夜 · LCU token 与真实数据接通（第二位 agent）

- **`src/data-sources.js`** 新增 `parseUxLog / findUxLogConnections / resolveClientDirs`：只读 LeagueClientUx 日志尾部 96KB 内最后一组 `--app-port` 与 `--remoting-auth-token`；目录优先级 环境变量 → options.clientDir → 已知安装目录（含 `D:/WeGameApps/英雄联盟（含经典模式）/LeagueClient`）→ 最后才 PowerShell 查进程；实测解析 port 52479、token 22 位、耗时 25ms。发现链定型：命令行参数 → 环境变量 → Ux 日志（优先返回能连通 `/lol-gameflow` 的候选）→ WMI → 缓存端口。
- **`src/draft.js`** `normalizeDraftSession()` 改为只认 `actions` 中 `completed===true` 的 pick/ban（未完成的 championId 是悬停值），cellId 0-4 蓝 / 5-9 红；仅 actions 为空时回退 `myTeam/theirTeam`。
- **`src/champions.js`** 从 Data Dragon 拉 zh_CN 英雄表并缓存 7 天（16.22.1，195KB），championId → 中文名。
- **`src/live-data.js`** 接通 `/liveclientdata/allgamedata`：10 人英雄/等级/KDA/补刀/视野分/装备/召唤师技能/存活与复活倒计时；`ORDER→blue / CHAOS→red`；大小龙/塔/先锋按事件 `KillerName` 归属计数。**Live Client Data 没有金币字段**，live 模式 `blue.gold/red.gold` 置 null，不展示假经济。
- **`src/main.js`** 每秒轮询 :2999 并写 state，对局中自动切 `mode=live, phase=in_game`；端到端假 Live Client 验证 `/api/state` → mode=live、10 人、比分 10:11、塔 1:1、红方 1 条小龙。
- **`src/replay.js`**（未实测）封装 `/replay/playback|render|recording|sequence`，字段名对齐 RiotGames/leaguedirector；服务端新增 `GET /api/replay`、`POST /api/replay/camera|playback|sequence`。
- 其他：`electron/main.cjs` spawn 子服务注入 `ELECTRON_RUN_AS_NODE=1`、窗口 URL 与 PORT 共用；`requestJson` 支持 POST body 与空响应体；README 把「WebSocket 实时推送」更正为 SSE。
- 验证：`npm test` 14/14 通过；`node --check` 三个文件通过。

## 2026-11-13 凌晨 · 真机实测修复（第二位 agent）

- 用 `tools/watch-lcu.js` 跟完整两局：自定义对局 actions 只有 3 条零散记录（阵容只在 `myTeam/theirTeam.championId`），真实匹配 actionCount=21（10 pick + 10 ban + 1 phase_transition）全部正确；:2999 在普通对局正常开放（不需要观战席位），事件流完整，英雄名已是中文。
- **`src/draft.js` 新增 `resolvePicks()`**：actions 为空或 `timer.phase∈{FINALIZATION,GAME_STARTING}` 时用 `myTeam/theirTeam.championId` 补齐；BAN_PICK 阶段绝不采用悬停值。真实 BP 快照存 `test/fixtures/session-real-draft.json`。
- **`src/live-data.js` 目标物归属修复**：真实事件 `KillerName` 不带 #tag 而 `summonerName` 带，导致 6 个 TurretKilled 全部匹配不到人、塔数恒 0:0。新增 `stripTag()` 同时登记英雄名/原名/去 tag 名/小写；推塔按塔名兜底（`Turret_TOrder_*` → 红方、`Turret_TChaos_*` → 蓝方）。真实对局回归断言：58 个事件、塔 2:4、龙 1:1、先锋 0:1。
- **赛后数据**：:2999 在结算瞬间关闭 → `src/main.js` 局内每秒冻结 `frozenSnapshot`；LCU 进 `PreEndOfGame/EndOfGame/WaitForStatsScreen` 时优先 `/lol-end-of-game/v1/eog-stats-block`（`src/post-game.js` 归一化），拉不到用冻结快照（`source=frozen`）；eog 缺名字按 championId 补；算 `damagePct` 与 `kp`。
- **`src/obs.js`**：用 Node 22 内置 `WebSocket` 实现 obs-websocket v5（Hello/Identify、`GetSceneList`、`GetCurrentProgramScene`、`SetCurrentProgramScene`、`CurrentProgramSceneChanged`、5s 重连）；新增 `GET /api/obs`、`POST /api/obs/connect|scene|autoswitch`；`state.autoSwitch` 阶段→场景映射，`lastAutoPhase` 去重；控台加「OBS 场景控制」与「回放镜头（仅录像）」面板。
- 验证：`node --test` 24 例全绿（真实 BP 快照、真实 live 事件快照、post-game 归一化、OBS 鉴权）。

## 2026-11-13 凌晨 · Electron 打包与安装包验证

- **`electron/main.cjs` 重写**：端口从 `PORT||3210` 起 `net.createServer().listen` 逐个探测最多 50；以 `process.execPath + ELECTRON_RUN_AS_NODE=1` 启动 `src/main.js`；等 `/health` 200（20s 超时）后开窗；`app.requestSingleInstanceLock()`；内嵌 32×32 PNG 托盘图标与菜单；关闭窗口 `preventDefault()+hide()`，`before-quit/will-quit` 用 `taskkill /pid <pid> /t /f` 结束子服务；`RIFTBRIDGE_SMOKE=1` 冒烟输出。
- **`package.json` build**：`asar:false`、`electronDist: node_modules/electron/dist`、`npmRebuild:false`、`files` 增 `data/**/*`、NSIS 非 oneClick 可改目录；新增 `npm run dist:dir`；`build-windows.bat` NSIS 失败自动回退。
- 验证：`npm run dist` 成功（electron-builder 26.18.0 / Electron 45.3.1 x64），产物 `release/RiftBroadcast Setup 0.1.0.exe` 242,291,637 字节（≈231 MiB）与 `release/win-unpacked/RiftBroadcast.exe`；`node --test` 31/31；开发模式与打包版冒烟均自动选 3211、URL/托盘/关闭到托盘正确；NSIS 静默安装与卸载返回 0。未代码签名，SmartScreen 提示属预期。**注意：`package.json` 已是 0.2.0，但产物名仍是 0.1.0，发布前需统一（见 `TASKS.md`）。**

## 2026-11-13 凌晨 · OBS 深度集成

- **`src/obs.js`** 扩展 v5 请求：`GetRecordStatus/StartRecord/StopRecord`、`GetStreamStatus/StartStream/StopStream`、`SaveReplayBuffer`、`GetInputList/CreateInput/CreateBrowserSource`、`GetSceneItemList`、场景集合管理、`CreateScene/SetInputSettings`；统一 op7/op5 处理与状态映射。
- **`src/main.js`** 新增 `/api/obs/record`、`/api/obs/stream`、`/api/obs/replay-buffer`、`/api/obs/sources`、`/api/obs/scene-package`；未连接统一 200 `{ok:false,error:'obs_not_connected'}`。
- 验证：`node --test` 48/48（`test/obs.test.js` 覆盖 authString、状态映射、op6 请求形状、FakeObsWebSocket 握手）；真实 OBS 32.2.2 + obs-websocket 5.7.4：创建集合 RiftBroadcast（BP/局内/赛后 三场景 + 三个 1920×1080 browser 源），验证后切回原集合 `2`；StartRecord 2.566s → StopRecord，outputActive=true、outputBytes=54838、生成 63404 字节 mkv 后删除；为安全约束未启动推流、未调 SaveReplayBuffer。

## 2026-11-13 凌晨 · OBS 四场景包与自动切换

- **`src/obs.js` `SCENE_PACKAGE`** 定型：集合 `RiftBroadcast`、场景 `RB-BP`/`RB-HUD`/`RB-RESULT`/`RB-TRANSITION` → `/overlay/bp-broadcast`、`/overlay/hud-broadcast`、`/overlay/result-broadcast`、`/overlay/transition`；每源 1920×1080、透明、`shutdown_when_not_visible=false`、`restart_when_active=false`；`createScenePackage()` 复用已有输入源并更新设置，返回 autoSwitch 映射；`POST /api/obs/scene-package` 支持 `payload.autoSwitch` 并 `saveConfig()` 持久化。
- **新增 `tools/setup-obs-scenes.js`**（零依赖、幂等）：`--obs-url`、`--password`/`OBS_PASSWORD`、`--app-url`、`--base-url`、`--collection`、`--restore-original`、`--skip-autoswitch`、`--json`；`package.json` 增 `npm run setup-obs`。
- 验证：`test/obs.test.js` 12/12；真实 OBS 逐项验证 url/1920×1080/透明/不重载/场景项全部通过、failures=[]，验证后切回原集合 `2`/场景 `场景`，用户原集合未改动。

## 2026-11-13 · 团队迭代 0.2.0（t1–t37）

- **模块化（t1）**：`src/main.js` 263→207 行，拆出 `src/app-state.js` 与 `src/pages/{html,overlays,console}.js`；6 路由全 200，24/24。
- **视觉升级（t2）**：新增 `src/assets.js`（Data Dragon 16.22.1 英雄/装备/召唤师技能 URL、urlCache、首字母离线兜底），重做 4 个旧版 Overlay；`public/styles.css` 透明 1920×1080；44/44。
- **数据健壮性（t4）**：`src/timeline.js` 事件时间线（上限 50）；`data-sources.js` 改读 Ux 日志头部 128KB 只解析 `Command line arguments` 行（忽略 Cef 诱饵，真实 934199 字节日志解析出端口 62742）；`live-data.js` 增 `createLiveClientWatchdog()`（:2999 连续失败 5s 且局内 ≥60s → frozenSnapshot 进 post_game）；44/44。
- **控台重做（t3/t9/t30/t37）**：`src/pages/console.js` + `public/console.css` 三栏（322/1140/390px）、10 人 KDA 名单（`renderRoster/#rosterBody`）、30 条事件流、健康灯、MOCK 黄 `#ffd23f` / LIVE 绿、堆叠阈值 1279px；`node --test` 104/104；Electron 1920/1200 实测无横向滚动、切 LIVE 98ms / MOCK 86ms。
- **广播配置（t12/t21）**：`src/broadcast-config.js` + `config/broadcast.example.json`（teams/players/coaches/sponsors/series/fearless）；控台 JSON 编辑器与快捷键 1/2/3/4/Esc。
- **动画端（t13–t15/t19）**：`src/pages/bp-broadcast.js`、`hud-broadcast.js`、`result-broadcast.js` 三页 + `public/transitions.css` 转场页；`public/anim.js`（`tweenNumber/staggerIn/sceneWipe`）；`BROADCAST_CUE_TYPES` 与 `/api/broadcast/cue`；自动导播规则引擎 `src/director.js`（`t31`）与面板（`t37`）；经济估算 `GOLD_WEIGHTS`（`t25`）、精彩事件评分（`t26`）。
- **视觉验收（`t29` / `VISUAL-QA.md`）**：`/broadcast/bp` 1366×768 底部横带溢出 21px、角色行/PATCH 不可见 → needs_revision；HUD/result/transition 两分辨率 pass。`t33` 修 BP 1366 适配、横带比例与 DEMO 空态。
- **验证（`t7` / `VERIFICATION.md`）**：`node --test` 54/54、e2e 2/2、`node --check` 通过；端口只扫 3212–3219，未触碰 3210。
- **代码审查（`t28` / `REVIEW.md`）**：第 3 轮 verdict=`needs_revision` → failed；1 Blocker B1'（`/api/obs/connect` Promise 链无 .catch 可杀服务）、1 High H1（live 假数据/旧 postgame 未闭环）、5 Medium（M1 UTF-8 跨 chunk、M2 saveConfig 空 catch、M3 OBS refresh、M4 三个 setInterval 重叠、M5 shell.openExternal 无白名单）、2 Low（L1 splash 缓存键、L2 SSE 空 catch）。缺陷清单与 requiredFix 见 `TASKS.md` 2.1 节。
- 团队状态：review/repair 自动循环触顶 → `escalated=true`；按用户「把动画效果给我看就行」要求 remove 全部 6 个 hy4 成员、停止子任务；t8/t24/t28/t32/t34/t35/t36 七个任务回池 pending。

## 2026-11-13 · 动画效果预览交付（用户「把动画效果给我看就行」）

- 采集链：`.tmp/anim/capture.cjs`（Electron 重启模式：spawn 前 `delete env.ELECTRON_RUN_AS_NODE`、`windowsHide`、`stdio inherit`；`app.disableHardwareAcceleration`；`BrowserWindow 1920×1080 show:false`、`webPreferences.offscreen:true`、`setFrameRate(30)`、`webContents.invalidate()` 强制重绘）；`.tmp/anim/assemble.py`（PIL，1024×576 LANCZOS、ADAPTIVE 128 色、ping-pong 往返、msyh.ttc 中文标签）。
- 交付 4 个成品并 present：`riftbroadcast-anim-wipe-left.gif`（4.48MB / 20 帧）、`riftbroadcast-anim-wipe-pass-up.gif`（1.72MB / 20 帧）、`riftbroadcast-anim-hud-entrance.gif`（0.55MB / 10 帧）、`riftbroadcast-anim-overview.png`（2058×1868 六宫格，1.96MB）。
- 四个已解决的技术坑（复用采集器时必读）：① 转场页 `html/body` 透明 → 直截图全白，需注入演播室径向渐变底，且背景样式必须 **appendChild 到 document.body 末尾**并提高特异性（`html.tr-html body.tr-body` 等各自带 !important），去掉 `background-attachment:fixed`（软件渲染失效）；② 隐藏窗口 `getAnimations().currentTime` 在合成器动画上不生效，改为「移除 `tr-play` → 内联 `animationPlayState:paused + animationDelay:-Pms + animationDuration:1000ms` → 重放」；③ `capturePage` 会抓最后一次绘制的旧帧，需 `offscreen:true + setFrameRate(30) + invalidate()`；④ 背景样式挂 head 会因特异性输给 `background:transparent`。47 帧全部 OK，后台 mock 服务 job 已全部 killed。

## 2026-11-13 · 底部 HUD 重做：拆解与数据源调研（**只讨论，未改代码**）

- 用户 m03093 / m03113 / m03130 / m03161 提出：BP 页英雄锁定需动效；局内 HUD 底部要一整块、按参考图比例、双方中心对称；只保留下方积分版 + 左塔赛事信息 + 广告牌（后两者做成可编辑），舍弃摄像头、游戏自带英雄状态与小地图；逐条确认了 8 个元素语义（视野得分、消耗/叠层角标、符文基石+分路任务/召唤师技能两列、大招圆徽、三条状态条、对位经济差、先讨论 HUD、装备符文能否抓到）。
- 尺寸实测：2332×1309 参考图 → HUD 顶边 y≈990、高 ≈319px（24.4% 屏高、7.3:1）；1920×1080 下 y≈817、高 ≈263px；5 行每行 63px；记分板居中 x≈1166。脚本 `.tmp/hud_measure.py`/`hud_measure2.py`；坑：必须用 `acp_read_original_image` 恢复原图，归一化副本会全图全暗。
- 数据源查证（结论 + 出处）：项目早已接 Live Client Data，但 `items` 被压成 displayName 丢 itemID/count/slot、`runes` 未解析、`summoners` 丢 id；官方 `abilities/championStats` 只在 activePlayer 一人，无经验值/逐人金币/分路任务；赛事服 GRID 独家商业分发；Riot 2026-10-06 起默认阻止第三方读游戏内存（floh22/LeagueBroadcast 失效）；LHM.gg 用 OCR 读 Tab 记分板（`"For most of the data, we use OCR"`）；RCVolus/league-prod-toolkit 靠 Farsight 被动内存读取做 Custom Scoreboard 与 XP 榜但已受影响且只是「盖在游戏自带记分板上」；lolesports livestats feed 逐人给 `totalGold/currentHealth/maxHealth` 但非官方、仅正式赛事、约 10 分钟延迟；ss26367098/rofllens 的 `verified/candidate/unknown` 三档是「宁缺毋假」最干净范例；lzskyline/LeeSin 的 LCU champ-select 监听可作 BP 锁定动效触发源参考；RiotGames/leaguedirector 是官方 Replay API 参考实现（赛后）；SolitudeRA 导播手册的三张占位图印证「英雄状态与小地图游戏自带、舍弃」；RiftBroadcast.de 是同名商业 SaaS 而非本项目。
- 结论：四缺项（紫经验条、资源条、大招圆徽、分路任务）无合规渠道；「一整块 + 中心对称 + 十人逐行」无开源实现可抄，需从零做；数据路线 A/B/C/D 与 5 个待拍板项见 `TASKS.md` 3.5 节。**等用户明确说「开工」才动手。**

## 2026-11-13 · 交接文档（本次，m03265）

- 用户「我要换模型了，你给我写这些文件便于切换模型维护」→ 新建 `PROJECT.md`、`ARCHITECTURE.md`、`TASKS.md`、`CONVENTIONS.md`、`CHANGELOG.md` 五份文档，事实全部从 `README.md`、`DEVELOPMENT_LOG.md`、`REVIEW.md`、`VERIFICATION.md`、`VISUAL-QA.md`、`docs/`、`config/`、`package.json`、`src/` 源码与团队任务状态核实。**未改动任何源码、未动团队任务。**

## 2026-11-14 ~ 11-16 · Khada Jhin 0.2.x：HUD 重做、0xdd 解码链、血条像素流、GitHub 开源

- **改名与版本**：全面改名 Khada Jhin（原 RiftBroadcast），0.2.1 应用图标（build/icon.ico + public/app-icon.png），现 version 0.2.2；内部事件名前缀 riftbroadcast: 保留。
- **底部 HUD 一整块落地**：中心对称积分版 + .hb-native-hole 原生洞位像素校准（.tmp/hole-probe.cjs）+ 防闪烁 setHtml 守卫（.tmp/hud-flicker-check.cjs 两帧像素差 0.036%）+ 分路排序（src/draft.js cellId→assignedPosition）。
- **HUD 数据接入**：修复 post_game 赛后快照锁死管线（src/main.js pollLiveClient 新局自动解锁）；KDA/等级/顶部栏确认早已具备渲染端；龙/塔改事件增量账本（src/live-data.js createObjectiveLedger+accumulateObjectives，身份键去重只增不减）；新增 logLcdaEvents → .tmp/lcda-events.jsonl。
- **0xdd 解码链（tools/decode0dd/）**：decode_statblocks.py v12（残差分表 PERIOD=64，真值局 300/300 floor-exact）；live_feed.py 纯 stdlib Blowfish-ECB 过 schneier 官方向量 + Observer REST + LiveSolver live-sim 全绿；replay_feed.py LCDA 同步回放喂流器（实测回放局金币/经验进 HUD）；契约 docs/PROTOCOL-FEED.md + src/protocol-feed.js（precision=exact 才转发）+ docs/DECODE-CAPABILITY.md 白皮书。
- **血条像素流**：tools/pixel-bars/hp_bars.py（OBS GetSourceScreenshot 游戏采集源、侧栏游程检测、EMA、10Hz POST）+ src/pixel-bars.js（TTL 2s 整包替换）+ hud-broadcast.js pixelBars 消费端；实机标定 2560 蓝 gx0=42/红 gx0=116 全命中。
- **修复与教训**：LCDA(2999) 是自签 TLS 服务，http 裸请求挂起（曾误判死锁错杀进程两次），有效端点仅 /liveclientdata/allgamedata；fixture 事件里名字段也要匿名化。
- **GitHub 开源（2026-11-16）**：git init + GitHub 公开库 https://github.com/RyeRaven/-lol-broadcast-hud.git（仓库名带前导连字符），main=ef6ee23，GPL-3.0，338 文件；.gitignore 剔除 release/.tmp/shot-profile/缓存；fixture 10 个真实 Riot ID → Player1..Player10（128 处，含 events 名字段）；敏感扫描 0 命中；本机 niugit 无 GCM/gh，push 用一次性凭证 URL。
- **验证**：node --test 195/195。
- **待办**：见 TASKS.md §3（live_feed 实机验证、潮虫事件名验证、CS 口径、A 键、0.2.3 打包、控台 UI）。

## 2026-11-16 ~ 11-18 · Khada Jhin 0.2.3：控台分阶段重构、HUD 精修、经济面板 OCR

- **控台分阶段视图**：首页/等待/BP/局内/赛后/设置独立成页（`.c2-*` 信息架构），系列赛大分与局内比分分开（`src/series.js` + `/api/series/*`），模拟数据改一整场剧本（暂停/重播/调速，`src/mock-demo.js`），模拟与真实模式彻底分离、控台图标化；「结束这轮比赛」改两段式确认（Electron 内嵌浏览器吞 `window.confirm`），未开打的比赛按取消处理。
- **模拟 BP 修复**：模拟模式下 BP 不再被 LCU 轮询清空（仅 `mode==='live'` 才轮询 draft），OBS pick 只认选人顺序。
- **MVP 时刻页**改「数据牌」方向 B 并落地生产（1920×1080 整页缩放）；MVP 发送自动切 RB-MVP OBS 场景。
- **HUD**：装备栏默认自绘（原生 X 面板会顶掉原生装备栏）、装备格/数量角标/视野分多轮精修、名字与 KDA 贴头像侧、名字固定 100px 预算；HUD 布局编辑器（可视化拖拽 + 保存即推送给已连接 HUD）。
- **经济面板 OCR（新数据链路，0.2.3 主打）**：`tools/pixel-bars/econ_ocr.py` 同机 OBS 截屏解析游戏内经济面板白色「当前(总)」金币——白掩膜 → 连通域/XY-cut 切字 → 89 模板 IoU 匹配（字形高度归一化，不钉分辨率与坐标）→ `N(M)` 结构校验，1Hz POST `/api/econ-ocr`（仅 127.0.0.1 + TTL 2s，同 pixel-bars 模式）→ capability `totalGold` 升 `exact('econ-ocr')` → HUD 对位经济差优先真值、失败回退估算并如实标注；模板库 `digit_templates.npz` 89 字形 LOOCV 89/89，用户真图十格全对（与 LCU timeline 真值一致）。
- **赛后金币真值曲线**：LCU match-history timeline 逐帧逐人 `totalGold` 画进赛后页（误差 0）。
- **验证**：`node --test` 250/250（0.2.2 时 195）；打包冒烟（RIFTBRIDGE_SMOKE，win-unpacked 实机启动，PORT=3315）全过——url/title/port/tray/tray-menu/dom（98 个按钮）/close-to-tray 七项断言通过，冒烟后自退。
