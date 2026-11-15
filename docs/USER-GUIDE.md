# RiftBroadcast 用户手册

本文档面向赛事导播、OBS 操作员和第一次部署 RiftBroadcast 的用户，说明安装启动、OBS 配置、页面地址、完整导播流程、数据源和常见故障处理。

RiftBroadcast 是 Windows 本地工具：本地 HTTP 服务默认监听 127.0.0.1:3210，OBS 通过 Browser Source 读取本机页面。程序不读取游戏内存、不注入、不修改游戏文件、不绕过反作弊、不模拟游戏操作。

## 一、安装与启动

### 1.1 运行环境

- Windows 10/11 x64。
- Node.js 18 或更高版本（源码运行和打包需要）。
- 首次 npm install 需要网络，用于下载 Electron 与 electron-builder 依赖。
- OBS Studio 28 或更高版本（推荐，自带 obs-websocket 5.x）。

### 1.2 源码方式启动

在项目根目录打开 PowerShell：

    cd "C:\Users\RyeRaven\Documents\Codex\2026-11-12\windows-lol-mvp-1-lol-2"
    npm install
    npm start

npm start 会启动 Electron 主进程，主进程再托管本地 HTTP 服务，并自动打开控台窗口。也可以直接双击项目根目录的 start-riftbroadcast.bat；脚本会自动切换到项目目录，再执行 npm start。

只启动 HTTP 服务、不打开桌面窗口：

    npm run server

这种方式默认使用 3210 端口，不包含 Electron 的端口自动顺延逻辑。需要换端口时在 PowerShell 中执行：

    $env:PORT=3211
    npm run server

启动后在浏览器访问 http://127.0.0.1:3210/（或实际端口）即可打开控台。服务健康检查地址是 http://127.0.0.1:3210/health。

### 1.3 桌面程序行为

- 主进程从 3210 开始探测可用端口，被占用时依次尝试 3211、3212……最多尝试 50 个端口，窗口加载实际端口。
- 单实例：重复双击只会唤起已有窗口，不会启动第二套本地服务。
- 系统托盘：托盘菜单包含“打开控台”和“退出”；单击托盘图标也会打开控台。
- 关闭窗口不会退出进程，而是隐藏到托盘。真正退出请使用托盘菜单“退出”，程序会一并结束本地服务。
- 本地服务只绑定 127.0.0.1，不会监听局域网地址。

### 1.4 生成安装包与免安装版

双击 build-windows.bat，或在 PowerShell 中执行：

    npm install
    npm run dist

成功后会生成 release\RiftBroadcast Setup 0.1.0.exe（NSIS 安装包）。双击安装包，按向导选择安装目录并完成安装。安装完成后可从桌面快捷方式或开始菜单启动 RiftBroadcast。

如需卸载，可在 Windows 设置 → 应用 → 已安装的应用 中找到 RiftBroadcast 进行卸载，或运行安装目录中的 Uninstall RiftBroadcast.exe。

只生成免安装目录：

    npm run dist:dir

免安装版入口是 release\win-unpacked\RiftBroadcast.exe；移动或复制时需要保留整个 win-unpacked 文件夹，不能只复制 exe 文件。

如果首次打包时 electron-builder 因网络无法下载 NSIS 组件，build-windows.bat 会自动回退到 npm run dist:dir，生成免安装版。按照构建脚本的提示，把失败原因记录到 DEVELOPMENT_LOG.md。未签名程序的 Windows SmartScreen 提示属于预期现象，选择“更多信息 → 仍要运行”即可。

### 1.5 首次启动检查清单

1. OBS 已启动，WebSocket 服务器已启用。
2. RiftBroadcast 已启动，控台窗口能打开。
3. 英雄联盟客户端已登录并进入大厅。
4. 控台左侧“数据源健康”中 LCU 和 Live Client 显示为正常，OBS 显示为已连接。
5. 如使用 OBS 场景包，先按第三节执行场景包脚本或手动建立 Browser Source。

## 二、控台界面

控台分为三栏：

- 左栏：比赛阶段（赛前 BP / 局内 / 赛后）、数据模式（模拟数据 / 实战数据）、赛事名称、广播页地址、广播控制（手动 cue）、数据源健康、OBS 场景快捷、Overlay 浏览器源列表。
- 中栏：比分、经济、推塔、大小龙等比赛主卡，以及最多 30 条实时事件流。数据来自 /api/state 和 SSE /events。
- 右栏：OBS 连接、场景快捷、录制 / 推流 / 回放缓冲控制、阶段自动切换映射、回放镜头控制、广播配置编辑。

页面顶部的状态徽标会显示 MOCK / LIVE 和连接状态。没有真实客户端时使用模拟数据即可测试所有页面；接入客户端后，LCU 阶段变化会优先切换到实战数据。

## 三、OBS 配置

### 3.1 开启 OBS WebSocket

打开 OBS，进入“工具 → WebSocket 服务器设置”：

1. 勾选“启用 WebSocket 服务器”。
2. 端口保持默认 4455（如被其他程序占用可以修改，但 RiftBroadcast 也要填写同一个端口）。
3. 如启用密码，记下密码；不要把密码写进代码、README 或提交记录。
4. 回到 RiftBroadcast 控台右侧 OBS 面板，填写地址 ws://127.0.0.1:4455 和密码，点击“连接 OBS”。

### 3.2 一键创建 RiftBroadcast 场景包

先启动 RiftBroadcast 本地服务，再在项目根目录执行：

    npm run setup-obs

脚本会连接 ws://127.0.0.1:4455，创建或更新独立场景集合 RiftBroadcast，并创建四个场景及对应 Browser Source：

| 场景 | 来源名称 | 页面地址 | 用途 |
| --- | --- | --- | --- |
| RB-BP | RiftBroadcast BP | /overlay/bp-broadcast | BP / 选人 |
| RB-HUD | RiftBroadcast HUD | /overlay/hud-broadcast | 局内 HUD |
| RB-RESULT | RiftBroadcast Result | /overlay/result-broadcast | 赛后庆典 |
| RB-TRANSITION | RiftBroadcast Transition | /overlay/transition | 转场 |

四个 Browser Source 均为 1920×1080、透明背景，设置 shutdown_when_not_visible=false、restart_when_active=false，切换场景时不会重新加载页面。脚本会写入阶段映射：draft → RB-BP、in_game → RB-HUD、post_game → RB-RESULT；默认保留 RiftBroadcast 为当前场景集合。

脚本是幂等的，可以重复执行；它不会改动你原有场景集合中的场景和来源。只想验证并恢复原集合时执行：

    node tools/setup-obs-scenes.js --restore-original --skip-autoswitch

OBS WebSocket 使用密码时：

    node tools/setup-obs-scenes.js --password 你的密码

也可以设置 OBS_PASSWORD 环境变量。若 RiftBroadcast 实际端口不是 3210，需要同时传入 Browser Source 基础地址和本地服务地址：

    node tools/setup-obs-scenes.js --base-url http://127.0.0.1:3211 --app-url http://127.0.0.1:3211

可用 node tools/setup-obs-scenes.js --help 查看全部参数。

### 3.3 手动建立 Browser Source

如果不使用场景包，在 OBS 中新建 Browser Source，并按下表填写地址。宽高统一为 1920×1080，勾选透明背景；页面本身也会输出透明背景。

| 地址 | 页面 | 说明 |
| --- | --- | --- |
| /overlay/bp-broadcast 或 /broadcast/bp | BP 广播页 | 推荐 BP 场景使用 |
| /overlay/hud-broadcast 或 /broadcast/hud | 局内 HUD | 推荐局内场景使用 |
| /overlay/result-broadcast 或 /broadcast/result | 赛后庆典 | 推荐赛后场景使用 |
| /overlay/transition | 转场页 | 手动 cue 或独立场景 |
| /overlay/bp | 旧版 BP 单页 | 兼容保留 |
| /overlay/ingame-top | 旧版局内顶部条 | 兼容保留 |
| /overlay/ingame-bottom | 旧版局内底部十人条 | 兼容保留 |
| /overlay/postgame | 旧版赛后页 | 兼容保留 |

完整地址格式是 http://127.0.0.1:实际端口 + 上表路径。例如 http://127.0.0.1:3210/overlay/bp-broadcast。端口以控台实际地址为准。

### 3.4 阶段自动切换

- 场景包脚本会写入默认映射；也可以在控台右侧“阶段自动切换”中为 BP / 局内 / 赛后分别选择 OBS 场景。
- 自动切换只在阶段变化时触发一次，不会每帧重复请求。
- OBS 未连接时不会自动切换；连接恢复后，下一次阶段变化会重新触发。
- 手动点击 OBS 场景快捷或使用 OBS 自己切换场景不会被阶段映射覆盖；下一次阶段变化仍按映射执行。

## 四、导播流程

### 4.1 赛前 BP

1. 启动 OBS、RiftBroadcast 和英雄联盟客户端。
2. 客户端进入选人阶段后，控台阶段会自动变为“赛前 BP”；OBS 自动切到 RB-BP。
3. 广播页显示双方阵容、Ban、教练、选手和系列赛信息。
4. 需要重播 BP 入场动画时，点击“BP 入场”或按快捷键 1。
5. 如果自动识别没有切换阶段，可以手动点击“赛前 BP”；这不会修改客户端，只是控制本地页面状态。

### 4.2 局内

1. 进入对局后，阶段自动变为“局内”，OBS 自动切到 RB-HUD。
2. HUD 显示比分、经济、推塔、大小龙和十名选手数据；Live Client Data 每秒刷新。
3. 需要重播局内入场动画时，点击“局内入场”或按 2。
4. 经济数字是按装备、补刀、击杀和被动金币估算的，不是官方全队金币；请按页面显示为准。

### 4.3 赛后

1. 客户端进入结算阶段后，阶段自动变为“赛后”，OBS 自动切到 RB-RESULT。
2. 点击“赛后庆祝”或按 3 播放庆典动画；按 4 播放转场；按 Esc 重置 cue。
3. 如果 :2999 在结算瞬间关闭，程序会使用局内最后一帧快照生成赛后数据；这类数据会在页面/状态中按 frozen 兜底处理。
4. 需要重新查看赛后页时，可点击控台的“赛后”阶段按钮；如果客户端仍在上局，LCU 轮询可能再次切回实战状态。

### 4.4 录制、推流与回放

- 录制：在 OBS 面板点击“开始录制”，再点“停止录制”。OBS 中需要先配置录制输出目录和编码参数。
- 推流：在 OBS 面板点击“开始推流”，再点“停止推流”。OBS 中需要先配置推流服务；RiftBroadcast 不会保存或显示推流密钥。
- 回放缓冲：先在 OBS 中启用回放缓冲，再用“保存回放”保存当前缓冲。按钮只在 OBS 已连接且 OBS 支持对应请求时可用。
- 回放镜头：如果本机有回放客户端提供 :2999 Replay API，控台右栏会显示播放 / 暂停、速度和镜头控制；没有检测到回放时显示“未检测到回放”，不影响直播和录制。

## 五、真实数据源说明

### 5.1 LCU 自动发现

RiftBroadcast 通过以下顺序寻找 LCU：

1. 显式传入的启动参数，或环境变量 RIOT_CLIENT_COMMAND_LINE。
2. RIOT_LCU_PORT 和 RIOT_REMOTING_AUTH_TOKEN 环境变量。
3. 国服 LeagueClientUx 日志：读取日志头部 128 KB，只解析 Command line arguments 行中的 --app-port 和 --remoting-auth-token。
4. LeagueClient.exe / RiotClientServices.exe 进程命令行。
5. 客户端缓存中的历史端口兜底。

国服客户端不写 lockfile 时，Ux 日志自动发现是主要路径；程序还兼容 lockfile 探测。若安装目录不在已知位置，可设置 RIOT_LEAGUE_CLIENT_DIR、LEAGUE_CLIENT_DIR 或 LOL_CLIENT_DIR 指向 LeagueClient 目录。

LCU token 只在内存中用于本机 HTTPS Basic Auth 请求，不写日志、不写入配置文件、不随状态接口返回。不要把包含 token 的启动参数发到聊天群、提交到仓库或写入 README。

### 5.2 Live Client Data

局内数据来自 https://127.0.0.1:2999/liveclientdata/allgamedata。该服务只在真实对局中可用，地址可通过 LIVE_CLIENT_URL 覆盖。程序接受本地自签名证书，不会把数据发送到外部服务器。

Live Client Data 不提供全队金币，因此 HUD 经济是估算值；事件时间线和赛后数据来自该接口及事件数据。对局结束瞬间 :2999 可能先关闭，程序会保存局内最后一帧作为 frozen 快照，并在满足条件时自动进入 post_game。

### 5.2.1 像素读条（生命条 / 资源条）

Live Client Data 不含生命值与法力值，所以 HUD 上的生命条与资源条来自**同机像素读条**：独立进程截屏读原生血条长度，经 `POST /api/pixel-bars` 喂给主进程。

- 只有百分比（0..100），**永远没有绝对数值**；HUD 上这两条只画长度、不显示数字。
- 精度 1px ≈ 1.96%，端到端延迟约 14ms，默认 5Hz 上报。
- 超过 2000ms 没有新读数即失效：字段变 `null`，契约降回 `unavailable`，页面画 `unknown` 占位，绝不保留旧血量。
- 启动：`node tools/pixel-bars-bridge.cjs --port 3210 --rate 5`；诊断：`GET /api/pixel-bars/status`。

完整说明（字段、校验、403/413、排障表）见 [PIXEL-BARS.md](PIXEL-BARS.md)。

### 5.3 模拟数据

没有游戏客户端时，控台选择“模拟数据”即可：

- 每秒推进比赛时间、比分、经济和事件。
- 可手动切换赛前 BP / 局内 / 赛后，检查广播页、动画和 OBS 场景。
- 用于赛前彩排、OBS 布局和页面验收。

模拟数据不会连接游戏，也不会修改客户端状态。

## 六、配置与数据文件

- data/config.json：保存赛事名称、模式、阶段、自动切场景映射和 OBS WebSocket 地址。OBS 密码只保存在当前进程内存，不写入磁盘。
- config/broadcast.json：源码运行时读取的队伍、选手、教练、赞助商和系列赛配置；可复制 config/broadcast.example.json 修改。
- config/broadcast.example.json：广播配置示例。
- data/champions-*.json、data/items-*.json：Data Dragon 资源缓存。
- 控台“广播配置”面板可直接编辑 JSON 并保存；保存后广播页通过 SSE 自动刷新。

安装版的应用文件位于安装目录；如果使用默认的按用户安装目录，data 和 config 子目录通常可写。若把程序放在只读目录，配置保存可能失败，此时请改放到可写目录。

## 七、故障排查

### 7.1 找不到 LCU 或 token

1. 确认 LeagueClient 正在运行且已登录。
2. 查看控台“数据源健康”中的 LCU 行和错误提示。
3. 国服客户端默认不写 lockfile；确认 LeagueClientUx 日志存在于安装目录。
4. 不确定安装目录时，设置 RIOT_LEAGUE_CLIENT_DIR 指向包含 LeagueClientUx.log 的 LeagueClient 目录，然后重启程序。
5. 临时兜底：在当前 PowerShell 设置 RIOT_CLIENT_COMMAND_LINE 为客户端完整启动参数，或设置 RIOT_LCU_PORT 与 RIOT_REMOTING_AUTH_TOKEN。不要把这些值写入项目文件或日志。
6. 修改环境变量后需要重启 RiftBroadcast 服务或桌面程序。

### 7.2 端口被占用

- 桌面程序会自动从 3210 顺延，不需要手动结束任何进程。
- 查看窗口实际地址或托盘提示；OBS 的 Browser Source 地址必须使用同一个实际端口。
- 使用场景脚本时，如果实际端口是 3211，执行：

    node tools/setup-obs-scenes.js --base-url http://127.0.0.1:3211 --app-url http://127.0.0.1:3211

- 使用 npm run server 时端口不会自动顺延，需要设置 PORT 环境变量，或先确认 3210 上没有其他服务。
- 不要为了释放端口而结束不属于你的进程；先确认占用者。

### 7.3 OBS 未连接

1. OBS → 工具 → WebSocket 服务器设置，确认已启用，端口通常是 4455。
2. 控台 OBS 面板填写 ws://127.0.0.1:4455 和正确密码，点击“连接 OBS”。
3. 检查 OBS 是否弹出认证失败、端口占用或防火墙提示。
4. 连接成功后，健康灯变绿，场景快捷和录制/推流按钮才会加载。
5. OBS 重启后程序会自动重连；如果未恢复，手动点击连接。

### 7.4 Live Client 断开或没有局内数据

- :2999 只在真实对局中启动；在客户端大厅或赛后看到断开是正常的。
- 对局结束后自动进入 post_game 属于预期行为；如果对局短于约 60 秒，可能还没达到 frozen 兜底条件，此时在控台手动点击“赛后”。
- 检查是否被其他程序占用 :2999，或本机防火墙拦截本地回环；RiftBroadcast 只访问 127.0.0.1。
- 如果只有部分字段缺失，以页面显示的占位符为准；程序不会伪造官方金币。

### 7.5 Overlay 没有画面或画面不刷新

1. 在普通浏览器打开对应地址，确认返回页面而不是 404 / 连接失败。
2. 检查 OBS Browser Source 的宽高是否为 1920×1080。
3. 检查地址端口是否和控台实际端口一致。
4. 在 OBS 中对 Browser Source 执行“刷新页面”或清理缓存；场景包的源默认关闭了“不可见时关闭”和“激活时重载”，手动源请保持相同设置。
5. 透明背景的页面在 OBS 中默认叠加在游戏画面上；如果页面本身没有数据，可能看起来是空画面，先确认模拟数据或实战数据有比分/选手。

### 7.6 打包或安装失败

- 首次 npm run dist 需要下载 NSIS 组件，网络不通时可能失败；可改用 npm run dist:dir 生成免安装版。
- build-windows.bat 会自动检测 Node.js 和 electron-builder 依赖；若 npm install 失败，先在 PowerShell 中查看完整 npm 报错。
- 安装包未签名时 SmartScreen 会提示未知发布者；这是代码签名问题，不是安装包损坏。
- 安装版无法启动时，查看控台日志/Windows 事件查看器；桌面程序启动失败会弹出错误框，并提示本地服务端口。

## 八、隐私与合规

- 不读取游戏内存，不注入游戏进程，不修改游戏文件，不绕过反作弊，不模拟游戏操作。
- 只读取 Riot 官方本地 LCU / Live Client Data 接口和公开 Data Dragon 资源。
- LCU token 只用于本机认证请求，不写日志、不写入代码、不持久化。
- OBS 密码只在当前进程内存中使用，不写入 data/config.json。
- 本地 HTTP 服务只绑定 127.0.0.1；不会向局域网或互联网开放服务。
- 不收集、不上传比赛数据、账号信息或推流密钥。

## 九、检查与验证命令

在项目根目录执行：

    npm test
    npm run shot -- --base-url http://127.0.0.1:3211 --out .tmp/shots

npm test 使用 Node 内置测试运行器；npm run shot 需要本地服务已启动，会生成默认页面的 1920×1080 PNG 和 manifest.json，便于检查页面布局和视觉状态。

更多项目结构、打包和开发说明见 [README.md](../README.md)；视觉规范见 [VISUAL-SPEC.md](VISUAL-SPEC.md)。
