# TASKS.md — 当前任务、进度与待办事项

> 最后更新：2026-11-13。配套 `PROJECT.md` / `ARCHITECTURE.md` / `CONVENTIONS.md` / `CHANGELOG.md`。
> **当前最重要的一条：用户处于「只讨论、先理解」阶段，未说「开工」前不要改任何代码。**

## 1. 当前状态速览

- 团队 `riftbroadcast-team`：`phase=running`、`halted=false`、**`escalated=true`（`loop_state='escalated'`，自动 review/repair 循环触顶，不要再造一轮 needs_revision，应向用户升级请示）**、`members=[]`（6 个 hy4 成员已按用户「把动画效果给我看就行」的要求全部 remove，子任务已停）、`deliverable=false`。
- 37 个任务中 30 个 completed；**7 个 pending 且全部在共享池（无 assignee）**：t8、t24、t28、t32、t34、t35、t36。
- 本轮用户请求（m03265）：「我要换模型了，你给我写这些文件便于切换模型维护」→ 产出本目录 5 份交接文档；本任务**进行中/本次完成**。
- 交付阻塞（来自 `agent_teams_status`）：`team requires escalation resolution` + t32/t8/t24/t28/t34/t35/t36 未完成。

## 2. 待办 A：0.2.0 发布与审查收尾（团队回池任务）

| 任务 | 类型 | 依赖 | 内容 |
| --- | --- | --- | --- |
| t28 | review | t27 | review-round-3；已交付 `REVIEW.md` 但 verdict=needs_revision（failed），不阻塞发布链 |
| t35 | repair | t27 | repair-round-4：修 t28 的 B1/H1（live mock 选手与旧 postgame 假数据）；此前 attempt 9 in_progress，现已回池 |
| t36 | review | t35 | review-round-4：独立复审 t35 |
| t34 | review | t33 | 复审 BP 广播页 1366/1920 与 DEMO 空态修复 |
| t24 | review | t23 | review-round-2 |
| t8 | review | t7 | 全仓审查并输出 `REVIEW.md` |
| t32 | work | t16,t20,t30,t31,t34,t36,t37 | **发布 0.2.0 安装包与打包完整性检查** |

**t32 发布前必须核对的已知不一致**：`package.json` version=`0.2.0`，`README.md` 写产物为 `release\RiftBroadcast Setup 0.2.0.exe`，但 `DEVELOPMENT_LOG.md` 与 `docs/USER-GUIDE.md` 记录的实际打包产物是 `release\RiftBroadcast Setup 0.1.0.exe`（242,291,637 字节）。需重新打包并统一文档中的版本号与产物名。

### 2.1 REVIEW.md 未闭环缺陷清单（修复时逐条对照）

- **B1'（Blocker，发布阻断）**：`src/obs.js:554-579` 的 `/api/obs/connect` 中 `readBody(req,res).then(body => {...})` 无外层 `.catch`（唯一 .catch 在 :572 只包住内层 `obs.connect()`）；`src/main.js:382` 同步调用 `handleObsApi()` 无 try/catch；全项目无 `process.on('unhandledRejection')` / `uncaughtException` 兜底。>1MB body（`MAX_BODY_BYTES=1024*1024`）或 req error 时 `readBody` 已发 413 又 reject，Node 15+ 默认 throw → **整个本地 HTTP 服务退出，直播所有 overlay 断流**。又因 `json()` 带 `Access-Control-Allow-Origin: *`，任意网页可用 text/plain 简单请求远程触发。requiredFix：①`src/obs.js:555` 补 `.catch(fail)`（fail 在 :540-544，或改用 :545-552 的 `run()` 包装）；②`src/main.js` 补 `process.on('unhandledRejection')` 与 `uncaughtException` 日志兜底；③回归测试：2MB body → 413 且服务存活、malformed JSON → 确定 4xx/5xx、其余 `/api/obs/*` POST 的 413 不退出。
- **H1（High）**：t27 的 live 假数据 / 旧 postgame 缺陷尚未经正式复审闭环。当前工作树已有缓解（`src/app-state.js:64-65`、`src/main.js:75-84` `resetLiveGameData()`、`src/pages/bp-broadcast.js:157-176`、`src/pages/overlays.js:278-297`、`src/pages/result-broadcast.js:268-270`），但来自 t35/t33 且未过 t36。回归测试：`savedConfig.mode==='live'` 启动时 `/api/state.players` 为空、live BP 不出现 TopStar/RiftKing、连续两局不继承上一局选手、live 无数据时 BP/HUD/postgame 均 DEMO 空态、`postGame===null` 时旧 postgame overlay 不回退 mock。
- **M1** `src/main.js:304,306`：`raw += chunk` 把 Buffer 拼字符串，中文 UTF-8 跨 chunk 损坏为 U+FFFD；`JSON.parse` 失败静默 `resolve({})`，畸形 body 被当空对象（`/api/config` 返回 200 什么都没改）。修：`Buffer.concat(chunks).toString('utf8')`、`reject(badRequest('invalid_json'))`、补中文跨 chunk 与 malformed JSON 用例。
- **M2** `src/app-state.js:78`：`saveConfig()` 空 catch 吞掉磁盘/权限错误。修：`console.error('[saveConfig]', error)`、返回布尔或抛错并经 API 回传可诊断信息、控台 toast。
- **M3** `src/obs.js:310-324`：`refresh()` 用 `Promise.all` 且 `getSceneList()` 无独立 .catch，单个失败整体 reject → `state.obs.scenes` 不更新、控台误判断开。修：逐请求 .catch 或 `Promise.allSettled`，失败记 `state.obs.errors[request]`。
- **M4** `src/main.js:176,224,282`：三个 `setInterval` 不等待异步轮询，网络慢时重叠写 `state`。修：in-flight 布尔 / `AbortController` 或 `setTimeout` 递归；phase 单一来源（只允许 LCU 写 phase，Live Client 只写数据）。
- **M5** `electron/main.cjs:223-226`：`setWindowOpenHandler` 对任意 target 调 `shell.openExternal(target)` 无 scheme 白名单。修：仅允许 http/https 可信域，其余 deny 并记录日志。
- **L1** `src/assets.js:152-157`：`championSplashUrl` 调用 `normalizeVersion(version)` 却丢弃返回值，缓存键 `'splash|'+key` 无版本（splash 路径本身不含版本段，影响极小）。
- **L2** SSE `onmessage` 空 catch：`src/pages/bp-broadcast.js:454`、`src/pages/console.js:1255`、`src/pages/hud-broadcast.js` PAGE_SCRIPT、`src/pages/overlays.js:308-315`。修：`console.warn` 一次并按帧序号限流。

### 2.2 视觉验收遗留（`VISUAL-QA.md`，t29）

`/broadcast/bp` 在 1366×768 底部横带内容溢出 21px、角色行/PATCH 不可见 → needs_revision（t33 已修、待 t34 复审）。`/broadcast/hud`、`/broadcast/result`、`/overlay/transition` 在 1920 与 1366 均 pass。截图在 `.tmp/visual-qa/{1920,1366}-{draft,ingame,postgame}/`。

## 3. 待办 B：底部 HUD 重做与 BP 锁定动效（当前讨论，未开工）

### 3.1 用户原话与范围

- User said (m03093): 「我先跟你说几个问题bp页面我也需要动效，英雄在锁定时候需要动效果，其次局内hud面板底部看我给你的不要双方分开要一整块的，大小比例按我给你的图，双方不应该都是英雄头像靠左，应该两边中心对称，我给你又截图了一次，你按这个hud思路，你先拆解其中元素，有不明白的问我，先完全理解」
- User said (m03113): 「我在给你一张整体图，你用这个来算hud尺寸，要保留的只有下方积分版。左边的三层元素下方广告牌，中间英雄的状态信息，上方赛事信息，其中英雄状态信息为游戏自带，保留广告牌，和赛事信息这两条，但是把他们做成可编辑的，两边选手摄像头舍弃，右端小地图游戏自带，你说你的理解」
- 范围结论：**只保留下方积分版 + 左塔上下两层（赛事信息 + 广告牌，做成可编辑）**；舍弃左塔中层英雄状态（游戏自带）、两侧选手摄像头、右端小地图（游戏自带）；画面上半部分（游戏画面、顶部比分条、野怪计时、旗帜）全是游戏自带，不进 overlay。

### 3.2 尺寸实测（开工以此为准）

参考图 m03112 为 2332×1309（16:9）全屏截图。实测 HUD 条顶边 y≈990（画面 75.6% 处）、高 ≈319px、占屏高 24.4%、宽高比 7.3:1；**换算 1920×1080 下顶边 y≈817、高 ≈263px**。5 行分隔线 y=993/1056/1119/1182/1245/1305，行高 63px。分区（原图 px）：左信息塔 0–340、左摄像头 340–565、中央记分板 565–1770（宽 1205）、右摄像头 1770–1990、右小地图 1990–2332；换算 1920 宽：塔 0–280、左摄像头 280–465、记分板 465–1457（宽 992）、右摄像头 1457–1638、小地图 1638–1920。中线 x≈1166 = 整屏中心，记分板严格居中。
测量脚本：`.tmp/hud_measure.py`、`.tmp/hud_measure2.py`（PIL+numpy 逐行暗像素占比 + 水平梯度找边界）；坑：必须用 `acp_read_original_image` 恢复的原图，直接用 .dsh/attachments 归一化副本会全图全暗、结果无效。
参考图：`docs/reference/ingame-hud-reference.jpg`、`docs/reference/bp-lineup-reference.jpg`；放大裁切在 `.tmp/`：`hud_left.png`、`hud_center.png`、`sb_row1.png`(2440×136)、`sb_blue.png`(1220×642)、`sb_mid.png`(720×1284)、`sb_red_outer.png`(690×963)。

### 3.3 积分版内部元素（用户 m03161 已逐条确认，逐字）

User said (m03161): 「1.外沿数字是视野得分.2装备栏里有的是消耗型数字是数量有的是叠层型数字是层数3，竖排两格有两列，离头像远的那列由上到下是英雄的符文基石和分路任务，离头像近的那列则是召唤师技能4.头像和名字之间的彩色圆徽是英雄的大招，5.名字下方有共有三条状态条，从上至下，紫色的是经验条，绿色的是生命条，最下面一条代表资源条大部分是蓝条也有特殊机制英雄和无蓝条英雄这一条我们过会特殊讨论，6中线的是对位经济差这个数字两边谁领先便用不同颜色指示条指向领先方，7先讨论底部hud，8装备符文这些实时状态能够抓取到吗，如果能抓取到或者有办法直接获得原生状态最好，讨论一下理解」

骨架：5 行 × 两队、严格以中线镜像、行高 63px、近黑不透明底、上下蓝红渐变光带、行间细灰线。单行从外沿到中线：外沿数字（视野得分）+ 金色徽记 → 装备/消耗品/饰品栏（角标分「消耗型数量」与「叠层型层数」）→ 两列竖排格（远头像列：符文基石 + 分路任务；近头像列：召唤师技能）→ 英雄头像 → 彩色圆徽（大招）→ 等级 → 选手名 → 三条状态条（紫经验/绿生命/资源条）→ CS（金）→ KDA（白）→ 中线对位经济差 + 领先方颜色指示条。红队完全镜像。

### 3.4 数据源查证结论（第 8 条）

- 项目**早已接入** Riot Live Client Data API：`src/main.js:28` `LIVE_CLIENT_URL`、`:182` 轮询 `/liveclientdata/allgamedata`；`src/live-data.js:242 normalizeLiveState`、`:18 normalizePlayer` 已拿 `scores.wardScore`；但 `items` 被压成 displayName 字符串丢了 itemID/count/slot/price，`runes` 完全没解析，`summoners` 丢 id。
- 官方字段边界（https://developer.riotgames.com/docs/lol）：`allPlayers[]` 有 championName/isBot/isDead/items/level/position/rawChampionName/respawnTimer/runes{keystone,primaryRuneTree,secondaryRuneTree}/scores{assists,creepScore,deaths,kills,wardScore}/summonerSpells/summonerName/team；`abilities` 与 `championStats(currentHealth/maxHealth/resourceValue/resourceMax)` **只在 activePlayer（本机一人）**，十人没有；无经验值、无逐人金币（只有 `activePlayer.currentGold`）、无分路任务字段。
- 项目自己写了 `src/live-data.js:9` 注释「Live Client Data 没有金币字段…不要伪造一个官方金币」，改用 `GOLD_WEIGHTS` 估算队伍总经济，`state.goldEstimated` 标记。
- 赛事服 GRID 独家商业分发 in-game data；RiotGames/developer-relations#216（2020-01-03 开、至今 Open）请求为 esports broadcasts 扩展 Live Game Data API，佐证广播级十人状态未开放。
- 非官方赛事 feed（vickz84259/lolesports-api-docs 的 openapi.yaml）：`GET https://feed.lolesports.com/livestats/v1/window/{gameId}` 给 `participantStats.totalGold/currentHealth/maxHealth`；`/details/{gameId}?startingTime&participantIds` 给 `extendedParticipantStats.items(最多7个id)/perkMetadata(9 perks)/abilities`（abilities 只是加点顺序，非大招 CD）；`x-api-key` 公开常量 `0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z`；限制：非官方、只对有 esportsGameId 的正式赛事有效、社区称约 10 分钟 competitive delay（无官方 SLA）。
- Riot 官方公告「Game Memory Access Removed for Third Party Apps」（2026-09-29 发布、2026-10-06 生效、已知工具宽限至 2027-04）原文 `"sunset those features where no good alternatives remain"`；floh22/LeagueBroadcast README 原文 `"# This repo no longer functions due to the introduction of Vanguard."`。
- 开源项目处理手法：LHM.gg 用 OCR 读游戏内 Tab 记分板 + match bar（`"For most of the data, we use OCR"`），字段恰等于可见内容，四缺项照样读不到；RCVolus/league-prod-toolkit 靠被动内存读取（Farsight）做 Custom Scoreboard 与 Gold/XP leaderboards，但 `"only covering the ingame scoreboard to keep dragons visible"`（盖在游戏自带记分板上的一层，与用户思路相反），且 observer-tool 已因 Vanguard 封禁风险禁用内存读取；Farsight 明写 `"!Not possible: Aggregate player stats: (Kills, Deaths, Assists, CS, Vision Score)!"`；ss26367098/rofllens（.rofl 回放解析）用 `verified/candidate/unknown` 三档、原文 `"RoflLens never turns an unverified guess into a confirmed game event"`，中文 README 明列「尚未解析：…经验来源…」；lzskyline/LeeSin 纯 LCU（Electron+React+TS），其 champ-select 监听是「BP 锁定动效」触发源的现成参考；RiotGames/leaguedirector 是官方 Replay API 参考实现（赛后运镜）；SolitudeRA/LoL-Esports-Broadcasting-Guide 直接发 `champion-status-placeholder.png`/`scoreboard-placeholder.png`/`minimap-placeholder.png` 三张占位图，印证「英雄状态与小地图游戏自带、舍弃」的判断；RiftBroadcast.de 是德国商业同名 SaaS（Companion 读 Riot live game API、`"Everything is live-editable while you are on air"`），非本项目。
- **总结论**：没有开源项目真正做出「一整块 + 中心对称 + 十人逐行带三条状态条」的底部 HUD，这块得从零做；「可编辑」被三个独立项目做成一等公民（RiftBroadcast live-editable、LHM `hud.json/display_settings`、OSL Manage team information）。四缺项（紫经验条、资源条、大招圆徽、分路任务）+ 装备角标语义 + 召唤师技能 CD 现在没有合规渠道。

### 3.5 待用户拍板的 4+ 项（不要自行决定）

1. 对位经济差：用 `GOLD_WEIGHTS` 估算 / 手填 / 纯可编辑 / 接 lolesports livestats 真算？
2. 三条状态条 + 大招圆徽 + 分路任务：做装饰占位还是「宁缺毋假」（建议按 `verified/candidate/unknown` 三档标注）？
3. 数据路线选 A / B / D？**A（倾向）**＝Live Client 自动填能拿的 + 改 `normalizePlayer` 保留 itemID/count/slot/runes/spell id + 官方不给的做可编辑；**B**＝先不动数据层、HUD 全走可编辑配置；**C**＝GRID 商业授权（不建议）；**D**＝可选接 lolesports livestats（仅正式赛事、带延迟）。不新增 OCR 路线 E（本机跑客户端时 Live Client Data 已是 OCR 的超集且更准）。
4. 资源条特殊机制英雄 / 无蓝条英雄：待专项讨论（m03161 用户明确「这一条我们过会特殊讨论」）。
5. 早前仍待确认：「可编辑」的确切范围、1920 下宽度分配（是否保留摄像头/小地图空位）、OBS 透明底、验收方式（是否仍出 Electron 实拍 + GIF）、BP 锁定动效的触发源 / 形态与时长 / 未锁定与已锁定的静态差异。

## 4. 已完成里程碑（摘要，详见 `CHANGELOG.md`）

t1 模块化拆分（24/24）、t2 Data Dragon 图标（44/44）、t3 控台重做（104/104）、t4 时间线与 watchdog（44/44）、t5 OBS 深度集成（48/48）、t6 Electron NSIS 打包（31/31）、t7 端到端验证（54/54，`VERIFICATION.md`）、t9–t23 广播配置/动画端三页/OBS 场景包/cue API/文档/控台接入、t25–t27 经济估算/精彩事件/修复轮、t29 视觉验收、t30 快捷键、t31 自动导播规则引擎、t33 BP 1366 适配、t37 自动导播规则面板。动画效果预览（3 个 GIF + 1 张总览图）已交付并 present。

## 5. 恢复与协作约定（给切换后的模型）

- **用户工作规则（务必遵守）**：① 提问题/需求时先只听不干——先复述理解、等他明确说「开工」才动手排查或改动，擅自开工算违规；② 要求从根因解决问题，不靠不断追加补丁；③ 输出风格已满意时只修 bug、不重做整体输出；④ 不确定的技术问题优先上网查官方文档/源码/issue/成熟开源实现，查到后给「结论 + 出处」，不要只贴链接；⑤ 做 A/B 方案对比时须把每个方案的全部原文回复直接贴出。
- **团队恢复**：用户说「继续」或额度恢复后再启动；`add_member` 必须**省略** `provider/model/reasoning_effort` 才继承 captain 当前路由（显式写死曾导致 WorkBuddy 429 Credits exhausted）；成员路由在 spawn 时固定，需 `remove_member` + 重加；旧成员名一次性占用，需起新名 `*-r2`。全部 7 个 pending 任务在共享池，重新派发前先 `agent_teams_status` 核对。团队当前 escalated（审查循环触顶），恢复后先向用户请示如何收敛，不要自动再开一轮 review/repair。
- **验证基线**：`node --test` 全绿（最近记录 104/104，`VERIFICATION.md` 为 54/54 的历史基线）；`node --check` 三个入口；测试端口只扫 3212–3219，**绝不触碰 3210**（用户常驻服务）与 3211/3215 上的其他进程；`tools/shot-overlays.cjs` 做视觉实拍；真实 LCU / OBS 联调需用户配合。

## 6. 开放目标清单

- 写 5 份交接文档（m03265）——本次完成。
- BP 页面英雄锁定动效（m03093）——未开工，待「开工」与触发源确认。
- 底部 HUD 重做成一整块 + 中心对称（m03093、m03113、m03161）——理解阶段，待「开工」与 3.5 节 5 项确认。
- 资源条特殊机制 / 无蓝条英雄专项讨论（m03161）——待用户发起。
- 0.2.0 收尾：t34/t35/t36/t32 与 REVIEW 缺陷闭环（m02890 等）——团队回池，待额度恢复说「继续」。
