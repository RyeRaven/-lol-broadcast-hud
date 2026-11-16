# RiftBroadcast 开发交接日志

更新时间：2026-11-12

## 项目目标

RiftBroadcast 是 Windows 本地《英雄联盟》赛事导播辅助软件，将 LCU、Live Client Data API 和 Data Dragon 数据转换成 OBS Browser Source 可采集的赛事 Overlay。核心页面是赛前 BP、局内顶部比分条、局内底部十人选手条、赛后数据页。必须遵守：不读游戏内存、不注入、不修改游戏文件、不绕过反作弊、不模拟游戏操作。

## 项目目录

根目录：`C:\Users\RyeRaven\Documents\Codex\2026-11-12\windows-lol-mvp-1-lol-2`

- `electron/main.cjs`：Electron 桌面入口，自动启动本地服务并打开控台。
- `src/main.js`：Node HTTP 服务、模拟状态、Overlay HTML、控台 HTML、SSE 推送、LCU 轮询。
- `src/data-sources.js`：LCU、Live Client、Data Dragon、启动参数和客户端缓存探测。
- `public/styles.css`：控台和 Overlay 样式。
- `test/`：Node 内置测试。
- `data/`：运行时配置。
- `build-windows.bat`：自动进入项目目录并执行安装和打包。
- `start-riftbroadcast.bat`：自动进入项目目录启动。

## 技术栈

Node.js >= 18，Electron 45.3.1，electron-builder 26.18.0，原生 Node HTTP，不使用 Express，SSE 地址为 `/events`，本地服务为 `127.0.0.1:3210`。

## 已完成

- 控台：`http://127.0.0.1:3210/`
- BP：`/overlay/bp`
- 局内顶部：`/overlay/ingame-top`
- 局内底部：`/overlay/ingame-bottom`
- 赛后：`/overlay/postgame`
- 模拟比赛时间、经济、击杀、补刀和等级变化。
- 阶段切换：`draft`、`in_game`、`post_game`。
- 配置保存、健康检查、统一状态和 SSE。
- 支持 `--app-port`、`--remoting-auth-token`、环境变量和旧 lockfile。
- 自动查询 LeagueClient/RiotClient 进程。
- 自动扫描客户端缓存寻找本地 LCU 端口。
- 轮询 Gameflow，ChampSelect 时请求 `/lol-champ-select/v1/session`。
- Electron 启动入口和 NSIS 打包配置。

## 国服真实测试结论

用户实际打开国服客户端并进入 BP 后，发现：`LeagueClient.exe` 正在运行，本机缓存能发现 `https://127.0.0.1:50052`，访问该端口的 Gameflow API 返回 `401 Unauthorized`。这证明端口有效，但当前环境无法通过普通 WMI 查询拿到进程 CommandLine，因此没有获得 `--remoting-auth-token`。

当前 BP 页面仍可能显示模拟数据。原因是 LCU 认证未通过，不是 UI 没刷新。程序现在应明确显示“已找到 LCU 端口，但缺少 remoting-auth-token”。不要声称真实 BP 已接通。

## 当前关键阻塞

### LCU token（已解决，见文末 2026-11-12 深夜更新）

国服不写 lockfile，进程 CommandLine 为空。端口可以发现，但没有 token 时 LCU 返回 401。下一位 agent 应寻找官方/本地公开的启动参数或日志来源，严禁读内存、注入或绕过反作弊。拿到 token 后先测试：`/lol-gameflow/v1/gameflow-phase`、`/lol-champ-select/v1/session`、`/lol-summoner/v1/current-summoner`。不要把 token 写入日志。

### BP 字段映射

现在的 `applyDraftSession()` 只是递归提取 `championId` 和 `bans`，不够可靠。拿到真实国服 session 后，应按 `actions`、`bans`、`myTeam`、`theirTeam`、`timer` 的真实结构重写。Champion ID 需要通过 Data Dragon 或本地 map 转成名称。

## 代码风险和注意事项

1. `state` 仍有模拟数据，默认 mode 是 mock。
2. 控台真实接口状态需要继续增强。
3. 缓存端口必须通过当前进程和 API 校验，不能盲信旧端口。
4. 无密码 connection 不能当作真实连接。
5. Electron 运行时下载失败时检查 `node_modules/electron/dist/electron.exe`。
6. 看到具体 `.exe` 文件前，不要声称 NSIS 安装包已生成。

## 运行测试

```powershell
cd "C:\Users\RyeRaven\Documents\Codex\2026-11-12\windows-lol-mvp-1-lol-2"
npm run server
npm test
node --check src/main.js
node --check src/data-sources.js
node --check electron/main.cjs
```

当前已验证：4 个 Node 测试通过，三个 JS 文件语法检查通过，HTTP 服务和 `/api/sources` 返回 200。

## 下一阶段优先级

### P0

- 自动获取国服 token。
- LCU 认证成功后显示绿色 LIVE 状态。
- 真实 BP session 字段映射。
- Champion ID 转名称。
- 控台明确显示 LIVE/MOCK 和错误原因。

### P1

- 接入 Live Client Data。
- 读取 10 名玩家、英雄、等级、KDA、装备、技能、目标物和事件。
- 断线保留最后有效状态。
- 确认 Electron runtime 下载完成并生成 `release/RiftBroadcast Setup 0.1.0.exe`，再实际运行安装包。

## 交接原则

先用真实接口返回验证，再改字段映射；不要继续扩大模拟 UI；不要把接口探测成功描述成真实数据已接通；最终交付应是可双击桌面程序；每次修改后运行测试并记录结果。

## 2026-11-12 深夜更新（第二位 agent）

### LCU token 已解决：读 Ux 日志

国服客户端启动时会写 `<LeagueClient>\<时间戳>_LeagueClientUx.log`，命令参数里就有 `--app-port` 和 `--remoting-auth-token`。`src/data-sources.js` 新增 `parseUxLog` / `findUxLogConnections` / `resolveClientDirs`：

- 只在日志尾部 96KB 内用正则取**最后一组**参数（token 每次启动随机、22 位）。
- 目录优先级：环境变量 → options.clientDir → 已知安装目录（含 `D:/WeGameApps/英雄联盟（含经典模式）/LeagueClient`）→ 最后才用 PowerShell 查进程路径。命中已知目录时不跑进程查询（省 1-2 秒）。
- 发现链：命令行参数 → 环境变量 → Ux 日志（优先返回能连通 /lol-gameflow 的候选）→ WMI → 缓存端口。
- 实测：真实日志解析出 port 52479、token 22 位，耗时 25ms；客户端未开时返回 connect ECONNREFUSED（预期）。

### 真实 BP 已按 actions 重写

`src/draft.js` 的 `normalizeDraftSession()` 只认 `actions` 里 `completed === true` 的 pick/ban（未完成的 championId 是悬停值），cellId 0-4 蓝 / 5-9 红；只有 actions 为空（如极地大乱斗）才回退读 myTeam/theirTeam。`src/champions.js` 从 Data Dragon 拉 zh_CN 英雄表并缓存 7 天（当前 16.22.1，195KB），ID 转中文名。

### Live Client Data 已接通

`src/live-data.js` 把 `/liveclientdata/allgamedata` 压成渲染层结构：10 名玩家的英雄/等级/KDA/补刀/视野分/装备/召唤师技能/存活与复活倒计时，队伍按 ORDER→blue、CHAOS→red，大小龙/防御塔/先锋按事件 KillerName 归属计数。`src/main.js` 每秒轮询 `:2999` 并写入 state，对局中自动切 `mode=live, phase=in_game`。Live Client Data 没有金币字段，live 模式下 `blue.gold/red.gold` 置 null，不展示假经济。

端到端验证（假 Live Client）：`node tools/fake-live-server.js 3299` + `PORT=3212 LIVE_CLIENT_URL=http://127.0.0.1:3299 node src/main.js` → `/api/state` 返回 mode=live、10 名玩家、比分 10:11、塔 1:1、红方 1 条小龙，与构造数据一致。

### Replay API 镜头模块（未实测）

`src/replay.js` 封装 `https://127.0.0.1:2999/replay/*`，字段名对齐 RiotGames/leaguedirector：

- `readReplayState()` → `/replay/playback` + `/replay/render` + `/replay/recording`
- `setCamera(patch)` → POST `/replay/render`，字段：cameraPosition/cameraRotation/fieldOfView/nearClip/farClip/cameraMode/cameraLockX(Y/Z) 等
- `setPlayback(patch)` → POST `/replay/playback`（paused/time/speed）
- `playSequence(frames)` → POST `/replay/sequence`（关键帧数组，leaguedirector 用它做平滑运镜）

服务端新增 `GET /api/replay`、`POST /api/replay/camera|playback|sequence`。**尚未在真实回放里验证**，需要客户端能进回放模式时再测。

### 其他修复

- `electron/main.cjs`：spawn 子服务时注入 `ELECTRON_RUN_AS_NODE=1`，并让窗口 URL 与服务端口共用 PORT 变量（原来硬编码 3210）。
- `requestJson` 支持 POST body 与空响应体，便于复用 Replay API。
- README 的 "WebSocket 实时推送" 更正为 SSE。

### 测试

`npm test` 14 个用例全部通过（data-sources 解析、draft 归一化、live-data 聚合）。语法检查通过：src/main.js、src/data-sources.js、src/replay.js。

### 仍未完成

1. Replay API 未在真实回放中验证（镜头预设、关键帧序列）。
2. 观战者席位下 `:2999` 是否随对局开放未实测。
3. Electron 安装包仍未生成，需在能联网下载 runtime 的环境跑 `npm run dist`。
4. 控台尚未做镜头操作面板（只有 API）。

## 2026-11-13 凌晨更新（第二位 agent，真实客户端实测后）

### 真机实测结论

- 用后台观察器 tools/watch-lcu.js 跟了完整两局：
  - 自定义对局（1 真人 + 9 电脑）：actions 只有 3 条零散记录，真实阵容只在 myTeam/theirTeam.championId，旧解析器只出 1 个 pick → 已修。
  - 真实匹配 BP：actionCount=21（10 pick + 10 ban + 1 phase_transition），10 选 10 ban 全部正确，中文英雄名由 Data Dragon 16.22.1 映射。
- :2999 在普通对局里正常开放（不需要观战席位）：10 人数据、gameTime 递增、事件流完整（GameStart/MinionsSpawning/ChampionKill/FirstBlood/DragonKill/TurretKilled/HeraldKill/Multikill/GameEnd）。英雄名已是中文，不需要再转换。

### 修复 1：FINALIZATION 阵容补全

src/draft.js 新增 resolvePicks()：先取 completed 的 pick/ban；当 actions 为空、或 timer.phase 为 FINALIZATION / GAME_STARTING 时，用 myTeam/theirTeam.championId 补齐空缺。BAN_PICK 阶段的 championId 是悬停值，绝不采用。真实 BP 快照存为 test/fixtures/session-real-draft.json。

### 修复 2：目标物归属（真机发现 towers 0:0）

真实事件里 KillerName 是不带 #tag 的召唤师名，而 Live Client Data 的 summonerName 带 #tag，导致 6 个 TurretKilled 全部匹配不到人、塔数一直是 0:0。修法（src/live-data.js）：

- 新增 stripTag()，注册 side 映射时同时登记英雄名、原名、去 tag 名及小写形式。
- 推塔额外按塔名兜底：Turret_TOrder_*（蓝方塔被推）→ 红方得分，Turret_TChaos_* → 蓝方得分；小兵/炮车推塔也能正确归属。
- 真实对局回归测试断言：58 个事件、塔 2:4、龙 1:1、先锋 0:1。

### 新增：赛后数据（post_game）

:2999 在游戏结束瞬间关闭，所以 src/main.js 在局内每秒把 live 数据冻结成 frozenSnapshot。LCU 进入 PreEndOfGame / EndOfGame / WaitForStatsScreen 时：

1. 优先拉 /lol-end-of-game/v1/eog-stats-block（有金币、伤害、视野、装备），src/post-game.js 归一化成 state.postGame；
2. 拉不到就用冻结快照兜底（source=frozen）；
3. eog 缺召唤师名字时按 championId 从冻结快照补；
4. 计算伤害占比 damagePct 与参团率 kp，赛后 Overlay 直接渲染。

### 新增：OBS 场景控制

src/obs.js 用 Node 22 自带 WebSocket 实现 obs-websocket 5.x 客户端（Hello/Identify 鉴权、GetSceneList、GetCurrentProgramScene、SetCurrentProgramScene、CurrentProgramSceneChanged 事件、断线 5 秒重连）。

- 接口：GET /api/obs、POST /api/obs/connect、POST /api/obs/scene、POST /api/obs/autoswitch
- state.autoSwitch = { draft, in_game, post_game } 保存阶段→场景映射，阶段变化时自动切 OBS 场景（同一阶段只触发一次）。
- 控台新增「OBS 场景控制」面板：连接表单、场景按钮、按阶段自动切场景的下拉配置。

### 控台回放面板

控台新增「回放镜头（仅录像）」面板：暂停/播放、0.5×/1×/2×/4×、FOV 30/45/60，调用已有 /api/replay/*。直播观战时 Replay API 不可用，只适合赛后复盘。

### 测试

node --test 24 例全绿（新增真实 BP 快照、真实 live 事件快照、post-game 归一化、OBS 鉴权）。

## 2026-11-13 凌晨更新（Electron 打包工程师）

### Electron 主进程（electron/main.cjs 重写）

- 端口探测：从 `PORT || 3210` 开始用 `net.createServer().listen` 逐个探测，最多试 50 个端口；3210 被占用时自动使用 3211/3212…，窗口 `loadURL` 使用实际端口，不再硬编码。
- 本地服务托管：以 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 启动 `src/main.js`，打包后同样适用；等待 `/health` 返回 200 后再创建窗口（20 秒超时）。
- 单实例锁：`app.requestSingleInstanceLock()`，重复启动时唤起并聚焦已有窗口。
- 系统托盘：内嵌 32×32 PNG 图标，菜单「打开控台」「退出」，单击/双击托盘也可打开控台。
- 关闭到托盘：`BrowserWindow` 的 `close` 事件 `preventDefault()` + `hide()`，只有 `isQuitting` 时才真正退出；`before-quit` / `will-quit` 会用 `taskkill /pid <pid> /t /f` 结束本地服务，避免残留进程占端口。
- 冒烟模式：`RIFTBRIDGE_SMOKE=1` 时自动输出 `[SMOKE] url/title/port/tray/tray-menu/dom/close-to-tray`，可配合 `RIFTBRIDGE_SMOKE_REPORT=<file>` 写报告，便于打包后自动验收。

### electron-builder / 打包配置（package.json）

- `asar: false`：打包后 `resources/app` 为真实文件，便于 `spawn` `src/main.js`。
- `electronDist: "node_modules/electron/dist"`：直接复用本地 Electron 45.3.1，避免重复下载运行时。
- `npmRebuild: false`：项目零运行时依赖，跳过重建。
- `files` 增加 `data/**/*`（内置 Data Dragon 英雄缓存），NSIS 设置为非 oneClick、可改安装目录、创建桌面/开始菜单快捷方式。
- 新增 `npm run dist:dir` 用于只生成 `release/win-unpacked`；`build-windows.bat` 在 NSIS 失败时自动回退并提示记录原因。

### 打包与验证结果

- `npm run dist` 成功（electron-builder 26.18.0，Electron 45.3.1 x64）。NSIS 组件 7zip / nsis-3.0.4.1 / nsis-resources-3.4.1 均下载成功，无需回退。
- 产物：`release/RiftBroadcast Setup 0.1.0.exe`，242,291,637 字节（约 231 MiB，> 50MB）；另有 `release/win-unpacked/RiftBroadcast.exe`。
- `node --test`：31 个用例全部通过（0 失败）。
- 开发模式冒烟（端口 3210 被用户服务占用）：自动选择 3211，窗口 URL `http://127.0.0.1:3211/`，标题「RiftBroadcast 控台」，托盘创建成功，菜单「打开控台|退出」，页面 `readyState=complete`、18 个按钮，关闭窗口后 `destroyed=false visible=false`。
- 打包版 `release/win-unpacked/RiftBroadcast.exe` 冒烟：同样自动选择 3211，URL 正确，托盘与关闭到托盘行为一致。
- NSIS 静默安装验证：`RiftBroadcast Setup 0.1.0.exe /S /D=%TEMP%\RiftBroadcastInstallTest` 返回 0，安装目录生成 `RiftBroadcast.exe`；启动安装版冒烟通过（3211 被另一测试服务占用，自动选择 3212，URL 正确）；卸载程序返回 0，安装目录已清理。
- 说明：未配置代码签名证书，Windows SmartScreen 可能提示「未知发布者」；安装包按用户安装（perMachine=false），无需管理员权限。验证期间未重启或修改端口 3210 上正在运行的服务。

## 2026-11-13 凌晨更新（OBS 深度集成）

### obs-websocket v5 能力扩展（src/obs.js）

在原有连接/鉴权/场景切换之上新增录制、推流、回放缓冲、输入与场景集合管理：GetRecordStatus / StartRecord / StopRecord、GetStreamStatus / StartStream / StopStream、SaveReplayBuffer、GetInputList / CreateInput / CreateBrowserSource、GetSceneItemList、GetSceneCollectionList / CreateSceneCollection / SetCurrentSceneCollection、CreateScene / SetInputSettings，并提供 record/stream 状态映射（active/paused/timecode/duration/bytes 等）与 op7/op5 消息统一处理。所有新请求仍走 obs-websocket v5 op6，零新增依赖（Node 22 自带 WebSocket）。

### 新 HTTP 接口（src/main.js）

- GET/POST /api/obs/record：GET 查询录制状态；POST {action:"start"|"stop"} 开始/停止录制。
- GET/POST /api/obs/stream：GET 查询推流状态；POST {action:"start"|"stop"} 开始/停止推流。
- POST /api/obs/replay-buffer：保存回放缓冲（{action:"save"} 或空 body）。
- GET/POST /api/obs/sources：GET 列出输入源；POST 创建 browser_source（inputName/name、url、width、height、sceneName、inputSettings）。
- POST /api/obs/scene-package：生成 RiftBroadcast 场景集合（默认 BP/局内/赛后 三场景 + 三个 1920×1080 browser 源，指向 http://127.0.0.1:3210/overlay/bp、/overlay/ingame-top、/overlay/postgame）。
- 未连接 OBS 时以上接口统一返回 HTTP 200 {ok:false,error:"obs_not_connected"}，不会因读取 body 或调用 OBS 崩溃；其他 OBS 错误返回 500 {ok:false,error:message}。

### 测试

- node --test：48 个用例全部通过（0 失败）。新增 test/obs.test.js 覆盖 authString、snapshot 安全字段、record/stream 状态映射、op6 请求字段（StartRecord/StopRecord/SaveReplayBuffer/CreateInput browser 1920×1080 url）、FakeObsWebSocket 握手与场景包请求序列、未连接 8 个新端点。
- 临时 3214 端口主服务联调：/api/obs/record、/api/obs/stream、/api/obs/replay-buffer、/api/obs/sources、/api/obs/scene-package 在未连接时全部返回 200 + obs_not_connected；验证后进程已结束，未触碰 3210。

### 真实 OBS 验证（OBS Studio 32.2.2 + obs-websocket 5.7.4）

- 连接 ws://127.0.0.1:4455（无密码）成功；原场景集合为 "2"（另有 "未命名"），未修改/删除 "2"。
- 创建独立集合 "RiftBroadcast"：新增场景 BP、局内、赛后（集合内另有 OBS 自动生成的「场景」空场景）；三个 browser_source 分别为「RiftBroadcast BP」「RiftBroadcast 局内」「RiftBroadcast 赛后」，GetInputSettings 验证 url 分别为 /overlay/bp、/overlay/ingame-top、/overlay/postgame，width=1920、height=1080；GetSceneItemList 确认每个场景各含对应源。
- 验证结束后切回原集合 "2"，原场景「场景」保持完整；"RiftBroadcast" 集合保留供用户使用。
- 录制：OBS 空闲时 StartRecord → 约 2.566 秒后 StopRecord，录制状态 outputActive=true、outputBytes=54838；StopRecord 返回 outputPath=C:/Users/RyeRaven/Videos/2026-11-13 02-08-36.mkv，文件 63404 字节，已删除；录制结束后 outputActive=false。OBS 当前已配置自定义 RTMP 推流服务（地址与密钥不记录）；为遵守安全约束未启动推流，StartStream/StopStream 仅由单测覆盖请求构造；回放缓冲未开启，未调用 SaveReplayBuffer（接口单测覆盖）。

## 2026-11-13 凌晨更新（OBS 场景包四场景 + 自动切换）

### 场景包实现

- `src/obs.js` 的 `SCENE_PACKAGE` 扩展为独立集合 `RiftBroadcast`：场景 `RB-BP`（/overlay/bp-broadcast）、`RB-HUD`（/overlay/hud-broadcast）、`RB-RESULT`（/overlay/result-broadcast）、`RB-TRANSITION`（/overlay/transition），每个 Browser Source 1920×1080、透明 CSS、`shutdown_when_not_visible=false`、`restart_when_active=false`。
- `createScenePackage` 会复用已有输入源并更新设置，确保每个场景包含对应源；返回 autoSwitch 映射 draft→RB-BP、in_game→RB-HUD、post_game→RB-RESULT。
- `POST /api/obs/scene-package` 支持 payload.autoSwitch，写入 `state.autoSwitch` 并调用 `saveConfig` 持久化；未连接 OBS 时保持原有 `obs_not_connected` 行为。
- 新增 `tools/setup-obs-scenes.js`：零依赖，可重复执行；支持 `--obs-url`、`--password`/OBS_PASSWORD、`--app-url`、`--collection`、`--restore-original`、`--skip-autoswitch`、`--json`，逐项验证 URL/尺寸/透明/不重载并输出结果。`package.json` 增加 `npm run setup-obs`。

### 测试与真实 OBS 验证

- `node --test test/obs.test.js` 12/12 通过；场景包单测验证 4 个场景、4 个 Browser Source、透明/不重载设置和 autoSwitch 映射，API 测试验证 `state.autoSwitch` 与 `saveConfig` 写入。
- 真实 OBS（OBS Studio 32.2.2 + obs-websocket 5.7.4，ws://127.0.0.1:4455）：原集合 `2`、原场景 `场景`；运行 `node tools/setup-obs-scenes.js --skip-autoswitch --restore-original --json` 返回 0，创建 `RB-BP`、`RB-HUD`、`RB-RESULT`、`RB-TRANSITION` 四个场景及四个源，逐项验证 url/1920×1080/透明/不重载/场景项全部通过，failures=[]；验证后已切回原集合 `2`/原场景 `场景`，原集合 `2` 只有 `场景` 且无输入源，未被修改。
- 清理：最终验证时只从应用自有的 `RiftBroadcast` 集合移除旧版 BP/局内/赛后/场景 四个场景及 RiftBroadcast BP/局内/赛后 三个旧输入源，用户原集合 `2` 未做任何删除；清理后 `RiftBroadcast` 集合恰好包含 4 个 RB-* 场景和 4 个对应的 Browser Source。

