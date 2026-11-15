# RiftBroadcast 验证报告（VERIFICATION.md）

- 验证日期：2026-11-13
- 验证角色：verifier（QA/审查）
- 验证对象：RiftBroadcast MVP（当前工作区）
- 运行环境：Windows 10/11 x64，Node.js v22.14.0（`engines.node >= 18`）
- 验证方式：本地自动化测试（`node --test`）+ 假 LCU / 假 Live Client 端到端；**未读取游戏内存、未注入进程、未修改游戏文件、未使用真实 LCU token**。
- 总体结论：**通过**。全量 54/54 用例通过，e2e 2/2 通过，未发现阻塞项。真实客户端、真实 OBS、Electron 安装包与 Overlay 视觉仍需人工验收（见第 5 节）。

## 1. 命令与总结果

| 命令 | 结果 |
| --- | --- |
| `node --test` | 退出码 0；tests 54 / pass 54 / fail 0 / skipped 0；最近一次复跑耗时 3786.54ms |
| `node --test test/e2e.test.js` | 退出码 0；2/2 通过（2883.63ms + 22.13ms，总 3051.87ms） |
| `node --check tools/fake-lcu.js && node --check test/e2e.test.js` | 退出码 0（`SYNTAX_OK`） |

> 端口隔离：e2e 只扫描 **3212–3219**，若全部被占用则测试快速失败；不访问 3210（用户/演示服务），也不触碰 3211 上其他进程的服务。

## 2. 分文件用例统计

| 测试文件 | 用例数 | 主要覆盖 |
| --- | ---: | --- |
| `test/assets.test.js` | 10 | Data Dragon URL、图标回退、离线渲染 |
| `test/broadcast-config.test.js` | 4 | 播报配置归一化、图片解析、读写 |
| `test/data-sources.test.js` | 4 | lockfile、Data Dragon URL、启动参数、环境变量 |
| `test/discovery.test.js` | 3 | Ux 日志启动参数解析 |
| `test/draft.test.js` | 7 | BP 会话解析、ban/pick 完成态、真实 fixture |
| `test/live-data.test.js` | 4 | 局内玩家/队伍/目标物归一化 |
| `test/obs.test.js` | 6 | obs-websocket v5 鉴权、请求形状、状态映射 |
| `test/post-game.test.js` | 4 | EOG 归一化、伤害占比、frozen 兜底 |
| `test/timeline.test.js` | 10 | 时间线归类/上限/容错、LCU 断线退避、:2999 兜底 |
| `test/e2e.test.js` | 2 | 假 LCU 全链路、脚本化相位与鉴权 |
| **合计** | **54** | — |

## 3. 分模块验证矩阵

### 3.1 本地 HTTP 服务与状态（`src/main.js`、`src/app-state.js`）

| 验证项 | 命令 / 用例 | 结果 | 未覆盖项 |
| --- | --- | --- | --- |
| `GET /api/state` 返回阶段、模式、选手、时间线 | e2e Test 1，`test/e2e.test.js:192/229/262` | 通过（draft/in_game/post_game 三阶段均轮询成功） | 未做长时间轮询/并发请求压力测试 |
| `GET /api/sources` 返回 LCU 与 Live 两路探测 | e2e Test 1，`test/e2e.test.js:211-220` | 通过（LCU `ok=true`、`phase=ChampSelect`、`discovery=environment`；Live 探测 `source=live_client`） | Live 探测固定 :2999（见 6.1），e2e 未断言其 `ok` |
| `GET /events` SSE 推送 | e2e Test 1，`test/e2e.test.js:278-285` | 通过（消息数 ≥2，覆盖 draft/in_game/post_game，`updatedAt` 均为 number） | 未验证客户端断线重连/背压 |
| `/health`、`POST /api/phase`、`POST /api/config` | 仅路由代码审阅（`src/main.js:196/210/211`） | 未自动化覆盖 | 无集成断言；建议补 HTTP 冒烟用例 |
| 端口选择与 127.0.0.1 绑定 | e2e 使用 3212–3219，`src/main.js:217` | 通过（未占用 3210/3211） | Electron 外壳的 3210 顺延逻辑未在 Electron 中验证 |

### 3.2 BP 解析（`src/draft.js`）

| 验证项 | 命令 / 用例 | 结果 | 未覆盖项 |
| --- | --- | --- | --- |
| 只统计 completed 的 ban/pick；hover 不计 | `test/draft.test.js`（7 例） | 通过 | 真实客户端不同版本字段差异未覆盖 |
| 无 actions 时回退 team champions | `test/draft.test.js` | 通过 | — |
| 真实自定义对局/匹配 BP fixture | `test/draft.test.js` | 通过（10 pick + 10 ban） | 仅离线 fixture |
| 假 LCU 的 ChampSelect 会话驱动 UI 状态 | e2e Test 1，`test/e2e.test.js:192-208` | 通过（5+5 picks、3+3 bans、timer=21、round=选人阶段、actions=16） | 真实 LCU 未连接 |

### 3.3 LCU 发现与数据源（`src/data-sources.js`）

| 验证项 | 命令 / 用例 | 结果 | 未覆盖项 |
| --- | --- | --- | --- |
| lockfile / 启动参数 / 环境变量解析 | `test/data-sources.test.js`（4 例） | 通过 | 真实国服客户端未连接 |
| Ux 日志头部 Command line arguments 解析 | `test/discovery.test.js`（3 例） | 通过（含 933KB 日志与 Cef 诱饵） | 本机真实 Ux 日志未跑 |
| HTTPS LCU 请求 + Basic 鉴权 | e2e Test 1（`fake-lcu.js` 自签名 HTTPS） | 通过（`authFailures=0`，gameflow/session/eog 均被真实轮询） | 证书校验被 `rejectUnauthorized:false` 关闭（本地回环可接受） |
| LCU 请求失败缓存失效/退避 | `test/timeline.test.js` 中相关 3 例 | 通过 | 未做真实客户端重启场景 |

### 3.4 局内 Live Client 数据（`src/live-data.js`）

| 验证项 | 命令 / 用例 | 结果 | 未覆盖项 |
| --- | --- | --- | --- |
| 选手、队伍、死亡状态映射 | `test/live-data.test.js`（4 例） | 通过 | 真实 :2999 未连接 |
| 比分/目标物按边归属 | `test/live-data.test.js` | 通过（含真实 fixture） | 真实对局中的异常事件未覆盖 |
| 假 Live Client 驱动局内状态 | e2e Test 1，`test/e2e.test.js:222-245` | 通过（10 名选手、gameTime=812、events=4、blue.score=10/red.score=11） | 假服务走 HTTP，真实为 HTTPS 自签；协议差异由 `requestJson` 分支覆盖 |

### 3.5 时间线与事件（`src/timeline.js`）

| 验证项 | 命令 / 用例 | 结果 | 未覆盖项 |
| --- | --- | --- | --- |
| 58 个原始事件归类、升序 | `test/timeline.test.js` | 通过 | 更多真实对局事件类型未采样 |
| state.timeline 仅保留最近 50 条 | `test/timeline.test.js` | 通过 | — |
| 空 payload/未知事件/ARAM 不抛错 | `test/timeline.test.js` | 通过 | — |
| 局内 SSE 状态包含 4 条事件 | e2e Test 1，`test/e2e.test.js:230-245` | 通过（`timeline[3].type === 'tower'`） | — |

### 3.6 赛后统计（`src/post-game.js`）

| 验证项 | 命令 / 用例 | 结果 | 未覆盖项 |
| --- | --- | --- | --- |
| EOG teams/players 归一化 | `test/post-game.test.js`（4 例） | 通过 | 真实 EOG 响应未采样 |
| 伤害占比/参团率计算 | `test/post-game.test.js` | 通过 | 极端 0 伤害/0 击杀边界仅单测覆盖 |
| EOG 缺失时 frozen 快照兜底 | `test/post-game.test.js` | 通过 | 真实结算瞬间时序未验证 |
| PreEndOfGame 触发 post_game | e2e Test 1，`test/e2e.test.js:255-276` | 通过（gameLength=1520、isWin=true、blue.towers=8、red.towers=3、blue.score=25、red.score=10、10 名选手） | 真实客户端结算时序未验证 |

### 3.7 OBS WebSocket（`src/obs.js`）

| 验证项 | 命令 / 用例 | 结果 | 未覆盖项 |
| --- | --- | --- | --- |
| obs-websocket v5 鉴权字符串 | `test/obs.test.js` | 通过 | 真实 OBS 未连接 |
| 请求 payload 使用 op6 形状 | `test/obs.test.js` | 通过（含 SaveReplayBuffer） | 真实录制/推流状态未验证 |
| 场景切换/状态快照/未连接错误 | `test/obs.test.js` | 通过（fake WebSocket 握手） | 真实 OBS 场景包、重连、超时未覆盖 |

### 3.8 播报配置（`src/broadcast-config.js`）

| 验证项 | 命令 / 用例 | 结果 | 未覆盖项 |
| --- | --- | --- | --- |
| 缺省字段补齐与数字转换 | `test/broadcast-config.test.js`（4 例） | 通过 | `/api/broadcast-config` HTTP 路由未做集成断言 |
| 本地图片校验、外链保留 | `test/broadcast-config.test.js` | 通过 | 真实用户图片目录未验证 |
| 缺失/损坏配置返回默认副本 | `test/broadcast-config.test.js` | 通过 | 并发写配置未验证 |
| 保存到指定文件 | `test/broadcast-config.test.js` | 通过 | — |

### 3.9 页面、Overlay 与资源（`src/pages/*`、`src/assets.js`、`src/champions.js`、`public/*`）

| 验证项 | 命令 / 用例 | 结果 | 未覆盖项 |
| --- | --- | --- | --- |
| 5 个页面均返回 200 且根节点正确 | e2e Test 1，`test/e2e.test.js:246-253` | 通过（`/`→console-shell；`/overlay/bp`→bp-board；ingame-top；ingame-bottom；postgame-table） | 未做浏览器渲染/截图比对 |
| 图标 URL 解析与 fallback | `test/assets.test.js`（10 例） | 通过（中文名/称号/英文名/数字 id） | 真实 Data Dragon 网络请求未跑 |
| 离线 Overlay 使用 fallback-first 图标 | `test/assets.test.js` | 通过（四个 Overlay 的 mock state 渲染） | 视觉布局、字体、1920×1080 透明背景未验证 |

### 3.10 Replay 与 Electron 外壳（`src/replay.js`、`electron/main.cjs`）

| 验证项 | 命令 / 用例 | 结果 | 未覆盖项 |
| --- | --- | --- | --- |
| Replay API 客户端（相机/播放/序列） | 无自动化用例 | 未覆盖 | 需要回放模式客户端 + `:2999` Replay API；`src/replay.js:7` 默认 `REPLAY_BASE=https://127.0.0.1:2999` |
| Electron 启动、托盘、单实例、端口顺延 | 无自动化用例 | 未覆盖 | 需要桌面环境人工验证；本次未运行 `electron-builder`/`npm run dist`（避免构建占用资源） |

### 3.11 端到端全链路（`test/e2e.test.js`）

| 步骤 | 断言 | 结果 |
| --- | --- | --- |
| 启动假 LCU + 应用（环境变量注入 LCU 连接） | 应用打印监听地址，`/api/state` 进入 draft | 通过 |
| draft | 5+5 picks、3+3 bans、timer=21、round=选人阶段、`live.draft.actions=16` | 通过 |
| `/api/sources` | LCU `ok=true`、`phase=ChampSelect`、`discovery=environment` | 通过 |
| 启动假 Live Client，LCU 切 InProgress | in_game：10 名选手、gameTime=812、events=4、blue.score=10/red.score=11、timeline=4 | 通过 |
| 5 个页面 | 全部 200 且根节点匹配 | 通过 |
| LCU 切 PreEndOfGame | post_game：gameLength=1520、CLASSIC、isWin=true、blue.towers=8、red.towers=3、blue.score=25、red.score=10、10 名选手、damagePct>0 | 通过 |
| SSE | ≥2 条，覆盖 draft/in_game/post_game | 通过 |
| 假 LCU 自身 | `authFailures=0`，gameflow≥2、session≥1、eog≥1 | 通过 |
| 脚本模式 + 鉴权 | 相位按脚本推进；无 token 返回 401；`authFailures=1` | 通过 |

## 4. 测试夹具说明（可复现性）

- `tools/fake-lcu.js`：自签名 HTTPS 假 LCU（CN=127.0.0.1，测试用内嵌 PEM，非真实密钥）。提供：
  - `GET /lol-gameflow/v1/gameflow-phase`
  - `GET /lol-champ-select/v1/session`
  - `GET /lol-end-of-game/v1/eog-stats-block`
  - 控制接口 `GET /__control/state`、`POST /__control/phase`、`POST /__control/reset`
  - Basic `riot:<token>` 鉴权，失败返回 401 并计数；支持 `--script a,b` 脚本化相位与 `--advance-ms` 节流。
- `tools/fake-live-server.js`（既有）：HTTP 假 Live Client，返回 10 名选手、gameTime=812.4、4 条事件。
- `test/e2e.test.js`：spawn 上述两个夹具与 `src/main.js`，通过 `PORT/RIOT_LCU_PORT/RIOT_REMOTING_AUTH_TOKEN/LIVE_CLIENT_URL` 注入；测试结束统一 `stopRun`，不残留进程。

## 5. 未覆盖项与风险（真实客户端 / OBS 单列）

### 5.1 真实客户端（未覆盖）

1. **真实 LeagueClient LCU**：本次未连接真实客户端、未读取真实 lockfile/token。假 LCU 只覆盖 3 个端点；真实客户端的字段差异、401/403、连接重建、版本升级后的响应变化未验证。
2. **真实 Live Client Data（127.0.0.1:2999）**：需要实际对局；假 Live Client 走 HTTP，真实为 HTTPS 自签，虽然 `requestJson` 对两者都支持并关闭证书校验，但未做真实对局采样。
3. **国服 Ux 日志 / PowerShell 进程发现**：解析逻辑有单测，但本机真实客户端路径、权限与 933KB 日志解析未在真实环境复跑。

### 5.2 真实 OBS（未覆盖）

- 未连接真实 OBS + obs-websocket 5.x；未验证真实握手、鉴权、场景包、场景切换、录制/推流状态、断线重连与超时。
- 单测使用 fake WebSocket 验证了 op6 请求形状与状态映射，不能替代真实 OBS 联调。

### 5.3 其他未覆盖

- **Electron 安装包**：未运行 `npm run dist` / `dist:dir`；安装、升级、SmartScreen、托盘、单实例、端口顺延均需人工验收。
- **Overlay 视觉**：仅断言 HTML 200 与根节点；字体、间距、1920×1080 透明背景、OBS 浏览器源实际渲染未验证（`tools/shot-overlays.cjs` 未运行）。
- **性能与长稳**：未做长时间运行、内存增长、SSE 多客户端压力测试。

## 6. 已知观察项（非阻塞）

1. **`/api/sources` 的 Live 探测固定 :2999**：`src/data-sources.js:30` 的 `probeLiveClient(port = 2999)` 默认端口写死，`src/main.js:199` 无参调用；因此即使设置 `LIVE_CLIENT_URL`，该探测仍访问 `https://127.0.0.1:2999`。e2e 因此只断言 `source === 'live_client'`，不断言 `ok`。建议后续让探测接受 `LIVE_CLIENT_URL` 或显式端口。
2. e2e 使用自签名证书并设置 `rejectUnauthorized:false`，只验证协议/路由，不验证证书链；本地回环场景可接受。
3. e2e 依赖 3212–3219 端口空闲；若被其他进程占用会快速失败（设计上避免误连他人服务），在 CI 中需保证端口段可用。

## 7. 复现步骤

```bash
cd "C:\\Users\\RyeRaven\\Documents\\Codex\\2026-11-12\\windows-lol-mvp-1-lol-2"

# 全量测试
node --test

# 只跑端到端（会自行选择 3212–3219 中的空闲端口）
node --test test/e2e.test.js
```

预期：`node --test` 输出 `# tests 54 / # pass 54 / # fail 0`；e2e 输出 `# tests 2 / # pass 2 / # fail 0`。

## 8. 验收对照

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 假 LCU 实现 gameflow-phase / champ-select session / eog-stats-block 三端点 | 通过 | `tools/fake-lcu.js`；e2e Test 1/2 |
| 支持脚本化相位切换 | 通过 | e2e Test 2（ChampSelect→InProgress→PreEndOfGame） |
| 复用既有 fake-live-server | 通过 | e2e Test 1 spawn `tools/fake-live-server.js` |
| e2e 串 draft→in_game→post_game | 通过 | e2e Test 1 |
| 断言 `/api/state`、`/api/sources`、5 个页面 200、SSE ≥2 | 通过 | `test/e2e.test.js:192-285` |
| VERIFICATION.md 按模块列验证项/命令/结果/未覆盖 | 通过 | 本文件第 3–5 节 |
| 全量 `node --test` ≥30 例、0 失败 | 通过 | 54 tests / 54 pass / 0 fail |

## 9. 结论

自动化验证范围内（假 LCU + 假 Live Client + 单元测试）功能链路完整、结果稳定，**无阻塞项**。真实客户端、真实 OBS、Electron 打包与 Overlay 视觉属于环境依赖项，需在具备客户端/OBS/桌面环境的机器上按第 5 节人工补验；其中 6.1 的 `:2999` 探测固定端口建议作为后续改进项跟踪。
