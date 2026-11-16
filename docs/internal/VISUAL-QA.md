# RiftBroadcast 广播页视觉验收（t29）

- 验收时间：2026-11-13（本地时区）
- 验收范围：/broadcast/bp、/broadcast/hud、/broadcast/result、/overlay/transition
- 分辨率：1920×1080、1366×768
- 临时服务：PORT=3212 的本地服务；未使用、未重启、未关闭 3210（用户正在使用），未触碰 3215
- 截图工具：tools/shot-overlays.cjs（Electron offscreen，固定等待 1500ms，PNG + manifest.json）
- 参考：docs/reference/bp-lineup-reference.jpg（2324×1311）、docs/reference/ingame-hud-reference.jpg（2306×1312）、docs/VISUAL-SPEC.md
- 约束：本任务只做验收与记录，未修改任何源码；未运行 node --test、npm、electron-builder 或打包命令

## 结论速览

| 页面 | 1920×1080 | 1366×768 | verdict | 主要问题 |
| --- | --- | --- | --- | --- |
| /broadcast/bp | 截图完整，DOM 无裁切 | 底部横带内容溢出 21px，角色行/PATCH 不可见 | **needs_revision** | 1366 裁切、横带比例偏离规范、空态/DEMO 标识 |
| /broadcast/hud | 截图完整 | DOM 5 行全部可见 | **pass** | 无布局阻断；mock 模式无 DEMO 标识（观察项） |
| /broadcast/result | 截图完整 | DOM 5 行全部可见，DEMO 标识可见 | **pass** | 无阻断 |
| /overlay/transition | 截图完整、无黑边 | DOM 透明，首帧透明 | **pass** | 无阻断；大斜切层刻意超出视口，主容器裁切 |

总体：BP 页在 1366×768 存在可见裁切，整体视觉验收为 **needs_revision**；HUD、result、transition 三页通过。BP 的 1366 问题修复后建议重跑本报告中的 1366 截图与 DOM 尺寸断言。

## 截图与 manifest

所有截图均由 tools/shot-overlays.cjs 生成，manifest 中 status=ok、attempts=1、无 failed/skipped。

| 页面 | 1920×1080 截图 | 1366×768 截图 |
| --- | --- | --- |
| BP | .tmp/visual-qa/1920-draft/broadcast-bp.png（2,389,890 B） | .tmp/visual-qa/1366-draft/broadcast-bp.png（1,263,488 B） |
| HUD | .tmp/visual-qa/1920-ingame/broadcast-hud.png（314,936 B） | .tmp/visual-qa/1366-ingame/broadcast-hud.png（204,652 B） |
| result | .tmp/visual-qa/1920-postgame/broadcast-result.png（1,176,448 B） | .tmp/visual-qa/1366-postgame/broadcast-result.png（762,003 B） |
| transition | .tmp/visual-qa/1920-draft/overlay-transition.png（990,147 B） | .tmp/visual-qa/1366-draft/overlay-transition.png（521,685 B） |

对应 manifest：.tmp/visual-qa/{1920,1366}-{draft,ingame,postgame}/manifest.json。

---

## 1. /broadcast/bp — needs_revision

### 1920×1080

- 截图：.tmp/visual-qa/1920-draft/broadcast-bp.png
- 目视：顶部品牌条、中央 HYPERX、左右各 5 个 Ban、10 个英雄原画卡片、中央 73.3% / 26.7% / 16W-8L / 队标队名 / PATCH 26.20 均可见；无溢出或裁切。
- DOM 实测：
  - .bb-band：y=604.8，h=475.2（占 1080 的 44%），bottom=1080
  - .bb-roster：y=701.8，h=378.2
  - .bb-patch：y=1040，h=14，bottom=1054（视口内）
  - .bb-card-info small：y=1058，h=12，bottom=1070（视口内）
- 资源：BP 页 document.images 共 30 张，broken=0；英雄原画、Ban 图标、队标均正常加载，无缺失占位。

### 1366×768

- 截图：.tmp/visual-qa/1366-draft/broadcast-bp.png
- 目视：底部横带最下方的选手角色行几乎不可见；中央信息块的 PATCH 行不在画面内；其余主要信息仍可读。
- DOM 实测（视口 1366×768）：
  - .bp-broadcast：scrollHeight=789，clientHeight=768，且 overflow:hidden，页面内容超出底部 21px
  - .bb-band：y=422.4，h=345.6，bottom=768；scrollHeight=367，clientHeight=346，横带内部也溢出 21px
  - .bb-roster：y=509.4，h=258.6，bottom=768；scrollHeight=280
  - .bb-info：x=533，y=509.4，w=300，h=279.7，bottom=789.1（超出视口 21.1px）
  - .bb-roster-card：y=509.4，h=279.7，bottom=789.1
  - .bb-card-info：y=751.1，h=28，bottom=779.1
  - .bb-card-info small：y=769.1，h=10，bottom=779.1（完全在 768 视口之外，角色行不可见）
  - .bb-patch：x=644.4，y=767.1，h=14，bottom=781.1（仅顶部约 0.9px 在视口内，基本不可见）
- 根因：.bb-roster 是 grid，容器高度只有 258.6px，但中央 .bb-info 的内容固有高度为 279.7px，grid 行被内容撑高，超出部分被 .bb-band/.bp-broadcast 的 overflow:hidden 裁掉；不是单纯字号太大，而是 1366 下 .bb-info 内容高度未压缩到可用高度。

### 问题与建议修复

1. **[high] 1366 底部横带整体溢出 21px，PATCH 被裁切**
   - 证据：public/bp-broadcast.css:55（.bb-band height:44%）、:130（≤1600 时 height:45%）、:90（.bb-info 的 gap:7px;padding:10px 20px）、:135-137（≤1600 的压缩仍不足）、:145（≤1366 roster 中央列 300px）
   - 影响：1366×768 下中央信息块底部与底部横带最后一行被裁切，PATCH 不可见。
   - 建议：新增 @media (max-width:1366px) 的 .bb-info 紧凑规则，至少把 .bb-pb 36px→28px、.bb-pick 21px→17px、.bb-team-logo 62px→48px、.bb-team-name 18px→15px、.bb-info-sponsor 22px→18px、gap 5px→3px、padding 8px 12px→6px 10px；同时给 .bb-roster 增加 grid-auto-rows:minmax(0,1fr) 作为兜底。不要只加 overflow:hidden，否则只是把 PATCH 静默裁掉。
   - 验收：修复后 1366 下 .bp-broadcast.scrollHeight <= clientHeight、.bb-band.scrollHeight <= clientHeight，且 .bb-patch 的 bottom <= 768。

2. **[high] 1366 选手角色行完全在视口外，文字不可读**
   - 证据：public/bp-broadcast.css:84（.bb-card-info small font-size:9px）、:137（≤1600 时 7px）、:147（≤1366 只把 b 调到 11px，没有处理 small）；DOM .bb-card-info small 的 y=769.1 > 768。
   - 影响：BP 卡片只剩选手名，角色/英雄小字完全不可见；与 1920 的卡片信息层级不一致。
   - 建议：1366 下隐藏 .bb-card-info small（规范本身只要求选手 ID），或把角色移到卡片顶部/名字上方并限制为 8px 以上；若保留在底部，必须先按问题 1 压缩整体高度并验证 bottom <= 768。

3. **[medium] BP 底部横带比例明显高于视觉规范/参考**
   - 证据：public/bp-broadcast.css:55 为 44%，:130 在 ≤1600 为 45%；docs/VISUAL-SPEC.md:14 要求约 30%，参考图 docs/reference/bp-lineup-reference.jpg 的底部横带约 31% 屏高。1920 DOM 实测 .bb-band 475.2/1080=44%。
   - 影响：主画面（选手原画/舞台）被压缩，整体版式与参考图不一致；不是 1920 可读性问题，但属于视觉复刻偏差。
   - 建议：以 30%–32% 为目标调整 .bb-band 与 .bb-stage 的 bottom，同时重新分配 roster 卡片高度和 .bb-info 字号；若产品决定保留 44% 作为适配方案，应在规范中注明偏离原因。

4. **[high] 空态 / DEMO 标识：live 空 BP 可能显示 mock 选手，且 BP 页没有 DEMO 标识**
   - 证据：
     - src/pages/bp-broadcast.js:84-93：live 模式只有 state.live.draft.parsed === true 才使用 state.draft，否则 BP 数组为空；
     - src/pages/bp-broadcast.js:125-135：playerAt 仍优先取 livePlayers(side)，而 livePlayers 来自 state.players；
     - src/app-state.js:52：启动时 state.players = createMockPlayers()；
     - src/main.js:133-148：ChampSelect 分支设置 phase='draft' 并拉取 session，但没有清空/重置 state.players；
     - BP 页源码无 DEMO 标识（仅 result 页有 rb-demo-badge）。
   - 影响：真实 LCU 进入 ChampSelect 但 session 为空或尚未解析时，BP 页的 picks/bans 为空，但 10 个卡片仍可能显示启动时的 mock 名字/英雄/原画；mock 模式下 BP 页也没有任何 DEMO 水印，观众无法区分演示数据与真实比赛。
   - 建议：在 ChampSelect 分支重置 state.players（或让 BP 的 playerAt 仅在 state.live.draft.parsed 时读取 state.players，否则回退到 config 空位/—）；当 state.mode === 'mock' 时在 BP 页右上角增加 DEMO DATA badge，并同步检查 HUD。
   - 备注：该项为源码级空态检查，未单独启动“真实 LCU 空 session”截图；现有截图是 mock 模式。

### 已排除的误报

- 1920 截图首抢为 BLUE SIDE、1366 为 RED SIDE：这是 state.draft.active 数据驱动（src/pages/bp-broadcast.js:294-302），不是响应式布局 bug。
- 1366 中央信息块队名/BLUE SIDE/RED SIDE 可见，说明并非整块被隐藏；具体裁切只发生在底部 21px。

---

## 2. /broadcast/hud — pass

### 1920×1080

- 截图：.tmp/visual-qa/1920-ingame/broadcast-hud.png
- 目视：顶部比分条约 1080px 宽，底部 5 行积分板、摄像头、赞助商条、小地图均可见；无溢出或裁切。

### 1366×768

- 截图：.tmp/visual-qa/1366-ingame/broadcast-hud.png
- DOM 实测：
  - .hb-top：x=233，y=12，w=900，h=98
  - .hb-scorebar：h=62
  - .hb-bottom：x=12，y=610，w=1342，h=148，bottom=758（视口内）
  - .hb-row：h=27，前三行 y=617/646/675，5 行全部在视口内
  - document.images 共 70 张，broken=0
- 文字/资源：队名、比分、金币、目标图标、5 行选手的等级/装备/英雄/CS/KDA 均可读；无缺失英雄头像或装备图标占位。

### 检查项与观察

- 布局溢出/裁切：pass；.hb-bottom bottom=758 < 768，5 行完整。
- 文字可读性：pass；1366 下 27px 行高和 24px 级别仍清晰。
- 英雄立绘/图标：pass；70 张图片 broken=0。
- 空态/DEMO：观察项（低）。HUD 页没有 DEMO 标识；mock 模式下显示的是 mock 选手。与 BP 同类，建议统一在 mock 模式加 DEMO DATA 水印；不影响当前 HUD 布局 verdict。
- reduced-motion：public/hud-broadcast.css:887-897 将入场/闪烁动画压到 animation-duration:.01ms 并强制行/顶部可见；满足降级要求（静态检查）。
- 透明背景：public/hud-broadcast.css:5-9 设置 html/body 透明；DOM 计算背景为 rgba(0,0,0,0)。

---

## 3. /broadcast/result — pass

### 1920×1080

- 截图：.tmp/visual-qa/1920-postgame/broadcast-result.png
- 目视：VICTORY、2:0、MVP、10 人数据表、右上及行内 DEMO DATA 均可见；无溢出或裁切。

### 1366×768

- 截图：.tmp/visual-qa/1366-postgame/broadcast-result.png
- DOM 实测：
  - .rb-stats：x=32，y=420，w=1302，h=286，bottom=706
  - .rb-row：h=34，前三行 y=522/556/590，蓝红两侧各 5 行全部可见
  - .rb-mvp：x=1076，y=74，w=260，h=316，bottom=390
  - .rb-demo-badge：x=1230.5，y=78，w=101.5，h=23，bottom=101，display:block
  - document.images 共 10 张，broken=0
- 文字/资源：选手名、K/D/A、CS、伤害占比、参团、经济、MVP 信息均完整；无缺失头像/装备图标。

### 检查项与观察

- 布局溢出/裁切：pass；5 行 × 34px 全部在 .rb-stats 内，bottom=706 < 768。
- 文字可读性：pass；1366 下 34px 行高，列头/数值清晰。
- 英雄立绘/图标：pass；10 张图片 broken=0。
- 空态/DEMO：pass；src/pages/result-broadcast.js:405 根据 pg.demo 设置 data-demo，:544 提供 DEMO DATA badge，:14-15 CSS 仅在 data-demo="1" 时显示；1366 DOM 实测可见。
- reduced-motion：public/result-broadcast.css:200-204 关闭胜利/MVP/行入场动画；满足降级要求（静态检查）。
- 透明背景：public/result-broadcast.css:8-11 设置 html/body 透明；DOM 计算背景为 rgba(0,0,0,0)。

---

## 4. /overlay/transition — pass

### 1920×1080

- 截图：.tmp/visual-qa/1920-draft/overlay-transition.png
- 目视：满屏深色斜切层 + 中央 RIFT BROADCAST，无白边/黑边；动画后状态完整覆盖视口。

### 1366×768

- 截图：.tmp/visual-qa/1366-draft/overlay-transition.png
- DOM 实测：
  - html/body/main 计算背景均为 rgba(0,0,0,0)
  - .overlay-transition：1366×768，class tr-play，overflow:hidden；scrollHeight=906 是斜切层刻意超出导致，主容器裁切
  - .tr-layer：x=-695.6，y=-138.2，w=2407.6，h=1044.5，bottom=906（覆盖视口并超出，用于斜切）
  - .tr-brand：x=393.1，y=338，w=579.7，h=100，opacity=1
- 首帧透明检查：public/transitions.css:8 初始 .tr-layer transform:translateX(125%) skewX(-12deg) 将斜切层放在视口外，:13 初始 .tr-brand opacity:0，因此动画第一帧页面完全透明；:17 的 .tr-play .tr-brand{opacity:1} 才让品牌出现。未发现首帧黑边/白边。
- 资源：无图片依赖；无 broken images。
- reduced-motion：public/transitions.css:41-43 将 animation-duration 压到 1ms 并显示品牌；满足降级要求（静态检查）。
- 观察：.overlay-transition 的 scrollHeight=906 不是用户可见溢出；斜切层超出视口是设计需要，主容器 overflow:hidden 已裁切，截图无黑边。

---

## 全局检查

### 透明背景

- BP/HUD/result/transition 四页的 html/body/main 计算背景均为 rgba(0, 0, 0, 0)；截图的黑色来自 tools/shot-overlays.cjs 的 Electron 捕获底色，不是页面自身不透明。
- transition 首帧按 CSS 初始态为全透明；BP/HUD/result 的舞台/面板按设计有深色内容，不属于“黑边”。

### 图片资源

| 页面 | document.images | broken |
| --- | --- | --- |
| BP | 30 | 0 |
| HUD | 70 | 0 |
| result | 10 | 0 |
| transition | 0 | 0 |

未发现英雄原画、Ban 图标、装备图标、队标缺失或占位图错误。

### reduced-motion

已检查源码规则：

- public/bp-broadcast.css:149-153
- public/hud-broadcast.css:887-897
- public/result-broadcast.css:200-204
- public/transitions.css:41-43

均为 @media (prefers-reduced-motion: reduce) 下关闭/压缩动画。本次未用 Electron 动态模拟 reduced-motion，只做静态规则核对；这是验收限制之一。

### 空态与 DEMO 标识

- result：有 DEMO DATA badge，且 1366/1920 均可见，pass。
- BP：无 DEMO 标识；且 live 空 session 时 playerAt 仍可能取 state.players 的 mock 数据（见 BP 问题 4），需要修复。
- HUD：无 DEMO 标识；mock 模式显示 mock 选手。建议与 BP 统一加 DEMO DATA 水印；当前不阻断 HUD 布局验收。
- transition：无数据，不涉及 DEMO。

## 未覆盖 / 限制

1. 截图服务是 mock 数据模式，未连接真实 LCU/真实 Live Client；未覆盖真实比赛中的 BP 空 session、真实 EOG 数据、真实 OBS 浏览器源。
2. 截图固定等待 1500ms，捕获的是动画完成后的稳定帧；首帧透明性依据 CSS 初始态与 DOM 计算值判断，未用 OBS 实际推流录制首帧。
3. reduced-motion 仅做 CSS 静态核对，未做 Electron 媒体特性模拟。
4. 1920 HUD/result 以目视截图检查为主；1366 使用 DOM 尺寸实测。BP 两档均做了 DOM 实测。
5. 未修改源码；未运行全量测试（遵循用户暂停期间的 CPU 约束），未触碰 3210。
