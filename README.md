# Khada Jhin

Windows 本地《英雄联盟》赛事导播辅助工具。Khada Jhin 将 LCU、Live Client Data API 和 Data Dragon 数据转换为 OBS Browser Source 可采集的 BP、局内 HUD、赛后庆典和转场画面，并提供本地三栏控台。

> 合规声明：Khada Jhin 不读取游戏内存、不注入游戏进程、不修改游戏文件、不绕过反作弊、不模拟游戏操作。只使用 Riot 官方本地接口、公开 Data Dragon 数据和本地配置。

## 功能概览

- 真实数据：自动发现 LCU（国服客户端优先读取 Ux 日志中的启动参数，兼容启动参数、lockfile 和环境变量兜底）；局内读取 Live Client Data（https://127.0.0.1:2999）；Data Dragon 英雄和装备资源会缓存在 data 目录。
- 模拟数据：没有游戏客户端时，可用“模拟数据”模式演示完整的 BP → 局内 → 赛后流程。
- 控台：阶段与模式切换、LCU / Live Client / OBS / Replay 健康灯、事件流、广播配置编辑、OBS 场景快捷、录制 / 推流 / 回放缓冲控制。
- 广播页：BP 广播页、局内 HUD、赛后庆典、转场页；通过 SSE 实时刷新，按 1920×1080 设计。
- OBS：WebSocket v5 场景包，可一键创建 Khada Jhin 场景集合；支持阶段自动切场景和手动 cue。
- 桌面壳：Electron 托盘程序；关闭窗口最小化到托盘，3210 被占用时自动顺延端口。

## 快速开始

### 环境要求

- Windows 10/11 x64
- Node.js 18 或更高版本
- 首次执行 npm install 需要网络，用于下载 Electron 运行时和 electron-builder 依赖
- 推荐 OBS Studio 28 或更高版本（自带 obs-websocket）

### 开发运行

在项目根目录执行：

    npm install
    npm start

npm start 会启动 Electron 主进程、托管本地服务并自动打开控台窗口。也可以双击项目根目录的 start-riftbroadcast.bat，脚本会自动进入项目目录后执行 npm start。

只启动本地 HTTP 服务、不打开 Electron 窗口：

    npm run server

服务默认监听 http://127.0.0.1:3210/。桌面程序会自动探测端口：3210 被占用时改用 3211、3212……，窗口加载实际端口；以托盘或日志中显示的地址为准。npm run server 不包含端口自增逻辑，需要换端口时设置 PORT 环境变量，例如 PowerShell：

    $env:PORT=3211
    npm run server

在浏览器打开 http://127.0.0.1:3210/（或实际端口）即可进入控台；http://127.0.0.1:3210/health 可用于健康检查。

### 安装包与免安装版

双击 build-windows.bat，或执行：

    npm install
    npm run dist

产物为 release\Khada Jhin Setup 0.2.0.exe（NSIS 安装包），双击后按向导安装并选择安装目录。若首次打包因网络无法下载 NSIS 组件，build-windows.bat 会自动回退到 release\win-unpacked\Khada Jhin.exe；请按脚本提示在 DEVELOPMENT_LOG.md 记录失败原因。

只生成免安装目录：

    npm run dist:dir

免安装版入口是 release\win-unpacked\Khada Jhin.exe，移动时需要保留整个 win-unpacked 文件夹。未做代码签名时，Windows SmartScreen 可能提示“未知发布者”，选择“更多信息 → 仍要运行”即可。

## OBS 场景与 Overlay

### 1. 开启 OBS WebSocket

在 OBS 中打开“工具 → WebSocket 服务器设置”，启用 WebSocket 服务器；默认地址为 ws://127.0.0.1:4455。如设置了密码，请在控台 OBS 面板填写，或运行场景脚本时通过参数 / 环境变量传入，不要把密码写进仓库。

### 2. 一键创建 Khada Jhin 场景包

先启动 Khada Jhin 本地服务，再执行：

    npm run setup-obs

脚本连接 ws://127.0.0.1:4455，创建或更新独立场景集合 Khada Jhin，并生成：

| 场景 | Browser Source 地址 | 用途 |
| --- | --- | --- |
| RB-BP | http://127.0.0.1:3210/overlay/bp-broadcast | BP / 选人 |
| RB-HUD | http://127.0.0.1:3210/overlay/hud-broadcast | 局内 HUD |
| RB-RESULT | http://127.0.0.1:3210/overlay/result-broadcast | 赛后庆典 |
| RB-TRANSITION | http://127.0.0.1:3210/overlay/transition | 转场 |

四个 Browser Source 均为 1920×1080、透明背景，并关闭“不可见时关闭”和“激活时重载”，避免切场景时重新加载。脚本可重复执行（幂等），不会改动你原有场景集合中的任何场景或来源；默认会把 Khada Jhin 设为当前集合。

如果 Khada Jhin 实际端口不是 3210，需要同时指定 Browser Source 地址和本地服务地址：

    node tools/setup-obs-scenes.js --base-url http://127.0.0.1:3211 --app-url http://127.0.0.1:3211

只想验证场景包并恢复运行前的集合 / 场景：

    node tools/setup-obs-scenes.js --restore-original

OBS WebSocket 有密码时：

    node tools/setup-obs-scenes.js --password 你的密码

也可以设置 OBS_PASSWORD 环境变量。完整选项见 node tools/setup-obs-scenes.js --help。

### 3. 手动添加 Browser Source

不使用场景脚本时，可在 OBS 中为每个页面新建 Browser Source，宽高设为 1920×1080，并勾选透明背景。所有页面都使用 http://127.0.0.1:实际端口/... 地址。

| 地址 | 页面 |
| --- | --- |
| /overlay/bp-broadcast 或 /broadcast/bp | BP 广播页 |
| /overlay/hud-broadcast 或 /broadcast/hud | 局内 HUD |
| /overlay/result-broadcast 或 /broadcast/result | 赛后庆典 |
| /overlay/transition | 转场页 |
| /overlay/bp | 旧版 BP 单页（兼容保留） |
| /overlay/ingame-top | 旧版局内顶部条（兼容保留） |
| /overlay/ingame-bottom | 旧版局内底部十人条（兼容保留） |
| /overlay/postgame | 旧版赛后页（兼容保留） |

## 导播流程

1. 启动 OBS，确认 WebSocket 已开启；启动 Khada Jhin 桌面程序；启动英雄联盟客户端。
2. 在控台左侧“数据源健康”确认 LCU、Live Client、OBS 的状态。真实客户端连接后会自动切换到实战数据。
3. BP：客户端进入选人阶段后，阶段自动变为“赛前 BP”，OBS 自动切到 RB-BP（已配置自动切换时）。需要重播动画时点击“BP 入场”，或按快捷键 1。
4. 局内：进入对局后，阶段自动变为“局内”，OBS 自动切到 RB-HUD。点击“局内入场”或按 2 可重播入场动画。
5. 赛后：客户端进入结算阶段后，阶段自动变为“赛后”，OBS 自动切到 RB-RESULT。点击“赛后庆祝”或按 3 播放庆典；按 4 播放转场；按 Esc 重置 cue。
6. 录制 / 推流：在控台右侧 OBS 面板点击“开始录制”“停止录制”“开始推流”“停止推流”；OBS 的录制和推流输出需要先在 OBS 中配置好。回放缓冲需在 OBS 中启用后，才能用“保存回放”保存。
7. 手动阶段按钮适合在没有客户端或自动识别失败时兜底；手动 cue 只控制广播页动画，不改变 OBS 当前场景。自动切场景由“阶段自动切换”映射控制，可在控台 OBS 面板调整。

## 真实数据与配置

### LCU 自动发现

Khada Jhin 按以下顺序寻找 LCU 连接：启动参数 / RIOT_CLIENT_COMMAND_LINE、RIOT_LCU_PORT 与 RIOT_REMOTING_AUTH_TOKEN 环境变量、国服 LeagueClientUx 日志中的 Command line arguments、进程命令行、客户端缓存兜底。Ux 日志只读取头部 128 KB，并只解析 --app-port 与 --remoting-auth-token 所在行；不会把 token 写进日志或配置文件。

国服客户端不写 lockfile 时，Ux 日志自动发现是主要路径。若你的安装目录不在已知路径（D:/WeGameApps/... 或 C:/Riot Games/...），可设置 RIOT_LEAGUE_CLIENT_DIR 指向 LeagueClient 目录；也可以把客户端完整启动参数放在 RIOT_CLIENT_COMMAND_LINE 中临时使用（不要把含 token 的命令行提交到仓库或发给他人）。

### Live Client Data

局内数据来自 https://127.0.0.1:2999/liveclientdata/allgamedata，仅在真实对局中可用；可用 LIVE_CLIENT_URL 覆盖地址。Live Client Data 不提供全队金币，HUD 的经济数字是基于装备、补刀、击杀和被动金币的估算值；页面会按可用数据展示。:2999 在游戏结束瞬间可能关闭，程序会使用局内最后一帧快照生成赛后数据作为兜底。

### 配置文件

- data/config.json：保存赛事名称、模式、阶段、自动切场景映射和 OBS WebSocket 地址；OBS 密码只保存在当前进程内存，不写入磁盘。
- config/broadcast.json：队伍、选手、教练、赞助商和系列赛信息。可复制 config/broadcast.example.json 修改，也可在控台“广播配置”中编辑 JSON 后保存。

## 故障排查

| 现象 | 检查与处理 |
| --- | --- |
| 找不到 LCU / token | 确认 LeagueClient 正在运行；检查 Ux 日志路径；设置 RIOT_LEAGUE_CLIENT_DIR；必要时用 RIOT_CLIENT_COMMAND_LINE 或 RIOT_LCU_PORT + RIOT_REMOTING_AUTH_TOKEN 临时兜底。不要把 token 写入代码或日志。 |
| 端口被占用 | 桌面程序会自动从 3210 顺延，查看托盘提示或窗口实际地址；OBS 地址和场景脚本的 --base-url / --app-url 也要使用实际端口。不要为了换端口结束正在运行的其他服务。 |
| OBS 未连接 | 确认 OBS 已开启 WebSocket 服务器、端口为 4455、密码正确；在控台 OBS 面板重新连接。OBS 断线后程序会自动重连。 |
| Live Client 显示断开 | :2999 只在真实对局中可用；对局结束后看到 post_game 或 frozen 兜底属于正常行为。若对局很短，程序可能来不及取得首帧，可手动切“赛后”。 |
| Overlay 没有画面 | 先用浏览器打开对应地址确认服务正常；检查 OBS Browser Source 宽高是否为 1920×1080、是否使用实际端口；在 OBS 中刷新缓存或重新加载页面。 |
| 打包失败 | 首次打包需要下载 NSIS 组件；检查网络后重试，或使用 npm run dist:dir 生成免安装版。失败原因按提示记录到 DEVELOPMENT_LOG.md。 |

## 隐私与合规

- 不读取游戏内存，不注入进程，不修改游戏文件，不绕过反作弊，不模拟游戏操作。
- LCU token 仅在内存中用于本机 Basic Auth 请求，不写日志、不写入仓库、不随配置持久化。
- 本地 HTTP 服务只监听 127.0.0.1，不向局域网或公网开放。
- Data Dragon 请求只获取公开的英雄和装备资源；不会上传比赛或账号数据。

## 协议流解码（tools/decode0dd，进阶）

除了 Live Client Data 估算值，本项目还包含一条可选的精确数据链路：解析英雄联盟 0xdd 协议块（本地回放 ROFL 与官方观战流中的统计数据），解出每位玩家的击杀/死亡/助攻、补刀、野怪、金币与经验精确值，经 `/api/protocol-feed` 喂给 HUD，与 LCDA 估算值并存、按精度标注（exact/quantized/estimated/unavailable）。

边界与原则：

- 只解析 Riot 客户端与官方观战服务下发到本机的网络数据，以及存储在本地的回放文件；不读取游戏内存、不注入进程、不修改游戏文件。
- 实时观战场景需要从游戏进程命令行获取观战密钥，该步骤需管理员权限由用户自行完成，程序不会自动提权。
- 协议的 S-box 每局随机，实时局依靠 Live Client Data 真值增量求解；解不出的字段一律返回 null 并如实标注精度，绝不伪造数值。
- 该模块为社区逆向成果，遵循 Riot 的第三方工具政策用于非商业场景；使用风险自负。

## 开源协议

本项目以 GPL-3.0 协议开源，详见 LICENSE。包含或衍生使用本项目的代码同样需要以 GPL-3.0 开源。

## 开发与验证

    npm test
    npm run shot -- --base-url http://127.0.0.1:3211 --out .tmp/shots

npm test 使用 Node 内置测试运行器。npm run shot 需要本地服务已启动，会为默认页面生成 1920×1080 PNG 和 manifest，便于检查视觉效果。

详细操作说明、OBS 配置、数据源排障和目录说明见 [docs/USER-GUIDE.md](docs/USER-GUIDE.md)；视觉规范见 [docs/VISUAL-SPEC.md](docs/VISUAL-SPEC.md)。
