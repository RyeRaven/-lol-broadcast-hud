# 协议流接入层（PROTOCOL FEED）

观战协议流（0xdd 关键帧）的解码结果由**同机独立进程**产出，经本地 HTTP 喂给 RiftBroadcast 主进程，
再随 `/api/state` 与 `/events` 下发到 HUD / 控台。这一层与像素读条（`src/pixel-bars.js`）同构、互不干扰：
协议流负责 **KDA / 精确补刀 csExact / 金币 / 经验 / 秒级事件**，像素读条负责**血条与资源条百分比**。

> 一句话原则：**解不出的值一律是 `null`，并在 capability 里标 `unavailable`。**
> 绝不用 `estimateTeamGold`、LCDA 的 `creepScore` 或上一包旧值顶替精确值。

## 1. 数据链

```
解码器进程（Python/Node，读 .rofl 语料或实时 observer REST）
        │  POST http://127.0.0.1:<PORT>/api/protocol-feed   (1Hz 重发最近状态)
        ▼
src/protocol-feed.js   normalizeFeed 整包校验 → createProtocolFeedStore（TTL 2000ms）
        ▼
src/main.js            protocolResolver() → normalizeLiveState({ protocol })
        ▼
src/live-data.js       protocolFields → 逐玩家 csExact/gold/xp/csAsOf/xpAsOf/kdaExact
        ▼
src/data-capability.js capability 矩阵（exact / quantized / estimated / unavailable）
        ▼
/api/state + /events SSE → HUD 按契约决定画不画、标不标「60s 前」
```

## 2. 端点

### POST /api/protocol-feed

只接受**回环地址**（`127.0.0.1` / `::1` / `::ffff:127.0.0.1` / `::ffff:7f00:1`），
响应**不设 `Access-Control-Allow-Origin`**（内部写接口，浏览器不该能直接打）。
body 上限 1MB，超过返回 `413 { ok:false, error:"payload_too_large" }`。

请求体：

```json
{
  "source": "live",
  "gameId": "6771234567",
  "gameTime": 812.4,
  "updatedAt": 1794509940336,
  "players": [
    {
      "netid": "0x400000ae",
      "participantId": 1,
      "team": "blue",
      "championName": "Jayce",
      "kills": 3, "deaths": 1, "assists": 4,
      "cs": 142, "totalGold": 12345, "xp": 9876,
      "asOf": 780
    }
  ],
  "events": [
    { "t": 700.001, "type": "kill", "killer": 1, "victim": 6, "assists": [2, 3], "confidence": 1.0 }
  ]
}
```

字段约束（任何一条不满足 → 整包 `400`，**绝不部分写入**）：

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `source` | `"live"` / `"corpus"`，缺省 `"live"` | 数据来自实时 observer 还是离线语料 |
| `gameId` | 字符串或数字，非空 | 对局标识 |
| `gameTime` | 非负有限数，缺省 0 | 这一包对应的游戏时间（秒） |
| `updatedAt` | 非负有限数或 null | 毫秒时间戳，仅用于诊断 |
| `players[].netid` | 可空；给了必须匹配 `/^0x[0-9a-fA-F]+$/` | 回放/语料解码器解不出 netid，**绝不伪造** |
| `players[].participantId` | 1..10 的整数 | 同包内**不得重复** |
| `players[].team` | `"blue"` / `"red"` / null | 归一化后的队伍 |
| `players[].kills/deaths/assists/cs/totalGold/xp` | `>=0` 的**整数**或 null | **字符串一律拒绝**（解码器最常见的口误） |
| `players[].asOf` | 非负有限数或 null | 这些数值对应的关键帧时刻（秒） |
| `players[].championName` | 非空字符串或 null | 可选的对齐线索（首选身份） |
| `players[].puuid` | 非空字符串或 null | netid 缺席时的稳定身份（语料里有） |
| `players[].precision` | 每字段 `exact`/`quantized`/`estimated`/`unavailable` | 缺省 `estimated`（fail closed，见 §9.2） |
| `events[].t` | 非负有限数 | 事件游戏时间（秒） |
| `events[].type` | `kill` / `death` / `assist` | |
| `events[].killer/victim` | 1..10 或 null | |
| `events[].assists` | participantId 数组 | |
| `events[].confidence` | 0..1 或 null | |

成功响应：`200 { ok:true, accepted:true, committed:true, duplicate:false, rewind:false, reset:false, jump:false, reason:"advance", active:true, updatedAt, players:10, events:12 }`。
即使 `accepted:false`（stale_frame）也返回 200——原因放在 body 里，生产者可以记录但不会重试风暴（见 §9.3）。

### GET /api/protocol-feed/status

```json
{
  "ok": true, "active": true, "updatedAt": 1794509940336, "ageMs": 120,
  "stale": false, "ttlMs": 2000, "gameId": "6771234567", "gameTime": 812.4,
  "players": 10, "events": 12, "lastFeed": { "players": [], "events": [] }
}
```

`active=false` 且 `stale=true` 表示**曾经收到过包但已超过 2000ms 没更新**；
`lastFeed` 在失效时为 `null`——诊断接口也不会把旧包当当前值展示。

## 3. 时效（TTL 2000ms）

协议流关键帧本身 60s 一跳，但喂数据的进程按 1Hz 重发最近状态，所以 TTL 与像素读条一样取 2000ms：

- 每次 `commit` 整体替换上一包（不做增量合并，避免拼出一个从未存在过的状态）；
- 超过 2000ms 无新包 → `snapshot()` 直接返回 `active:false`、`players:[]`、`feed:null`；
- `src/main.js` 的 `refreshProtocolFeed()` 每秒把逐玩家的 `csExact/gold/xp/csAsOf/xpAsOf` 清成 `null`，
  并把 capability 里对应字段降回 `unavailable`；
- **KDA 是例外**：KDA 本身永远是精确值（协议流和官方 REST 都给），所以失效时不会标 unavailable。
  但来源标记**只在「协议流可用」这个方向上切换**：失效瞬间玩家对象上仍是协议流解出的 KDA，
  此刻把 source 改成 `live-client-data` 就是错标；等下一轮 LCDA 轮询重建玩家状态时，
  KDA 数值与来源会一起回落，两者始终一致。

## 4. capability 契约变化

| 字段 | 协议流可用 | 协议流失效 |
| --- | --- | --- |
| `csExact` / `totalGold` / `xp` | `exact`，source `spectator-protocol` | `unavailable` |
| `csAsOf` / `xpAsOf` | `exact`，source `spectator-protocol` | `unavailable` |
| `kills` / `deaths` / `assists` | `exact`，source `protocol-feed` | `exact`，source `live-client-data` |
| `cs`（LCDA 量化值） | 始终 `quantized`，quantum=10 | 同左 |

`csAsOf` / `xpAsOf` 是本层新增的两个契约字段：**精确值必须自带它对应的游戏时刻**。
关键帧 60s 一跳，页面上不标「N 秒前」就等于把 60s 前的数字冒充当前值。

## 5. 对齐规则

LCDA 的 `allPlayers` 没有 `participantId`，只能靠线索对齐：

1. **英雄名优先**（大小写无关）：`players[].championName` ↔ LCDA 的 `championName`；
2. 否则按**（队伍, 队伍内出场顺序）**游标对齐，与像素读条同一依据，不按屏幕坐标猜；
3. **一条记录只能被一个玩家认领**（`claimed` 集合）：英雄名匹配失败的玩家不会顶替别人已经拿到的数据。
   两名玩家显示同一份 cs/gold/xp 比没有数据更糟。

## 6. 为什么没有实时血量/法力

协议流的血量/法力已被 6 条独立路径证伪（含全 record oracle 全负），**永远不从协议流取**。
血条/资源条走像素读条（`docs/PIXEL-BARS.md`），只给百分比、没有绝对值。

## 7. 复现

```bash
cd C:/Users/RyeRaven/Documents/Codex/2026-11-12/windows-lol-mvp-1-lol-2

# 单元 + 端到端（会自己起假 LCDA 与真服务，端口由内核分配）
node --test test/protocol-feed.test.js

# 手工打一遍真实服务（绝不碰 3210）
PORT=3314 node src/main.js &
curl -s -X POST http://127.0.0.1:3314/api/protocol-feed -H "Content-Type: application/json" -d @feed.json
curl -s http://127.0.0.1:3314/api/protocol-feed/status
curl -s http://127.0.0.1:3314/api/state | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.players[0].csExact, j.players[0].csAsOf, j.capability.fields.csExact)})"
```

## 8. 测试覆盖（test/protocol-feed.test.js）

| 用例 | 钉住的约束 |
| --- | --- |
| 合法包被接受 | 缺省 `source=live` / `gameTime=0`，没给 cs 就是 null |
| 非法包整包拒绝 | 字符串 cs、越界 participantId、重复 netid、负数 asOf 一律 400 |
| 超过 2000ms 失效 | `active=false`、`players=[]`、`updatedAt` 仍保留用于诊断 |
| 对齐规则 | 英雄名优先、行序兜底、记录不重复认领、队伍不明不猜 |
| `applyProtocolToPlayers` | 每轮重写、KDA 三项齐全才覆盖、缺一项保持 LCDA |
| 契约双向切换 | 升 exact / 降 unavailable 幂等；`cs` 永远是 quantized |
| `normalizeLiveState` 集成 | 精确值与 asOf 一起透传，无协议流时全 null |
| HTTP 层 | 非回环 403、无 CORS 头、非法包 400 不污染状态、status 形状 |
| 真实服务端到端 | 喂包后 /api/state 出现精确值，2s 后回 null 且契约降级，进程存活 |
| 2MB 请求体 | 413 `payload_too_large`，服务存活（B1 教训回归） |

## 9. t31 契约更新：netid 可选 / precision 门控 / 乱序策略

### 9.1 身份与对齐（netid 改为可选）

语料与回放解码器（`.tmp/spectator/decode/decode_0xdd.py`）解不出 netid，只给 puuid / championAlias。
因此 `netid` 从必填改为**可选**：

- 不给就是 `null`，**绝不伪造** `0x4000000N` 这类假 id；
- 给了就必须匹配 `/^0x[0-9a-fA-F]+$/`，非法值整包 400；
- 玩家识别优先级：**championName > puuid > participantId**；
- 一条记录只能被一个玩家认领（`claimed` 用 `puuid:` / `netid:` / `participant:` 前缀的稳定 identity，绝不允许两名玩家共享一份数据）。

### 9.2 精度门控（precision）

每个玩家可以声明每个字段的精度：

```json
{
  "participantId": 1,
  "championName": "Jayce",
  "kills": 3, "deaths": 1, "assists": 4,
  "cs": 142, "totalGold": 12345, "xp": 9876,
  "precision": { "kills": "exact", "deaths": "exact", "assists": "exact", "cs": "exact", "totalGold": "exact", "xp": "exact" },
  "asOf": 780
}
```

| precision | 是否进 csExact / gold / xp / kdaExact | 说明 |
| --- | --- | --- |
| `exact` | 是 | 只有解码器能证明精确的字段才允许 |
| `quantized` | 否 | 如 cs 的 10 量化值，只能走 LCDA 的 `cs`（quantized） |
| `estimated` | 否 | 插值/推测值 |
| `unavailable` | 否 | 解不出 |
| 未声明 | 否（默认 `estimated`） | **fail closed：没声明就不许标 exact** |

KDA 三项（kills/deaths/assists）必须全部 `exact` 且都有值才覆盖 LCDA；缺一项/有一项不是 exact，整组不覆盖，绝不用 0 补齐。

### 9.3 乱序策略（全部返回 HTTP 200，原因在 body）

| 场景 | 判定 | 行为 | 响应标记 |
| --- | --- | --- | --- |
| 第一包 | `latest` 为空 | 接受 | `reason:"first_packet"` |
| 跨局 | `gameId` 变化 | 接受并整体替换 | `reset:true, reason:"game_changed"` |
| 1Hz 心跳/重复帧 | 同局且 \|ΔgameTime\| < 0.05s | 只刷 TTL，**不广播** | `duplicate:true, reason:"duplicate"` |
| 回放拖动 | 同局且倒退，`source:"corpus"` | 接受 | `rewind:true, reason:"rewind"` |
| 实时源时间倒退 | 同局且倒退，`source:"live"` | **丢弃这一帧，不清空已有数据**（保持上一帧直到 TTL 过期） | `accepted:false, reason:"stale_frame"` |
| 回放跳转 | 同局且前进 > 600s | 接受 | `jump:true, reason:"jump"` |
| 正常前进 | 同局且 0.05s ≤ Δ ≤ 600s | 接受 | `reason:"advance"` |

> 关键：`stale_frame` 不写 `latest`、不刷 `at`、不计入 `commits`。旧帧仍在缓存里，直到它自然超过 2000ms TTL。

## 语料回放桥（t32）

`tools/protocol-corpus-replay.cjs` 把 obs4 解码产物（`C:/Temp/obs4/dec8/*.json`；
`dec_check.json` 为真值校准版）按帧 POST 到本接口，用于端到端验收：

```bash
node tools/protocol-corpus-replay.cjs --file C:/Temp/obs4/dec_check.json \
     --url http://127.0.0.1:3314/api/protocol-feed [--interval-ms 1000] [--speed 1] \
     [--frames N] [--start N] [--loop] [--conservative] [--dry-run]
```

精度矩阵（默认，`--conservative` 回落产物标签）：

| 字段 | precision | 依据 |
| --- | --- | --- |
| kills / deaths / minionsKilled | exact | 产物 exact + floor 校验 100%（300/300） |
| cs | exact | minions exact cov1 + jungle floorPass 296/299（约 1% 帧可能 ±1，远好于 LCDA 的 10 步量化） |
| xp / totalGold | exact | floor(decoded)==真值 100%（n=256/252）；解码缺口帧发 null |
| assists | estimated | union rank 不严格；LCDA 的 KDA 本身可信，协议流不抢 KDA（kdaExact 不触发） |

team 按 Riot 观战协议约定 participantId 1..5=蓝、6..10=红 推 side；
events 由 KDA 序列逐帧增量合成 kill（killer/victim 贪心配对，confidence 留空）。
接收端英雄名对齐键会去掉非字母数字（`DrMundo` ↔ `Dr. Mundo` ↔ `Kai'Sa`）。

单帧真值速查（901131919780 末帧）：kills=[2,9,13,4,4,6,9,8,4,1]、
cs=[179,165,207,219,38,242,200,226,205,30]、totalGold≈[9620,…,8720]。
