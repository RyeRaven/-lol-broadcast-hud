# 四段链路端到端回归（Pipeline E2E）

本文记录 `test/pipeline-e2e.test.js` 覆盖的「假 LCDA → 协议流快照 → 像素条 → /events SSE → HUD DOM」链路，以及每一段的失败模式和观测点。

## 1. 四段数据流（文字版）

     [tools/fake-live-server.js]  (内核分配端口，模拟 Live Client Data :2999)
              │  GET /liveclientdata/allgamedata  (每秒一次)
              ▼
     [src/main.js pollLiveClient]
              │  normalizeLiveState(...)
              ▼
     [src/live-data.js normalizeLiveState / normalizePlayer]
              │  state.players + state.capability + state.protocolFeed + state.pixelBars
              ├──────────────────────────────────────────────┐
              │                                              │
     [POST /api/protocol-feed]                      [POST /api/pixel-bars]
       src/protocol-feed.js                            src/pixel-bars.js
       2s TTL、precision 门控                          2s TTL、按 (team, 行序) 映射
       csExact / gold / xp / kdaExact                  hpPercent / resourcePercent
              │                                              │
              └──────────────┬───────────────────────────────┘
                             ▼
                  [state] ── /api/state（快照）
                             └── /events SSE（每次 broadcast 全量 state）
                                      │
                                      ▼
                  [GET /broadcast/hud] HUD 页面脚本
                  barCells() / csMarkup() 渲染三条状态条与 CS

四段的职责边界：

1. **假 LCDA**：只负责给出一份固定的 10 人局内数据（summonerName、championName、team、level、scores 等）。它证明 `src/main.js` 的轮询和 `src/live-data.js` 的归一化能进入 live 局内状态。
2. **协议流快照**：通过 `POST /api/protocol-feed` 投递一包完整快照（恰好 10 名玩家）。每个玩家的 `cs` / `xp` / `gold` 与 KDA 三项都显式标 `precision: 'exact'`。它证明精确字段会覆盖 LCDA 的量化/缺失值，并把 `protocolDecode` 与 capability 升级成 exact。
3. **像素条**：通过 `POST /api/pixel-bars` 投递 20 条读数（10 人 × hp/resource）。它证明像素百分比按 (team, 队伍内出场顺序) 落到正确玩家，并让 `hpPercent` / `resourcePercent` 的 capability 变成 `estimated('pixel-bars')`。
4. **SSE + HUD**：先证明同一份数据出现在 `/events` 的至少 3 帧里（不是只有 `/api/state` 有），再从真实 `/broadcast/hud` 响应取页面脚本，在 vm 沙箱里用实际 state 渲染，断言生命条/资源条宽度、资源条颜色和精确 CS。

## 2. 每段的失败模式与观测点

| 段 | 失败现象 | 观测点（哪个字段能证明这一段活着） |
| --- | --- | --- |
| 假 LCDA | `/api/state` 没有 10 名玩家，或 `mode` 不是 live | `state.mode === "live"` 且 `state.players.length === 10`；`tools/fake-live-server.js` 的标准输出 "fake live client on <port>" |
| 协议流 | `protocolDecode` 为 false，`csExact` / `gold` / `xp` 为 null | `POST /api/protocol-feed` 返回 200 且 `body.players === 10`；`/api/protocol-feed/status` 的 `active/players/updatedAt`；`state.capability.fields.csExact.precision === "exact"` |
| 像素条 | `hpPercent` / `resourcePercent` 为 null，或条宽不匹配 | `POST /api/pixel-bars` 返回 200 且 `body.bars === 20`；`/api/pixel-bars/status` 的 `active/lastBars`；`state.capability.fields.hpPercent.precision === "estimated"` |
| SSE | 页面收不到更新，只有初次连接那一帧 | `/events` 至少 3 帧；帧内 `players[].csExact === 100`、`players[].hpPercent === 12`、`protocolDecode === true` |
| HUD | 条宽为 0、显示 ≈ 量化 CS 或 [object Object] | `barCells(player)` 含 `width:12.0%` / `width:34.0%`；`csMarkup(player) === "100"` 且不以 ≈ 开头；`/broadcast/hud` 返回 200 |

### 2.1 失效语义（TTL）

协议流与像素条都有 **2000ms TTL**（`PROTOCOL_FEED_TTL_MS` / `PIXEL_BAR_TTL_MS`）。测试最后停止 POST，等待超过 TTL 后必须看到：

- `/api/state.pixelBars` 变为 `{ active: false, stale: true }`；
- 每名玩家的 `hpPercent` / `resourcePercent` 变为 `null`（不是 0）；
- `capability.fields.hpPercent.precision` 降回 `unavailable`；
- HUD 的 `barCells` 画出 `hb-bar hp unknown`，所有 `width:` 都是 `width:0%`。

这条规则是链路的生命线：任何一段断流都必须显式降级，绝不保留旧百分比冒充当前值。

### 2.2 三条状态条的精度说明

HUD 的三条状态条是「经验 / 生命 / 资源」：

- 生命 / 资源：像素条只给百分比，capability 标 `estimated`，条宽与投递的 `fillPercent` 一致；
- 经验：当前 `live-spectate` 契约仍把 `xpProgress` 标 `unavailable`（Live Client Data 没有 experienceToNext，协议流的 xp 是累计值，不能直接当当前等级进度），所以测试断言经验条是 `hb-bar xp unknown` 而不是伪造宽度。将来引入 `xpProgressHi` 或经验区间字段后，这条断言会需要按新契约更新。

## 3. 如何本地跑

### 3.1 只跑这条回归

    cd C:/Users/RyeRaven/Documents/Codex/2026-11-12/windows-lol-mvp-1-lol-2
    node --test test/pipeline-e2e.test.js

不需要设置 PORT：测试内部用 `net.createServer().listen(0)` 让内核分配假 LCDA 端口和主服务端口；不会碰 3210/3211，也不会和并行测试抢端口。

### 3.2 跑全量（串行，避免端口竞态）

    node --test --test-concurrency=1

当前基线：166 个用例（t36 新增 1 个后应为 167）。串行跑是 CI 的基准跑法；并行跑也不应出现新的 EADDRINUSE，因为本测试完全使用内核分配端口。

### 3.3 负向对照（验证测试真的在把关）

把测试里协议流玩家的 `cs` 精度从 `'exact'` 改成 `'quantized'`，再跑：

    node --test test/pipeline-e2e.test.js

预期结果：测试失败，等待「协议流与像素条同时生效」超时（因为 precision 门控不会把 quantized 的 cs 写进 csExact，csExact 保持 null）。改回 `'exact'` 后恢复通过。这个负向对照证明测试确实在检查 precision 门控，而不是只看接口有没有 200。

## 4. 覆盖的断言清单

- 假 LCDA 启动后 `/api/state` 出现 10 名玩家，第一名是 Jayce；
- `POST /api/protocol-feed` 200，10 名玩家全部被接受；
- `POST /api/pixel-bars` 200，20 条 hp/resource 全部被接受；
- `/api/state`：`protocolDecode === true`，逐玩家 `csExact` / `gold` / `xp` 等于投递值，`csAsOf` / `xpAsOf` === 600，`hpPercent` / `resourcePercent` 等于投递值；
- capability：`fields.csExact.precision === "exact"`、`fields.csExact.source === "spectator-protocol"`、`fields.hpPercent.precision === "estimated"`、`fields.hpPercent.source === "pixel-bars"`；
- `/events`：至少 3 帧，至少一帧同时包含 `csExact=100`、`gold=10000`、`xp=9000`、`hpPercent=12`、`resourcePercent=34`，且该帧 `protocolDecode === true`；
- HUD：`barCells` 出现 `hb-bar hp`（宽度 12.0%）、`hb-bar res`（宽度 34.0%）、资源条颜色 `rgb(49,138,232)`；`csMarkup` 为 "100" 且无 ≈；经验条为 unknown；
- 停 POST 后：`pixelBars.active === false`、`pixelBars.stale === true`、`hpPercent === null`、`capability.fields.hpPercent.precision === "unavailable"`、HUD 生命条 unknown 且宽度全 0；
- 服务进程 `exit === null`，stderr 不含 `unhandledRejection` / `uncaughtException`。

## 5. 相关文件

- 测试：`test/pipeline-e2e.test.js`（本文件新增）
- 假 LCDA：`tools/fake-live-server.js`（现有）
- 主服务：`src/main.js`（`pollLiveClient` / `broadcast` / `/events`）
- 数据归一化：`src/live-data.js`（`normalizeLiveState` / `normalizePlayer`）
- 协议流接收：`src/protocol-feed.js`（`createProtocolFeedStore` / `applyProtocolToPlayers`）
- 像素条接收：`src/pixel-bars.js`（`createPixelBarStore` / `applyBarsToPlayers`）
- 契约矩阵：`src/data-capability.js`（`buildCapabilityMatrix` / `applyProtocolAvailability` / `applyPixelBarsAvailability`）
- HUD 页面：`src/pages/hud-broadcast.js`（`barCells` / `csMarkup`）