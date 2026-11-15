# REVIEW.md — RiftBroadcast 第 3 轮代码审查（t28 / attempt 2 复审）

- 审查对象：**t27（repair-round-3）**；审查任务：t28（review-round-3），attempt 2
- 审查范围（9 个文件/模块）：`src/main.js`、`src/pages/*`、`src/app-state.js`、`src/assets.js`、`src/live-data.js`、`src/timeline.js`、`src/obs.js`、`src/post-game.js`、`electron/main.cjs`
- 审查维度：错误处理、资源泄漏、并发/时序、安全（token 泄漏 / 路径注入）、可维护性
- 审查方式：逐文件静态阅读 + 关键数据流与调用链核对；**未运行 node --test / npm / electron-builder，未启动服务器，未触碰 3210**（用户 CPU/磁盘暂停窗口；与 attempt 1 一致）。
- **结论：needs_revision**（不能 completed）
- **统计：Blocker 1；High 1；Medium 5；Low 2**

## 1. 复审基线说明（重要）

attempt 1（REVIEW.md，mtime 03:50）给出 `needs_revision / blocker=1`，B1 为「live BP/HUD 读取 mock/上一局选手」、H1 为「旧 /overlay/postgame 赛后假数据」。本轮复审确认：

1. **t27 交付的这两处缺陷成立**（证据见 §5），t28 对 t27 的结论不因后续改动而翻转。
2. 当前工作树已出现针对 B1/H1 的缓解代码，但**这些改动不属于 t27**：`src/main.js` mtime 09:04、`src/pages/bp-broadcast.js` 09:05、`hud-broadcast.js` 09:06、`overlays.js` 09:06、`app-state.js` 03:57，均晚于 attempt 1 的 REVIEW.md；team DAG 中 t33（BP 1366/DEMO 空态）、**t35「repair-round-4：修复 t28 B1/H1」仍 in_progress（attempt 9）**、t36「review-round-4：复审 t35」pending。`src/pages/console.js` 更在本轮复审进行中被改写（mtime 11:18，`new EventSource` 由 1180 行移到 1251 行）。
3. 按审查协议，**未通过独立复审（t36）的并行修复不能用来给 t28 判 pass**；工作树在复审期间仍在变动，也不具备冻结基线。故 t28 维持 needs_revision，B1/H1 的闭环由 t35 + t36 负责（见 §5）。
4. 复审另发现一处**当前代码里仍在、且未被任何修复轮覆盖**的阻断缺陷（§3 B1'），因此 blocker 数不为 0。

## 2. 9 个模块矩阵（每项含结论 + 证据）

| # | 模块 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | `src/main.js` | **needs_revision** | 错误处理：`src/main.js:285-309` `readBody` 有 1MB 上限（`MAX_BODY_BYTES=1024*1024`，:284）与 `fail()` 413（:290-295），但 :304 `raw += chunk` 把 Buffer 直接拼字符串、:306 `JSON.parse` 失败 `resolve({})`；:382 把 `/api/obs/*` 交给 `handleObsApi` 且无外层 Promise.catch（见 §3）。并发：:176 `setInterval(() => pollLcuDraft().then(() => broadcast()), 1200)`、:224 `setInterval(pollLiveClient, 1000)`、:282 `setInterval(tick, 1000)` 均不等待异步完成，可重叠写 `state`（M4）。资源：`clients` Set 上限 500（:29-30）、`addSseClient`（:345-357）逐出最旧并 `res.on('error'/'close')` 删除、`broadcast()`（:243-267）逐客户端 try/catch 清理，处理正确。安全：:234 `cloneState() = JSON.parse(JSON.stringify(state))`，`obsConfig` 非枚举故不回显；:392 `/overlay/:type` 用 `OVERLAY_TYPES` 白名单；:393 `styles.css` 固定路径；:383 `/api/datadragon-url` 只拼 CDN URL 字符串、不读文件；:374 `/api/sources` 返回 `probeLcu` 的 `{ok,source,phase,port,discovery,reason}`，不含 password。数据正确性：:75-84 `resetLiveGameData()` 清 `state.players=[]` 与两侧比分，调用点 :125/:155/:386（**此改动晚于 t27**）。 |
| 2 | `src/pages/*` | **needs_revision** | 9 个子文件均读。`src/pages/html.js:5-14` `escapeHtml` 转义 `&<>"'`，`htmlShell(title,body,scripts)` 对 body/scripts 做 `typeof==='string'` 校验（t27 修复），title 转义，正确。`src/pages/bp-broadcast.js:84-103` `draft()` live 仅 `state.live.draft.parsed===true` 才读 `state.draft`；:108-113 `showDemoData()` live 未 parsed → true；:142-156 `matchingLivePlayer` 要求 `state.live.game.parsed===true` 且 `isLiveClientPlayer`（wardScore/respawnTimer/position/isBot）；:157-176 `playerAt` live 以 `configPlayers(side)[index]` 为 base，仅匹配成功才覆盖（B1 缓解）。`src/pages/hud-broadcast.js` PAGE_SCRIPT `playerList(side)` 在 `state.mode==='live' && !live.length` 时返回 5 个 `{name:'DEMO · 待选手数据', demo:true}` 占位，`hb-demo-badge` 文案「DEMO · 等待比赛数据」（B1 缓解）。`src/pages/overlays.js:57-67` `teamPlayers` live 仅在 post_game/post.players 或 `live.game.parsed===true` 才返回；:220-227 `draftFor` 同样门槛；:278-297 `renderPostgame` live 无 postGame →「赛后数据不可用 / DEMO / 等待结算」空态（H1 缓解）。`src/pages/result-broadcast.js:268-270` `postGame()` 优先 `state.postGame`，否则 `demoPostGame()`（:241-265 带 `demo:true, source:'demo'`，:433 显示 `DEMO DATA`）。`src/pages/console.js` fetchJson/postJson 有异常兜底（:95-113）、`renderObs` 对 record/stream/replayBuffer 的 null 三态（:409-452）、三个轮询 interval 均 `document.visibilityState !== 'hidden'` 才执行；但 SSE `onmessage` 空 catch（:1255）。残留问题：SSE 单帧异常静默（L2，bp :454 / console :1255 / hud PAGE_SCRIPT / overlays :308-315）。 |
| 3 | `src/app-state.js` | **needs_revision** | 安全正确：:56 `Object.defineProperty(state,'obsConfig',{value:initialObsConfig,writable:true,enumerable:false,configurable:true})` → `/api/state` 与 SSE 不回显 OBS 密码；:67-79 `saveConfig()` 只持久化 `obs:{url}`、`{mode:0o600}` + `chmodSync(0o600)`，密码不落盘。:64-65 `initialPlayersForMode(mode)` live→`[]`、`state.players = initialPlayersForMode(state.mode)`（B1 缓解，晚于 t27）；:29-35 live 初始空比分。:92-123 cue 类型白名单 + `.catch`。**残留缺陷**：:78 空 `catch` 静默吞掉磁盘/权限错误（M2）。 |
| 4 | `src/assets.js` | 通过（含 Low） | `DEFAULT_VERSION='16.22.1'`（:9）；`championKey/itemId/spellKey` 对 null/数字/中文别名归一化（:82-121）；`championIconUrl/itemIconUrl/spellIconUrl` 用 `urlCache` 且缓存键含版本（:140-149）；`iconMarkup` 走 `escapeHtml`。**L1**：:152-157 `championSplashUrl` 调 `normalizeVersion(version)` 但丢弃返回值、缓存键 `'splash|'+key` 无版本；实际 splash 路径 `/img/champion/splash/<key>_0.jpg` 本就不含版本段，影响极小。无阻断。 |
| 5 | `src/live-data.js` | 通过 | `normalizePlayer`（:18-43）`items.filter(Boolean)`；`normalizeLiveState`（:242-272）对 `allPlayers` null 安全并返回 null；`estimateTeamGold`（:201-214）跳过 null；`createLcuConnectionManager`（:276-320）复用 pending、失败 4s 退避、`invalidate()`；`createLiveClientWatchdog`（:324-356）`failureAfterMs=5000`、`minInGameMs=60000`、`maxGameTime>=60`；:217 `try { defaultItemIndex = readItemCache(ITEM_VERSION); } catch {}` 有兜底。无泄漏/阻断。 |
| 6 | `src/timeline.js` | 通过 | `EVENT_TYPES`（:17-32）覆盖 GameStart/ChampionKill/TurretKilled/DragonKill/BaronKill/HeraldKill/InhibKilled/GameEnd；`eventsOf/playersOf`（:43-53）、`buildPlayerIndex`（:56-72）、`toTimelineEntry`（:86-149）均 null 安全；`buildTimeline`（:151-165）按 time 升序后 `slice(-limit)`，`latestTimeline(entries,50)`（:168-172）限量，未知事件跳过。无阻断。 |
| 7 | `src/obs.js` | **needs_revision** | 资源与握手处理正确：`scheduleReconnect`（:162-173）先 `clearTimeout`；`connect`（:180-260）先 `disconnect()`、6s timer、op0 identify 用 `authString`、op2 清 timer 后 `refresh()`、`onerror/onclose` 均有 `if (this.ws !== ws) return`；`disconnect`（:263-285）清 reconnect/connectTimer、connectReject、socket handlers、pending（:255-256/:282-283）；`request`（:287-304）5s 超时并 `pending.delete`；`startObsAutoConnect`（:689-727）指数重试 + `unref()`。`refresh`（:310-324）4/5 个子请求有独立 `.catch`，唯一调用点 :151 `.catch(()=>{})` 与 :241 `.catch(()=>resolve(snapshot))` 均吞掉（M3 已大幅缓解）。输入校验：:533-535 `validText` 拒换行/超长，:557-561 校验 `url` 为 `^wss?://` 且 password ≤256。**阻断缺陷**：:554-579 `/api/obs/connect` 的 `readBody(req,res).then(...)` 无外层 `.catch`（见 §3 B1'）。 |
| 8 | `src/post-game.js` | 通过 | `normalizeEogStats`（:24-75）逐队 `filter(Boolean)`、`entry.stats` 容错，缺队用 `emptyTeam()` 并记录 `missingTeams`/`error`；`fromFrozen`（:77-103）要求 `frozen.players` 非空；`buildPostGame`（:105-143）优先 EOG、其次 frozen，补 name/champion，计算 damagePct/kp 与 blue/red。无 null 崩溃/泄漏。 |
| 9 | `electron/main.cjs` | 通过（含 Medium） | `probePort`（:59-66）`tester.unref()`、`findAvailablePort`（:68-73）；`scheduleServerRestart`（:83-108）指数退避最多 5 次并派发 `service-down`；`startLocalServer`（:109-133）`ELECTRON_RUN_AS_NODE=1` + PORT；`stopLocalServer`（:135-169）`taskkill /pid /t /f` + `close`/`error` + 3s 超时 `unref`；`shutdown`（:173-180）用 `shutdownPromise` 幂等，`before-quit` preventDefault、`will-quit` 兜底；:219 `webPreferences:{contextIsolation:true, sandbox:true}`；`bootstrap`（:321-335）失败有 dialog/日志。**M5**：:223-226 `setWindowOpenHandler(({url:target}) => { shell.openExternal(target); return {action:'deny'}; })` 无 scheme 白名单。无阻断。 |

## 3. Blocker（1）

### B1' — `/api/obs/connect` 的 Promise 链缺少外层 catch，超大/异常请求体会触发未处理 rejection 并终止本地服务

- **文件与行号**：
  - `src/obs.js:554-579`：`if (url.pathname === '/api/obs/connect' && req.method === 'POST') { readBody(req, res).then(body => { ... }); return true; }` —— 外层 `.then` 链**没有** `.catch`；唯一 `.catch` 在 :572，只包住内层 `obs.connect(...).then(...)`。
  - `src/main.js:285-309` `readBody`：`fail(error)`（:290-295）先 `json(res, 413, {ok:false,error:'payload_too_large'})` 再 `reject(error)`；`req.on('error')`（:307）同样 reject。
  - `src/main.js:382`：`handleObsApi(...)` 同步调用并 `return`，**没有**外层 Promise 包装或 try/catch。
  - 对照：`src/obs.js:590`、`:617`、`:658` 三处 POST 链均有 `.catch(fail)`；`src/main.js:376-381/385-386` 各路由链均有 `.catch`；`src/obs.js:545-552` 已有可复用的 `run(action, extras)` + `fail` 包装。
  - 全项目 `grep -rn 'unhandledRejection|uncaughtException|process\.on\(' src electron/main.cjs` **无任何全局兜底处理器**（本轮已验证）。
- **问题**：向 `/api/obs/connect` 发送 >1MB 请求体（`content-length` 预检 :296-299 或分块累加 :300-303）或触发 `req` error 时，`readBody` 已发出 413 但随即 reject；该 rejection 沿 `src/obs.js:555` 的 `.then` 链无人处理。Node 15+ 默认 `--unhandled-rejections=throw`、且本仓库无 `process.on('unhandledRejection')`，因此会升格为未捕获异常并**退出整个本地 HTTP 服务进程**；直播中所有 overlay/控台同时断流。由于 `src/main.js:312` 的 `json()` 带 `Access-Control-Allow-Origin: *`，`Content-Type: text/plain` 的跨源简单请求（无预检）即可从任意网页触发该路径，属于可远程触发的可用性缺陷。
- **影响**：单次畸形/超大 POST 可导致导播服务进程退出，属于发布阻断。
- **requiredFix（可执行）**：
  1. 在 `src/obs.js:555` 把 `readBody(req, res).then(body => {...})` 改为 `readBody(req, res).then(body => {...}).catch(fail)`（`fail` 已在 :540-544 定义，且需在 `res.headersSent` 时不重复发响应：`json()` 已有 `if (res.headersSent) return;`，故安全）；或统一改用 :545-552 的 `run()` 包装。
  2. 在 `src/main.js` 进程入口补 `process.on('unhandledRejection', error => console.error('[unhandledRejection]', error))` 与 `process.on('uncaughtException', ...)` 兜底日志，避免任何遗漏的 Promise 链直接终止服务。
  3. 补回归测试：`POST /api/obs/connect` 带 2MB body 应返回 413 且服务仍存活；`POST /api/obs/connect` 带 malformed JSON 应有确定 4xx/5xx 响应；其余 `/api/obs/*` POST 链同样覆盖 413 不退出。

## 4. High（1）

### H1 — t27 的 live 假数据 / 旧 postgame 缺陷尚未通过正式复审闭环

- **文件与行号**（t27 交付态）：`src/app-state.js:51-56`（`createMockPlayers()` 无条件覆盖 `state.players`）、`src/main.js:104-116/136-151`（InProgress/ChampSelect 不清 players）、`src/main.js:181`（仅 :2999 成功才写 players）、`src/pages/bp-broadcast.js:120-142`、`src/pages/hud-broadcast.js:28` `playerList`、`src/pages/overlays.js:54-57/268-275`（`renderPostgame` 不读 `state.postGame`）。行号为 attempt 1 记录，当前文件因后续修复已位移。
- **问题与现状**：attempt 1 的 B1/H1 会使真实比赛 BP/HUD 显示 TopStar/RiftKing 等 mock 或上一局选手、赛后页在 `postGame===null` 时显示 mock 比分。当前工作树已有缓解（`src/app-state.js:64-65`、`src/main.js:75-84`、`src/pages/bp-broadcast.js:157-176`、`src/pages/overlays.js:278-297`、`src/pages/result-broadcast.js:268-270`），但改动来自 **t35（in_progress, attempt 9）与 t33**，且 `src/pages/console.js` 在本轮复审期间仍被改写；专门复审任务 **t36 pending**。未闭环前不能视为已验收。
- **requiredFix**：完成 t35 并由 t36 独立复审；补回归测试：`savedConfig.mode==='live'` 启动时 `/api/state.players` 为空、live BP 不出现 TopStar/RiftKing、连续两局不继承上一局选手、live 且无数据时 BP/HUD/postgame 均显示 DEMO 空态、`postGame===null` 时旧 postgame overlay 不回退 mock。

## 5. Medium（5）

| id | 文件与行号 | 问题 | requiredFix |
| --- | --- | --- | --- |
| M1 | `src/main.js:304`、`:306` | `raw += chunk` 把 Buffer 逐块转字符串，中文 UTF-8 跨 chunk 会被替换为 U+FFFD；`JSON.parse` 失败静默 `resolve({})`，畸形 body 被当成空对象继续处理（如 `/api/config` 返回 200 什么都没改）。 | 用 `Buffer.concat(chunks).toString('utf8')` 累积；解析失败 `reject(badRequest('invalid_json'))` 并让各路由 `.catch` 返回 400；补中文 tournamentName 跨 chunk 与 malformed JSON 用例。 |
| M2 | `src/app-state.js:78` | `saveConfig()` 的 `try/catch` 为空 catch，磁盘满/权限错误时 UI 显示保存成功但配置丢失。 | `console.error('[saveConfig]', error)`，并让 `saveConfig` 返回布尔或抛错，经 `/api/config`、`handleBroadcastConfigApi`、`handleDirectorApi` 的响应体回传可诊断信息；控台 toast 提示失败。 |
| M3 | `src/obs.js:310-324` | `refresh()` 用 `Promise.all`，`getSceneList()` 无独立 `.catch`，单个失败使整体 reject；`state.obs.scenes` 不更新，控台可能把全部 OBS 状态误判为断开。两个调用点（:151/:241）虽吞掉异常，但丢失了子请求诊断。 | 对 5 个子请求逐个 `.catch` 或改 `Promise.allSettled`，保留成功字段并把每个失败记为 `state.obs.errors[request]`；补「GetSceneList 拒绝但 record/stream 正常」用例。 |
| M4 | `src/main.js:176`、`:224`、`:282` | 三个 `setInterval` 均不等待异步轮询完成（`pollLcuDraft` 内含 `fetchLcuJson` 网络等待、`pollLiveClient` 含 :2999 请求）。网络慢时同一轮询可重叠执行，交错写 `state.phase`/`state.players`/`state.postGame`，可能让 `resetLiveGameData()` 与赛后构建互相覆盖。 | 每个轮询加 in-flight 布尔/`AbortController` 或改成 `setTimeout` 递归（完成后再排下一次）；对 `pollLcuDraft` 与 `pollLiveClient` 的 `state.phase` 写入加单一来源判定（例如只允许 LCU 相位写 phase，Live Client 只写数据）。 |
| M5 | `electron/main.cjs:223-226` | `setWindowOpenHandler` 对任意 `target` 调 `shell.openExternal(target)`，无 scheme 白名单；若页面存在注入点，可借 `file:`/自定义协议拉起外部程序。 | 仅允许 `http:`/`https:` 且目标为可信域，其余 `return {action:'deny'}` 并记录日志；保留 `contextIsolation/sandbox`。 |

## 6. Low（2）

- **L1** `src/assets.js:152-157`：`championSplashUrl` 调用 `normalizeVersion(version)` 却丢弃返回值，缓存键 `'splash|'+key` 无版本。Data Dragon splash 路径本身不含版本段，影响极小；建议把 `v` 写入缓存键（与 :140-149 的 icon 一致）以便换版本时统一失效。
- **L2** SSE `onmessage` 空 catch：`src/pages/bp-broadcast.js:454`、`src/pages/console.js:1255`、`src/pages/hud-broadcast.js` PAGE_SCRIPT 内、`src/pages/overlays.js:308-315`。坏帧时保留上一帧但无日志；建议 `console.warn` 一次并按帧序号限流。

## 7. 专项核查结论

- **token 泄漏**：未发现。`state.obsConfig` 非枚举（`src/app-state.js:56`）不进 `cloneState()`；`saveConfig()`（:70-75）只写 `obs:{url}`；`getObsConfig()` 仅在服务端使用；`/api/sources`（`src/main.js:374`）的 `probeLcu` 返回值与 `state.live.lcu.lastError`（`HTTP <code>`/`Invalid JSON`/`Request timeout`/`Response too large`）均不含 password/token；`src/data-sources.js:229-245` `probeLcuConnection` 返回体无密码，:248-251 Basic auth 不外泄。
- **路径注入**：未发现可读任意文件的路径。`src/main.js:392` `/overlay/:type` 有 `OVERLAY_TYPES` 白名单；:393 `styles.css` 固定路径；:383 `/api/datadragon-url` 只拼 CDN URL 字符串并做 `try/catch` 400；页面模板 `html.js:12-13` 拒绝非字符串 body/scripts。
- **资源泄漏**：SSE 客户端 Set 上限 500 + close/error 清理（`src/main.js:29-30/345-357/243-267/384`）；OBS socket/timer/pending 在 `disconnect` 全清（`src/obs.js:263-285`）；LCU pending 复用与 4s 退避（`src/live-data.js:276-320`）；timeline/highlights 分别限 50 / `MAX_HIGHLIGHTS`；Electron 子进程 taskkill 等待 + 3s 超时 + `unref`（`electron/main.cjs:135-169`）。未发现未清理的定时器/监听器。
- **并发/时序**：除 M4（三个不 await 的轮询间隔）外，`src/main.js:115-127` 用 `sameGame` + `capturedAt` 5 分钟窗口保留同局赛后、:130-147 仅在 PreEndOfGame/EndOfGame/WaitForStatsScreen 构建 postGame、`applyAutoScene()` 用 `lastAutoPhase` 去重，均处理正确。
- **可维护性**：页面按 `src/pages/*` 拆分、`html.js` 统一外壳、`assets.js` 统一图标 URL 与缓存、`obs.js` 集中 OBS 协议、`timeline.js`/`post-game.js` 纯函数；`src/main.js` 397 行且路由集中可读。主要维护负担是 `src/pages/console.js` 与 `hud-broadcast.js` 把大段浏览器脚本内嵌为字符串（`hud-broadcast.js:28` 单行 PAGE_SCRIPT），难以类型检查与单测；建议后续拆为 `public/*.js` 静态文件。

## 8. 已缓解项（不计入本轮 blocker，待 t36 闭环）

- attempt 1 的 **B1**（live BP/HUD mock/上一局选手）：当前 `src/app-state.js:64-65`、`src/main.js:75-84`、`src/pages/bp-broadcast.js:157-176`、`src/pages/hud-broadcast.js` 的 DEMO 占位与 `hb-demo-badge` 已构成静态数据流上的修复。
- attempt 1 的 **H1**（旧 postgame 假数据）：当前 `src/pages/overlays.js:278-297` 的「赛后数据不可用 / DEMO」空态与 `src/pages/result-broadcast.js:268-270` 的 `postGame()` 优先真实数据已构成修复。
- 二者归属 t35（in_progress）/t33，验收由 t36 完成；本轮不据此判 pass。

## 9. 限制与未覆盖

- 按用户「暂停占用 CPU/磁盘」要求，本轮**未执行** `node --test`、`npm`、`electron-builder`、未启动服务、未截图、未触碰 3210；t27 自述 90/90、t33 自述 99/99 只作为其自述，**不作为本轮通过依据**。
- 未做真实 LCU / Live Client / OBS WebSocket 联调；§3 B1' 与 §4 H1 均为静态调用链可判定问题，不依赖运行环境。
- `public/bp-broadcast.css` 的 1366×768 视觉问题见 t29/VISUAL-QA.md 与 t33/t34，不在 t28 的 9 个 JS 模块内，未计入本报告。
- 复审期间 `src/pages/console.js` 被并行修改（11:18），本报告基于当时读取到的快照；该文件最终态应以 t36 复审为准。

## 10. 验收对照

- REVIEW.md 覆盖 9 个文件/模块：**是**（§2 表格 9 行，含 `src/pages/*` 各子文件）。
- 每项含结论与证据：**是**（每行含结论 + 文件/行号 + 行为说明）。
- 列出 blocker 数量：**是，1**（§3 B1'）。
- verdict=pass 时 blocker=0：**不适用**，本轮 verdict=**needs_revision**，blocker=1。
- 每个 blocker 给出可执行 requiredFix：**是**（§3 三条具体修复 + 回归测试要求；同时见 H1/M1–M5 的 requiredFix）。
