# HUD 视觉回归基线（shot-hud）

本文记录 HUD 广播页（`/broadcast/hud`）的视觉回归基线、截图工具用法与差分验收口径。
基线文件在 `test/visual-baseline/`，工具是 `tools/shot-hud.cjs`，自动测试是 `test/visual-baseline.test.js`。

## 1. 快速开始

```bash
# 重新生成三张基线（会覆盖 test/visual-baseline/ 下同名文件）
node tools/shot-hud.cjs --state all --out test/visual-baseline

# 只拍一张（默认写 .tmp/hud-shots/hud-full-1920x1080.png）
node tools/shot-hud.cjs --state full

# 重新拍 full 态并与基线比较（不带 --actual 时会自动截图）
node tools/shot-hud.cjs --diff test/visual-baseline/hud-full-1920x1080.png --out .tmp/hud-shots/diff-full.png

# 比较已有的两张图（不启动浏览器）
node tools/shot-hud.cjs --diff test/visual-baseline/hud-degraded-1920x1080.png \
  --actual .tmp/hud-shots/check-degraded.png --out .tmp/hud-shots/diff-degraded.png

# 像素容差：`--threshold 8` 表示单通道差值 <= 8 的像素不算变化
node tools/shot-hud.cjs --diff test/visual-baseline/hud-edge-1920x1080.png \
  --actual .tmp/hud-shots/check-edge.png --threshold 8 --out .tmp/hud-shots/diff-edge.png
```

`--diff` 不带 `--actual` 时，会从基线文件名自动推断场景（`hud-full-…` / `hud-degraded-…` /
`hud-edge-…`）；确需覆盖时再显式传 `--state full|degraded|edge`。这样三张基线各自重拍自己的状态，
不会出现「拿 full 态去比 degraded 基线」的整片全红。默认 `--threshold 16` 用于吸收本机文字抗锯齿
噪声（实测单通道最大 15）；需要严格逐像素比较时传 `--threshold 0`。

## 2. 三张基线

| 状态 | 基线文件 | 大小 | 尺寸 | 行数 | 语义 |
| --- | --- | ---: | --- | ---: | --- |
| full | `test/visual-baseline/hud-full-1920x1080.png` | 224643 B | 1920x1080 | 10/10 | 全字段可用：CS/gold/xp 来自协议流（exact），HP/资源条来自像素读条 |
| degraded | `test/visual-baseline/hud-degraded-1920x1080.png` | 225103 B | 1920x1080 | 10/10 | 所有 capability 字段 unavailable：数字显示「—」，血条/资源条显示斜纹 unknown 占位 |
| edge | `test/visual-baseline/hud-edge-1920x1080.png` | 227042 B | 1920x1080 | 10/10 | 边界值：CS 量化（≈142 等）、HP 100%/0%/55.6%/0.8% 混合、resource null（absent/unsupported） |

`manifest.json` 与三张 PNG 同目录，记录每张图的 `bytes/width/height/rows/visibleRows/clock`、10 行
的 `getBoundingClientRect()`，以及每行 DOM 的 `cs`、`kda`、`fillPx`（三条状态条的像素宽度）。
自动测试直接读这份 manifest 做断言。

### 2.1 状态是怎么造出来的

截图工具不 mock 页面，页面与 CSS 都是生产代码（`src/pages/hud-broadcast.js` + `public/hud-broadcast.css`），
只替换数据源：

1. **假 Live Client Data 服务**：`tools/shot-hud.cjs` 在 127.0.0.1 的临时端口起一个假 LCDA，
   返回 `test/fixtures/live-real-game.json`（10 名玩家、真实结构）。
2. **真 `src/main.js`**：以子进程启动，`PORT` 用临时端口，`LIVE_CLIENT_URL` 指向上面的假 LCDA。
   随后 `POST /api/config {mode:'live'}` 把服务切到 live，等 `/api/state` 出现 10 名玩家。
3. **full**：每 700ms `POST /api/protocol-feed`（10 人 cs/gold/xp/KDA，全部 precision=exact）
   与 `POST /api/pixel-bars`（10 人 hp/资源条，含满血、残血、盾等）。两个 store 的 TTL 都是 2000ms，
   所以注入必须持续到截图结束。
4. **degraded**：同源代理只改写 `/api/state` 与 `/events` 首帧：把 `capability` 换成
   `buildCapabilityMatrix('offline', {})` 的结果，把所有可选字段置 null；页面其余部分不变。
5. **edge**：假 LCDA 里把 1 号玩家 creepScore 改成 142、2 号改成 147（触发 CS 量化显示）；
   `POST /api/pixel-bars` 注入 hp 100/0/55.6/0.8/100、resource 100/null(absent)/null(unsupported)/11.8/null(absent)。

注意：HUD 的 `playerList()` 会按 `ROLE_ORDER` 给玩家排序，截图行序 = HUD 排序结果，不一定等于
fixture 数组顺序。断言请以 `manifest.json` 里的 `id`（`hb-row-blue-0` 等）为准。

## 3. ready 信号（禁止固定 sleep）

截图前必须同时满足以下条件，任一超时都会报错而不是产出半成品图：

1. `/events` 首帧已解析，且首帧里正好 10 名玩家（证明 SSE 链路工作，而不是猜页面已经加载）。
2. `#hud-broadcast` 有 `hb-ready` class。
3. `.hb-loading` 已隐藏（computed display 为 none）。
4. `document.fonts.status === 'loaded'`。
5. `document.getAnimations()` 中没有非无限循环的 running 动画（入场动画最多 0.42s + 180ms 阶梯延迟）。
6. 没有 `.hb-flash` / `.hb-bump` 一次性特效（比分从 0 跳到真实值会触发 0.72s/0.62s 的整块提亮，
   撞上就会让两次截图差出整片背景）。
7. `#hb-clock` 文本匹配 `\d+:\d\d`。
8. 10 个 `.hb-row` 的 bounding rect 都在视口内（要求 `visibleRows === 10`）。

满足后再暂停所有无限循环动画并把相位拨到 0（计时器脉冲），最后调用 `Page.captureScreenshot`。

## 4. 差分口径

`--diff` 是纯 Node 实现，不依赖 ImageMagick、pixelmatch、sharp 或任何 npm 包：

- PNG 解码：支持 8-bit 灰度/RGB/调色板/灰度+alpha/RGBA，非隔行，filter 0-4 全实现。
- 逐像素比较：按 `max(|Δr|, |Δg|, |Δb|)` 判断，大于 `--threshold`（默认 16；`--threshold 0` 为严格模式）记为变化像素。
- `changedPercent = changedPixels / max(baselinePixels, actualPixels) * 100`，保留 6 位小数
  （1 像素在 1920x1080 上也能表现为 0.000048%，不会被四舍五入成 0）。
- 尺寸不一致时：多出/少掉的像素计入 `changedPixels`，包围盒覆盖全图（防止「裁掉一半」也报 0%）。

输出 JSON（stdout）：

| 字段 | 含义 |
| --- | --- |
| `ok` | `changedPixels === 0 && sizeMatch` |
| `width`/`height` | 基线尺寸 |
| `actualWidth`/`actualHeight` | 实际图尺寸 |
| `sizeMatch` | 两张图尺寸是否一致 |
| `threshold` | 使用的单通道阈值 |
| `totalPixels` | 比较像素总数（取两图较大者） |
| `changedPixels` | 变化像素数 |
| `changedPercent` | 变化百分比（6 位小数） |
| `boundingBox` | 变化区域包围盒 `{x,y,width,height}`；0 变化时为 `null` |
| `maxChannelDelta` | 所有像素里最大的单通道差值 |

同时写一张 diff 图：基线转灰度（`lum * 0.45`）作为底，变化像素涂洋红 `(255,0,255)`。

## 5. 验证记录（本机实测）

- **同图自检**：`--diff baseline.png --actual baseline.png` → `changedPixels: 0`、
  `changedPercent: 0`、`boundingBox: null`、`maxChannelDelta: 0`、`ok: true`。
- **改一像素**：自动测试 `test/visual-baseline.test.js` 把 full 基线中心像素翻转 255，断言
  `changedPixels === 1`、`changedPercent > 0`、`boundingBox` 恰为 1x1、`maxChannelDelta === 255`。
- **重复截图稳定性**（同一台机器，间隔数轮重拍；默认 `--threshold 16`）：

  | 状态 | threshold 16 变化像素 | 严格 threshold 0 变化像素 | 严格占比 | 严格最大通道差 |
  | --- | ---: | ---: | ---: | ---: |
  | full | 0 | 62 | 0.00299% | 15 |
  | degraded | 0 | 42 | 0.002025% | 15 |
  | edge | 0 | 37 | 0.001784% | 15 |

  严格模式的差异全部是顶栏文字抗锯齿（12 个 2-7px 的小块，最大单通道差 15），不是布局/字段变化；
  默认阈值 16 下三张基线重拍均为 0 像素。真正的回归（布局/字段/条宽）会远超这个量级。
- **node --test**：183 tests / 183 pass / 0 fail（含本文件的 7 个视觉基线测试，见第 1 节命令）。

## 6. 已知限制

1. **浏览器依赖**：当前实现使用本机 Chrome/Edge 的无头模式 + CDP。原 `shot-overlays.cjs` 走 Electron，
   但本环境 Electron GUI 主进程无法启动（`app.whenReady()` 不 resolve，退出码 2147483651，
   `Unable to move the cache: 拒绝访问 (0x5)`）。工具会依次找 `CHROME_PATH`、Program Files 的
   Chrome/Edge；找不到时报错退出，不静默失败。
2. **字体与图标**：基线包含本机系统字体渲染。换机器/字体版本可能产生少量文本像素差；跨机器比较前
   建议先在同一台机器上重拍基线，或使用 `--threshold`。
3. **透明背景**：HUD 页是 OBS 透明叠加层，无头浏览器默认把透明画成白色，工具强制把页面背景设为
   黑色（`Emulation.setDefaultBackgroundColorOverride`）；原生 HUD 挖孔处是黑色，这是预期表现。
4. **只覆盖 1920x1080**：CSS 与基线按 1920x1080 设计；其他分辨率需要另生成基线（`--width/--height`）。
5. **配置写盘**：`POST /api/config` 会写 `data/config.json`；工具在启动前备份原文、结束时在
   `finally` 里恢复。若进程被 `SIGKILL` 强杀，请检查该文件是否仍是原来的 `mode: "mock"`。
6. **文字抗锯齿噪声**：见第 5 节，严格 `--threshold 0` 重拍可能有 ≤62 像素差异（最大通道差 15），
   全部在顶栏文字边缘；默认 `--threshold 16` 下为 0。若必须严格 0 像素，请用同一浏览器会话连续截图
   或对顶栏区域单独放宽阈值。

## 7. 文件清单

| 文件 | 说明 |
| --- | --- |
| `tools/shot-hud.cjs` | 截图 + 三态数据注入 + 纯 Node PNG diff + CLI |
| `test/visual-baseline/hud-full-1920x1080.png` | full 基线 |
| `test/visual-baseline/hud-degraded-1920x1080.png` | degraded 基线 |
| `test/visual-baseline/hud-edge-1920x1080.png` | edge 基线 |
| `test/visual-baseline/manifest.json` | 三张图的尺寸/行数/矩形/DOM 值 |
| `test/visual-baseline.test.js` | 基线文件、manifest、自 diff、单像素 diff 的自动测试 |

工具只写 `.tmp/hud-shots/`（或 `--out` 指定的路径）与 `test/visual-baseline/`，不修改 `public/` 与
`src/pages/` 的任何样式。

# t12 扩展验收：HUD/BP/ingame 在 1920 与 1366 的截图核对（capture.cjs）

前 7 章是 t28 的 HUD 基线体系。本章是 t12 交付的扩展视觉验收：把 `/broadcast/hud`（正常/降级）、`/broadcast/bp?phase=draft`（正常/`?bpAnim=0`/reduced-motion）、`/overlay/ingame-top`、`/overlay/ingame-bottom` 在 **1920×1080 与 1366×768** 各截一套，逐张做 DOM+像素双检查，并把可无损 diff 的基线落到 `test/visual-baseline/qa-*.png`。

## 8. 截图工具与流程（tools 外的 .tmp/visual-qa/capture.cjs）

- 启动序列：`findPort(3324..3399)` → 假 LCDA（`buildLcdPayload('full')`）→ `ELECTRON_RUN_AS_NODE=1` spawn `src/main.js`（`PORT`+`LIVE_CLIENT_URL`）→ `/health` 就绪 → Chrome/Edge headless+CDP（`--headless=new --remote-debugging-port=0 --user-data-dir=<mkdtemp 绝对路径>`，黑底 override，`Network.setBlockedURLs: *://ddragon.leagueoflegends.com/*`，`setDeviceMetricsOverride` 精确视口）。
- 逐 suite：按需 `POST /api/phase`（BP 用 `draft`）→ 700ms 循环喂 `/api/protocol-feed`+`/api/pixel-bars`（TTL 2000；hud-nopixel 不喂像素流）→ ready 轮询（hud：`hb-ready`+10 行可见+时钟 `\d+:\d\d`；bp：`bb-ready`+10 卡+10 tile+无 lock 残留；ov：topbar/bottombar）→ DOM 检查 → 截黑底 PNG → 把根背景 alpha 改 0 再截 alpha PNG → `decodePng` 统计 alpha 分布。
- 截图前 pause 全部 infinite CSS animation 并复位 `currentTime=0`（与 shot-hud 同约定）。
- 复现命令（在项目根；端口自动选 3324+，跑完自动停 app/LCDA/浏览器并确认端口释放）：

```
node .tmp/visual-qa/capture.cjs --suite all --width 1920 --height 1080 --out .tmp/visual-qa/1920
node .tmp/visual-qa/capture.cjs --suite all --width 1366 --height 768 --out .tmp/visual-qa/1366
node tools/visual-diff.cjs --baseline test/visual-baseline/qa-hud-full-1920x1080.png --actual .tmp/visual-qa/1920/alpha/hud-full-1920x1080-alpha.png --json
```

## 9. 基线清单（10 张，无损 RGBA，共 2,852,247 B < 3MB）

| 文件 | 字节 | sha256(前16) |
| --- | --- | --- |
| `qa-hud-full-1920x1080.png` | 277362 | `65059eb809c1990e…` |
| `qa-hud-nopixel-1920x1080.png` | 284032 | `2584d5de16b69052…` |
| `qa-bp-draft-1920x1080.png` | 992539 | `03bae9d1f5ec9e5e…` |
| `qa-ingame-top-1920x1080.png` | 108370 | `265f16277bb297e5…` |
| `qa-ingame-bottom-1920x1080.png` | 93331 | `b4e174450161e1f5…` |
| `qa-hud-full-1366x768.png` | 175679 | `984c4844affa6d80…` |
| `qa-hud-nopixel-1366x768.png` | 176115 | `66f929d21400d7f6…` |
| `qa-bp-draft-1366x768.png` | 571075 | `f6a4859c16b279da…` |
| `qa-ingame-top-1366x768.png` | 94231 | `b04f52158aebf5f3…` |
| `qa-ingame-bottom-1366x768.png` | 79513 | `a334d284d75590df…` |

来源均为 alpha（透明背景）截图；黑底版本与完整 manifest（DOM 检查值、行矩形、alpha 统计）保留在 `.tmp/visual-qa/<1920|1366>/`（含 `bp-draft-noanim`、`bp-draft-reduced`、black 变体与两次重拍 `*-rerun`）。基线命名 `qa-<suite>-<W>x<H>.png` 与 t28 的 `hud-*-1920x1080.png` 不冲突。

## 10. 逐张检查结论

| # | 路由 | 分辨率 | 状态 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | /broadcast/hud | 1920×1080 | 正常（LCDA+协议流+像素条） | 通过：三状态条 30/30 有数（hp 114/101/25/74/49、res 105/89/35/70/51、xp 0/0/114/0/0），时钟 19:57，10/10 行 |
| 2 | /broadcast/hud | 1920×1080 | 降级（不喂像素流，等 2.5s） | 通过：hp/res 20 条 `unknown=true` 画斜纹、fillPx=0（无 0% 填充），xp 10 条仍由 LCD 等级数据驱动 |
| 3 | /broadcast/bp?phase=draft | 1920×1080 | 正常 | 通过：10/10 卡+tile 可见，blankCards=0，lockResidue=0，runningAnims=0，fonts loaded |
| 4 | /broadcast/bp?phase=draft&bpAnim=0 | 1920×1080 | 无动画 | 通过：元素全部可见，动画关闭 |
| 5 | /broadcast/bp?phase=draft | 1920×1080 | prefers-reduced-motion=reduce（CDP 仿真） | 通过：卡片/tile 可见，runningAnims=0；与 ?bpAnim=0 终态一致 |
| 6 | /overlay/ingame-top | 1920×1080 | 正常 | 通过：topbar 有、透明像素 83.3% |
| 7 | /overlay/ingame-bottom | 1920×1080 | 正常 | 通过：bottombar 10 玩家、透明 72.3% |
| 8–10 | 同 1/2/3 | 1366×768 | 同上 | 通过：0.711 倍等比缩放正常，透明 69.4%/69.4%/BP 全屏 |

### 10.1 透明背景（OBS 关键项）

- HUD/ingame 四类页：`html/body/root` computed style 全为 `rgba(0,0,0,0)`；alpha 像素占比 63–83%（ingame-top 83.3%、ingame-bottom 72.3%、hud 72.5%，1366 侧 69.4%/63%），不透明黑底不存在。
- **BP 页像素级 100% 不透明是设计使然**：`html/body/.bp-broadcast` 均 transparent（DOM 检查通过），但 `.bb-stage`/`.bb-band`/`.bb-roster` 等面板按设计画实体背景（`#05070a` 等）。BP 页定位是全屏导播页，OBS 中应作场景背景页而非叠加源。非回归，未改代码。

### 10.2 HUD 版式（t10 布局参数复核）

- 名字：10/10 `truncated=false`（scrollW==clientW），两个分辨率一致。
- 三条状态条不串行：每行 xp/hp/res 各自独立 rect（如 row0 hp y844.38/res y851.88，条高 5.25），无互相覆盖。
- 蓝红不交叠：蓝块 x313..936、红块 x984..1607，中缝 -3.6K 对位经济差列；1366 等比后同样分离。
- 孔带：`bandViolations=[]`（按 611..818 蓝 /1102..1309 红 × scale 检查），装备孔区域无内容溢出。

### 10.3 BP 页（t11 动效复核）

- 卡片不空白：10 卡文本/位置/召唤师技能齐全（检查器 blankCards=0 + 截图目视）。
- 锁定徽标不残留：`lockResidue=0`；入场动画结束元素终态可见。
- `?bpAnim=0`：元素可见（bb-ready、10 卡/10 tile）。reduced-motion 用 CDP `Emulation.setEmulatedMedia` 仿真等价验证，`animOff` 标志只反映 URL 参数（JS 侧只读 `bpAnim`），CSS reduced-motion 块兜底可见性。

## 11. 可复现性验证（重拍 ×2 后 visual-diff）

对 10 张基线各做一次「全新重拍 → `tools/visual-diff.cjs --threshold 16`」：

| 基线 | changedPixels | changedPercent | bbox |
| --- | --- | --- | --- |
| qa-hud-nopixel-1920x1080 | 0 | 0% | — |
| qa-bp-draft-1920x1080 | 0 | 0% | — |
| qa-ingame-top-1920x1080 | 0 | 0% | — |
| qa-ingame-bottom-1920x1080 | 0 | 0% | — |
| qa-hud-nopixel-1366x768 | 0 | 0% | — |
| qa-bp-draft-1366x768 | 0 | 0% | — |
| qa-ingame-top-1366x768 | 0 | 0% | — |
| qa-ingame-bottom-1366x768 | 0 | 0% | — |
| qa-hud-full-1920x1080 | 1930 | 0.093% | x83,y21 1412×908 |
| qa-hud-full-1366x768 | 944 | 0.090% | x234,y13 898×91 |

重拍字节数与首拍完全一致（如 ingame-bottom-1920 alpha=93331B 两拍相同）。hud-full 的差异逐像素定位（`.tmp/visual-qa/locate-changes.cjs`）为：①男爵倒计时「00:03」数字区（1920: x832-1087/y64-191）——活动倒计时在 ready 轮询 ±300ms 抖动内跨秒跳字；②左下 LIVE 面板徽记（x64-191/y896-959）脉冲相位；③少量边缘 AA。属实时倒计时固有非确定性，≤0.1% 像素，threshold=16 下可忽略；其余 8 组 0 像素。可选后续改进（交 ui-engineer/工具侧，未实施）：fixture 男爵计时改 ≥120s 或页面提供 `?freezeTimers=1`。

## 12. t12 发现的问题列表

| 级别 | 问题 | 证据 | 结论 |
| --- | --- | --- | --- |
| P3 观察 | BP 页像素 100% 不透明（.bb-stage/.bb-band 设计实体背景） | alpha 统计 opaquePct=100（两个分辨率 3 个 BP suite 全部）；DOM bg 检查全 transparent | 设计意图，非回归；OBS 用法需作背景页。未修（不在 t12 范围，交 ui-engineer 确认） |
| P3 观察 | 降级态「龙」从「已刷新」回退为「05:00」倒计时 | hud-full 与 hud-nopixel 目标条对比（两分辨率一致） | 像素流停止后 dragon 状态数据源回退，行为合理；未修 |
| P3 观察 | hud-full 重拍 diff 0.09%（男爵倒计时跳字 + LIVE 徽记脉冲相位） | §11 bbox 与 locate-changes 输出 | 实时倒计时固有；threshold16 可忽略；未修 |
| P2 已排除 | capture.cjs 启动期 Chrome「DevTools listening 行超时」 | 曾复现 1 次；`--user-data-dir` 相对路径 → 改 mkdtemp 绝对路径后不再复现（连续 4 次全量 capture 成功） | 工具 bug 已修（.tmp/visual-qa/capture.cjs，非交付代码） |

无 t10/t11 视觉回归。

## 13. t12 文件清单（增量）

- `test/visual-baseline/qa-*.png` ×10（§9）
- `.tmp/visual-qa/capture.cjs` 截图+检查工具（复用 shot-hud 的 PNG/CDP 构件，输出 alpha 双截+manifest）
- `.tmp/visual-qa/{1920,1366}{,-rerun}/`：完整产物（black/alpha PNG、manifest.json、chrome-profile-*）
- `.tmp/visual-qa/locate-changes.cjs`：差异定位小工具
- 本文档 §8–§13

工具只写 `docs/`、`test/visual-baseline/` 与 `.tmp/`；`src/`、`public/` 未改动；临时服务（app/LCDA/Chrome）每次 capture 后自动 teardown 并确认端口释放。

