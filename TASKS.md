# TASKS.md — 当前任务、进度与待办事项

> 最后更新：2026-11-16。配套 `PROJECT.md` / `ARCHITECTURE.md` / `CONVENTIONS.md` / `CHANGELOG.md`。
> **当前最重要的一条：第 3 节待办全部需要用户配合或明确指令（提权、开观战局、拍板口径、宣布打包），不要自动开工。**

## 1. 当前状态速览

- 项目已全面改名 **Khada Jhin**（原 RiftBroadcast），`package.json` version=`0.2.2`，应用图标=Jhin 面具（`build/icon.ico` + `public/app-icon.png`）；内部事件名前缀 `riftbroadcast:` 保留。
- **git 仓库已建立并推送 GitHub（2026-11-16）**：<https://github.com/RyeRaven/-lol-broadcast-hud.git>（仓库名带前导连字符），`main`=`ef6ee23`，GPL-3.0，338 文件。fixture 里 10 个真实 Riot ID 已匿名化（Player1..Player10#100xx，含 events 内名字段共 128 处）。
- 验证基线：`node --test` **195/195** 全绿。
- 数据能力现状：KDA/等级/CS（量化 10）/顶部塔龙计数 = LCDA；**金币/经验 = 0xdd 协议解码**（回放路径实测可用，见 §2）；**血条/资源条百分比 = OBS 截屏像素流**（实测可用）；score/塔/龙 = 事件增量账本。
- 端口约定：本地服务 3210；冒烟/联调只用 3311..3330（例 PORT=3325），**绝不占用 3210**；OBS WebSocket 4455；LCDA 2999（**自签 TLS，必须 `curl -k https://`**，有效端点只有 `/liveclientdata/allgamedata`）。

## 2. 已完成里程碑（2026-11-14 ~ 11-16 增量，时间线详见 `CHANGELOG.md`）

- **0.2.0 发布链收尾 → 0.2.1 全面改名 Khada Jhin**；REVIEW 缺陷闭环、BP 1366 适配、动画预览交付。
- **底部 HUD 一整块重做已落地**（原 §3 需求，见 §5 存档）：中心对称积分版 + `.hb-native-hole` 原生洞位像素校准（DOM probe `.tmp/hole-probe.cjs`）+ 防闪烁 setHtml 守卫（`.tmp/hud-flicker-check.cjs` 两帧像素差 0.036%）+ 分路排序（`src/draft.js` cellId→assignedPosition 固定槽位）。
- **HUD 数据接入补全**：KDA（`hud-broadcast.js kdaOf`）/等级角标/顶部栏渲染端早已具备；修复 post_game 赛后快照锁死管线（`src/main.js` pollLiveClient 新局自动解锁：gameId 变化或 gameTime 回退 60s+）；龙/塔事件改**增量账本**（`src/live-data.js` `createObjectiveLedger`+`accumulateObjectives`，LCDA 事件是滚动窗口，按身份键去重只增不减）。
- **0xdd 协议解码链（全部 tools/decode0dd/，已开源）**：
  - `decode_statblocks.py` v12 离线解码器：codepoint→byte 按 (负载偏移 mod 64) 分表（PERIOD=64），u8 KDA 双射 + int-lane + pad 投票，xp/gold 残差 IEEE 字节多数票 floor-exact；真值局 300/300 对齐。**cascade_resolve 是 v11 死代码，勿移植。**
  - `live_feed.py` 实时解码器：纯 stdlib Blowfish-ECB（π 表推导，过 schneier 官方向量）+ Observer REST（host `_spectator.<region>.lol.riotgames.com:8088`，key 在游戏进程命令行）+ LiveSolver（LCDA 真值增量投票）；selftest 全绿含真值局 live-sim。
  - `replay_feed.py` 回放喂流器：1s 轮 LCDA 同步 ROFL 回放进度，bisect 取最近解码帧 POST `/api/protocol-feed`；实测回放局金币/经验进 HUD（对位经济差 tooltip 标「协议流精确值」）。
  - 接收端：`docs/PROTOCOL-FEED.md` 契约 + `src/protocol-feed.js`（precision=exact 才转发，绝不伪造）+ `docs/DECODE-CAPABILITY.md` 白皮书。
- **血条像素流**：`tools/pixel-bars/hp_bars.py`（OBS WebSocket GetSourceScreenshot 游戏采集源，切屏免疫、游戏不能最小化；侧栏逐行实心游程检测+网格槽位映射；EMA 0.25s；10Hz POST）+ `src/pixel-bars.js` 接收端（TTL 2s 整包替换，shieldPx 归一 FULL_PX_REF=38）+ `hud-broadcast.js` pixelBars 消费端。实机标定 2560 下蓝 gx0=42 / 红 gx0=116、slots 全命中。
- **事件日志钩子**：`src/main.js` `logLcdaEvents` → `.tmp/lcda-events.jsonl`（身份键去重）。
- **GitHub 开源**：.gitignore（剔除 release/.tmp/shot-profile/缓存/日志）、GPL-3.0 官方全文 LICENSE、README 协议解码边界章节、敏感扫描（Riot token/邮箱/手机号 0 命中）。

## 3. 待办（当前未完成；全部需用户配合或指令）

### 3.1 live_feed 观战实机验证（需用户开观战局 + 提权）
- 已验证：Blowfish 官方向量、真观战 keyframe 解密块提取（语料 C:/Temp/obs4）、live-sim 解码、POST 链路。
- 未验证：管理员权限抓游戏进程命令行 riot: key（非管理员 Get-CimInstance 读 CommandLine 为空串；本机 wmic 已移除）、在线增量求解节奏、nonce/token 边角。
- 步骤：提权运行 `tools/decode0dd/live_feed.py`（或手动 --key/--game-id/--platform）→ 用户开一场直播观战 → 观察 3314 `/api/protocol-feed` 的 precision 与 HUD 金币/经验。

### 3.2 潮虫（虚空幼虫）计数验证
- `src/live-data.js:187` `OBJECTIVE_EVENTS.HordeKill→grubs` 映射存在但事件名**从未真机观测**（网查无权威确认）；LCDA events 滚动窗口短可能错过早期事件。
- 方法：下一局开打前把 dev server 起好、中途别重启，全程跑完看 `.tmp/lcda-events.jsonl` 是否出现 HordeKill；HUD 消费端 hb-grubs-blue/red 已就绪。

### 3.3 CS 口径求和（用户搁置，待拍板）
- `csExact`=minionsKilled 不含野怪：打野位显示 16 而 LCDA creepScore=120（含野怪）。建议 minionsKilled+jungleMinionsKilled 求和后再展示；等用户确认口径。

### 3.4 assists 偶发 ±1（低优先）
- rare codepoint 冲突（0xad/0xe4）致个别帧 assists 差 1；v12 双射 mismatches=0 但跨字段共享 cp 有 2 个 rare 值冲突。量级小，暂不修。

### 3.5 HUD A 键根治（待选方案）
- 现血条读条走 OBS 像素流后，A 键相关缺陷的根治方案待用户选择。

### 3.6 重打包 0.2.3（等用户明确宣布）
- 打包/发布属里程碑动作，必须等用户明确说「打包/发布」才启动（2026-11-14 有过自动触发被叫停的教训）。

### 3.7 控台 UI 效果图（?tab=teams）

## 4. 已完成里程碑（2026-11-13 前，详见 `CHANGELOG.md`）

t1 模块化拆分（24/24）、t2 Data Dragon 图标（44/44）、t3 控台重做（104/104）、t4 时间线与 watchdog（44/44）、t5 OBS 深度集成（48/48）、t6 Electron NSIS 打包（31/31）、t7 端到端验证（54/54，`VERIFICATION.md`）、t9–t23 广播配置/动画端三页/OBS 场景包/cue API/文档/控台接入、t25–t27 经济估算/精彩事件/修复轮、t29 视觉验收、t30 快捷键、t31 自动导播规则引擎、t33 BP 1366 适配、t37 自动导播规则面板。

## 5. 底部 HUD 需求存档（已落地，留实测基准）

- 范围（用户 m03093/m03113 确认）：只保留下方积分版 + 左塔上下两层（赛事信息 + 广告牌可编辑）；英雄状态/小地图/选手摄像头游戏自带，舍弃。
- 尺寸基准（1920×1080）：HUD 条顶边 y≈817、高≈263px、5 行行高 63px；分区换算：左塔 0–280、记分板 465–1457（宽 992）、小地图 1638–1920；中线=整屏中心。测量脚本 `.tmp/hud_measure.py`；参考图 `docs/reference/ingame-hud-reference.jpg`。
- 单行元素（用户 m03161 逐字确认）：外沿视野得分 → 装备/饰品栏（角标分消耗数量/叠层层数）→ 竖排两格（远列符文+分路任务、近列召唤师技能）→ 头像 → 大招圆徽 → 等级 → 选手名 → 三条状态条（紫经验/绿生命/资源）→ CS → KDA → 中线对位经济差（领先方颜色指示条）。
- 资源条特殊机制/无蓝条英雄专项讨论仍待用户发起。

## 6. 用户工作规则（务必遵守）

1. 提问题/需求时**先只听不干**——先复述理解、等他明确说「开工」才动手排查或改动，擅自开工算违规。
2. 要求**从根因解决问题**，不靠不断追加补丁；要么推到基本解决，要么带方向问题回来找他。
3. 输出风格已满意时只修 bug、不重做整体输出。
4. 不确定的技术问题优先上网查官方文档/源码/issue/成熟开源实现，查到后给「结论 + 出处」，不要只贴链接。
5. 做 A/B 方案对比时须把每个方案的全部原文回复直接贴出，不能只给统计表和结论。
6. 打包/发布等里程碑动作必须等用户明确宣布才启动。

## 7. 环境与协作约定

- **git**：本机 niugit 2.56 定制版，无 Git Credential Manager、无 gh CLI；push 用一次性凭证 URL（`https://RyeRaven:<PAT>@github.com/...`，不写入配置）。远端 `origin` 已配置。
- **测试**：`node --test` 基线 195/195；冒烟/联调端口 3311..3330；MSYS 下 taskkill 无效要用 `powershell Stop-Process`。
- **python**：bundled 解释器 `C:/Users/RyeRaven/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe`（3.12.14 纯 stdlib，无 requests/Crypto）；`.tmp` 文件用 ops_stat 取 revision 再写。
- **LCDA**：`https://127.0.0.1:2999`（自签 TLS）；0xdd 的 S-box 每局/每 patch 随机（16.21/16.22 语料 0/1263 字节共享），实时局必须边下 keyframe 边用 LCDA 真值增量求解；cs 是 quantum=10 量化值，live minions lane 不投票。
- **协作**：真实 LCU/OBS 联调需用户配合；视觉实拍 `tools/shot-overlays.cjs`；`.tmp/` 不入库，重要结论回填本文件与 `CHANGELOG.md`。
