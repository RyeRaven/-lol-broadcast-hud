# 原生 HUD 嵌合标定（NATIVE-HUD-ALIGNMENT）

本文件记录「保留游戏原生装备栏 / 视野饰品栏，我方 HUD 挖孔嵌合」方案的实测几何与配置约定。

## 1. 为什么是挖孔而不是自绘装备

LCDA（`/liveclientdata/allgamedata`）的 `items[]` 每件只给
`{itemID, count, slot, price, displayName, rawDisplayName, rawDescription, canUse, consumable}`。

- `count` 对成装恒为 1，**拿不到叠层数**（心之钢层数、破败充能、黑暗封印层数等）；
- 拿不到冷却转圈、可主动使用高亮、守卫剩余时间这些**原生动效状态**。

因此装备栏与饰品栏交回游戏原生渲染，我方只在对应位置留透明孔洞。

## 2. 实测几何（2560x1440，素材 C:/Temp/spec1.png 等 14 张截图逐像素测量）

| 量 | 实测值 | 说明 |
|---|---|---|
| 玩家行数 | 5 | 蓝方 5 行在上，红方 5 行在下（原生面板左右分栏） |
| 行距 | **54.1 – 54.9 px**（中位 54.3） | 14 张截图一致，极稳 |
| 装备图标尺寸 | **30 x 30 px** | 24–34 px 的块一律判为噪声 |
| 装备图标间距（pitch） | **32 – 33 px**（蓝 32.5，红 33.0） | pitch = 图标 30 + 间隙 2.5 |
| 蓝方装备列起点 x | **895 – 897** | 6 格时右端 ≈ 1060 |
| 红方装备列起点 x | **1489 – 1492** | 6 格时右端 ≈ 1655 |
| 蓝方头像 | 约 38 x 38，x 1221..1259 | 只在部分行可见（选中高亮） |
| 红方头像 | 约 35 x 35，x 1290..1324 | |
| 饰品槽（红） | x ≈ 1690..1704（约 20 px） | 与 6 格装备分开一段 |
| 饰品槽（蓝） | x ≈ 814（镜像到最左） | |

换算到 1920x1080（scale 0.75）：行距 **40.7 px**、图标 **22.5 px**、pitch **24.4 px**、
蓝列起点 x≈672、红列起点 x≈1117。

### 2.1 已知的不确定性（必须在实现里留出可调空间）

1. **面板整体不是严格居中于屏幕**：实测中线 x≈1307（2560 宽的一半是 1280）。
2. **原生面板尺寸随分辨率与 UI 缩放变**：`game.cfg` 的 `[HUD] GlobalScale` 当前 1.0000，
   改成 1.30 会让原生行距从 54 → 70 px。**代码里绝不能假设原生一定是 54 px。**
3. **行内装备是「从列首连续排」，空槽不绘制**。孔宽必须 = `(已拥有件数 - 1) × pitch + 图标 size`
   （最后一个图标只占 size，不再占满一个 pitch；用 `件数 × pitch` 会多出约 1.9px，蓝方右端会压到状态条），
   固定 6 格宽则会在空槽处露出原生深色底，形成接缝。
4. 参考图 `docs/reference/ingame-hud-reference.jpg` 实测 2306x1312，换算 1080p 后每行约 52.6 px，
   比原生 40.7 px 大 29%。**两者不会自动对齐**，需要把游戏内 HUD 缩放调大约 1.29 倍，
   或反过来把参考图比例缩小。这一点写进 USER-GUIDE 的 OBS 设置步骤。

## 3. 配置约定（CSS 自定义属性，挂在 `.hud-broadcast` 根上）

```css
.hud-broadcast {
  --hb-native-item-size: 22.5px;    /* 图标边长 */
  --hb-native-item-pitch: 24.4px;   /* 图标中心间距 */
  --hb-native-row-pitch: 40.7px;    /* 行中心间距 */
  --hb-native-blue-x: 672px;        /* 蓝方装备列左边界（1920 基准） */
  --hb-native-red-x: 1117px;        /* 红方装备列左边界 */
  --hb-native-row1-y: 846px;        /* 第一行中心 y（1920x1080 基准） */
  --hb-native-trinket-blue-x: 611px;
  --hb-native-trinket-red-x: 1268px;
}
```

- 全部允许被 URL query 覆盖：`?hbNativeItemPitch=24.4&hbNativeBlueX=672`，便于 OBS 现场微调。
- 挖孔用**绝对定位的空 div**（`.hb-native-hole`），不用 `clip-path` / `mask`——
  整块遮罩会把原生头像和血条一起挖掉。

## 4. 运行时标定（推荐做法）

静态截图测出的值只能当默认值。正式使用时建议提供一个标定页：

`/overlay/hud-calibrate` —— 在原生面板上方叠一层半透明网格 + 可拖拽的 10 个矩形，
拖动/缩放后把最终的 CSS 变量值以 JSON 打印出来，粘贴进 `config/broadcast.json`。

这样换分辨率、换 HUD 缩放、换观战面板版本时都不用改代码。

## 5. 标定脚本

`.tmp/spectator/native_calib4.py`（仓库外，仅作工具）：

```bash
python .tmp/spectator/native_calib4.py C:/Temp/spec1.png
```

做法：底部 40% 区域内找 24–34 px 的近正方形彩色连通块 → 按 y 聚类成行 →
挑行距标准差 < 4.5 的连续 5 行 → 每行取最左/最右连续图标串 → 输出 pitch/size/起点。
在 14 张 2560x1440 截图上跑，行距稳定在 54.1–54.9，图标尺寸稳定 30，pitch 稳定 32–33。

注意：该脚本对「已经裁剪过的小图」和「不含原生面板的截图」会报 `rows_not_found`，属预期。
## 6. 两套网格冲突（2026-11-14 实拍验证后补充，重要）

### 6.1 冲突本身

| 量（1920x1080） | 转播参考图 `ingame-hud-reference.jpg` | 游戏原生 TAB 记分板 |
|---|---|---|
| 行距 | 52.6 px | **40.7 px** |
| 面板横向范围 | x 310..1610（宽 1300） | **x 596..1324（宽 728）** |
| 行中心 y | 846 + i*52.6 | **846 + i*40.7**（第 5 行差 48px） |

参考图是 LPL/LCK 转播自己做的更大记分板，**它不是原生 HUD**，两者物理上不可能同时成立。
既然挖孔方案的前提是「孔必须精确盖在原生装备栏上」，**整块版式必须以原生网格为准**：

```css
.hb-bottom {
  --hb-row-h: var(--hb-native-row-pitch);  /* 40.7px，5 行总高 203.5px */
}
```

### 6.2 孔带（不能放任何内容的三条竖带）

| 区域 | x 范围（1920 基准） | 说明 |
|---|---|---|
| 蓝方饰品 | 611 .. 633 | 单个 22.5px |
| 蓝方装备 | **672 .. 818** | 6 格 × 24.4 = 146px，宽度必须 = 已拥有件数 × pitch |
| 红方装备 | **1117 .. 1263** | 镜像 |
| 红方饰品 | 1268 .. 1290 | 镜像 |

我方内容必须排在孔带**之外**：蓝方 头像/等级 600..668、名字/CS/KDA/三条状态条 822..960；红方镜像。
任何孔矩形与 `.hb-bars` / `.hb-name` / `.hb-cs` / `.hb-kda` / `.hb-vert` / `.hb-diff` 的包围盒相交时，
`syncHoles()` 必须跳过该孔并 `console.error` —— 孔压在内容上比不挖更糟。

### 6.3 原生记分板在回放/观战里是「按 Tab 才出现」的

这是挖孔方案最大的运行期风险：**记分板不可见时，挖出来的孔直接露出游戏世界**——而且按 X 呼出的
原生经济面板会把原生装备栏整个顶掉（2026-11-17 实机确认），挖孔在那一刻必然失效。
因此 **自绘装备栏是默认**（`items[]` 有 itemID/count/slot/price，图标走 `RB.icon`，
`count > 1` 画右下角角标）；要回到挖孔用 `?hbNativeItems=1` 显式开启，
并在文档与 USER-GUIDE 里写明「用挖孔就必须让原生面板保持可见」。

### 6.4 实拍验证方法（可复现）

```bash
# 1) 起假 LCDA + 服务（不要动 3210）
node tools/fake-live-server.js 3299 &
LIVE_CLIENT_URL=http://127.0.0.1:3299 PORT=3315 node src/main.js &
# 2) 灌假血条（POST /api/pixel-bars，1Hz 持续灌，否则 2s 就 stale）
# 3) 截图（含挖孔描边）
node tools/shot-overlays.cjs --base-url http://127.0.0.1:3315 \
  --pages "/broadcast/hud?hbDebugHoles=1" --out .tmp/cap-shots4 --width 1920 --height 1080
```

`.hb-holes.hb-debug .hb-native-hole` 会用青色虚线描出孔位，截图里一眼能看出孔是否压在内容上。

## 7. 标定页用法（/overlay/hud-calibrate）

原生 HUD 的装备栏几何随分辨率、UI 缩放、补丁版本变化。与其反复改常量，不如在真实客户端里现场标定：
`/overlay/hud-calibrate` 是一张全屏透明覆盖层，蓝/红两方各 5 行装备孔 + 1 个饰品孔，拖动对齐后保存到
`data/hud-calib.json`，`/overlay/hud-broadcast` 的 `nativeGeometry()` 会优先读取该文件（query 参数仍然最高优先）。

### 7.1 打开方式

```bash
# 起服务（不要动 3210）
PORT=3317 node src/main.js
# 浏览器 / OBS 浏览器源打开（1920x1080 基准，透明背景）
http://127.0.0.1:3317/overlay/hud-calibrate
```

页面默认读 `GET /api/hud-calib`：文件不存在时用内置默认（与 hud-broadcast 的 NATIVE_DEFAULTS 完全一致），
文件存在且合法时用文件值（响应里 `source: "file"`）。

### 7.2 交互

| 操作 | 效果 |
| --- | --- |
| 拖动矩形 | 移动该侧该行的装备孔（横向写回 `blueX`/`redX`，纵向位移记入该行的 `rowOffsets[row]`，其余行不受影响） |
| 拖动黄色虚框 | 只移动该行饰品孔（写回 `trinketBlueX`/`trinketRedX`） |
| 滚轮 | 改 `itemSize`，并按比例同步 `itemPitch`/`rowPitch` |
| Shift + 滚轮 | 只改 `rowPitch` |
| Alt + 滚轮 | 只改 `itemPitch` |
| 方向键（先点选一个孔） | 1px 微调；Shift + 方向键 10px |
| S / 保存按钮 | POST `/api/hud-calib`，原子写 `data/hud-calib.json` |
| R / 重置按钮 | 恢复内置默认（不写盘，需再按 S 才保存） |
| 重新读取按钮 | 重新 GET 文件值并重排 |

右侧面板的 8 个数字输入框可精确输入：`itemSize` / `itemPitch` / `rowPitch` / `row1CenterY` /
`blueX` / `redX` / `trinketBlueX` / `trinketRedX`。每行的纵向微调保存在 `rowOffsets`（5 个数值，两侧共享）。
底部提示条除操作说明外，还实时显示当前 8 个参数与 `rowOffsets`。

### 7.3 接口与校验

- `GET /api/hud-calib` → `{ ok: true, source: "default" | "file", calibration: {...8 字段...}, rowOffsets: [5 个数值], updatedAt? }`；
  文件缺失或损坏时回退内置默认，不会让 overlay 崩溃。
- `POST /api/hud-calib`：仅接受回环地址（非 127.0.0.1/::1 → `403 forbidden`）；请求体上限 1KB
  （超限 `413 payload_too_large`）；必须包含 8 个字段、全部为有限数值并在范围内
  （itemSize 4..80、itemPitch 4..120、rowPitch 8..160、其余坐标 -2000..4000），可选 `rowOffsets` 必须是
  5 个有限数值（-2000..4000），否则 `400 invalid_calibration`；写盘先写同目录临时文件再 rename，
  失败 `500 write_failed` 且保留旧文件。
- `GET /overlay/hud-calibrate`：返回标定页本身（HTML 内含 10 个 `.calib-hole` 与 8 个 `data-param` 输入）。

### 7.4 与 HUD 广播的关系

`nativeGeometry()` 的读取顺序固定为：**URL query（`?hbNativeItemSize=...` 等）> `/api/hud-calib` 文件值 > CSS 变量/内置默认**。
所以临时试验仍可用 query 覆盖，正式使用则保存一次标定即可长期生效；不创建 `data/hud-calib.json` 时行为与之前完全一致。
若文件含 `rowOffsets`，hud-broadcast 会把它按行叠加到 `row1Y + i*rowPitch`（默认全 0，不影响旧文件）。

### 7.5 标定流程建议

1. 进入观战/回放，按 Tab 打开原生记分板，让装备栏保持可见。
2. 打开 `/overlay/hud-calibrate`，先拖蓝方 row1 的矩形，让 6 格装备与饰品孔完全盖住原生装备栏；再用 Shift/Alt+滚轮微调行列间距。
3. 依次对齐 row2..row5（可分别拖动各行做纵向微调，写入 `rowOffsets`），再对齐红方 5 行。
4. 按 S 保存，然后打开 `/overlay/hud-broadcast?hbDebugHoles=1` 检查青色虚线是否正好落在原生装备栏边缘。
5. 若换分辨率或 UI 缩放，重复以上步骤即可；`data/hud-calib.json` 可随时删除回退默认。

---

## 8. 内容列布局（确定性坐标，1920×1080）

挖孔只决定「哪里必须留空」，不决定「内容放哪里」。两者唯一耦合点是一条硬规则：**孔带内不得有任何内容元素**。
内容列固定如下（行内 `position:relative` + 子元素绝对定位，每个元素一个专属不重叠盒子）：

| 元素 | 蓝方 left / width | 红方 left / width | 说明 |
| --- | --- | --- | --- |
| `.hb-champ` 头像 | 313 / 38 | 1569 / 38 | 各行垂直居中，高 38 |
| `.hb-level` 等级 | 355 / 24 | 1541 / 24 | 高 24，垂直居中 |
| `.hb-info` 名字块 | 383 / 215 | 1322 / 215 | 两行：第 1 行「名字 · 分路」，第 2 行「180 CS · 2/4/3」 |
| **孔带（必须留空）** | **611..818** | **1117..1290** | 饰品 611..633 / 装备 672..818；红方镜像 1117..1263 + 饰品 1268..1290 |
| `.hb-bars` 三条状态条 | 822 / 114 | 984 / 114 | 5.25 + 2.25 + 5.25 + 2.25 + 5.25 = 20.3，垂直居中 |
| `.hb-diff` 对位经济差 | 937 / 46 | 937 / 46 | 跨中线 960，两侧共用一列 |

行盒：蓝方 313..936（宽 623），红方 984..1607（宽 623），行高 40.7px。

### 8.1 验收指标（全部必须为 0 / 达标）

用 `.tmp/hud-measure-runner.cjs`（Electron 真实 DOM 量尺）跑：

- `rowH ≈ 40.7`
- `overlapCount`（孔 vs 内容）= 0
- `rowFitProblems`（元素垂直中心偏离本行 > 6px、越出本行 > 6px、出屏）= 0
- `contentOverlapCount`（同一行内内容元素两两相交）= 0
- `outsideRowCount`（元素横向越出本行）= 0

### 8.2 为什么内容不跟孔走

`data/hud-calib.json` 是运行时标定（换分辨率/UI 缩放后由 `/overlay/hud-calibrate` 重新标），内容列是静态设计。
若内容按孔位计算，标定一次就会让整个版式跟着漂；反过来，孔按内容计算则无法覆盖原生装备栏。
因此：内容列固定，孔带位置来自标定，二者只通过「孔带留空」这条规则耦合。

### 8.3 最终实现（2026-11-14，CSS Grid + 整块等比缩放）

8.0 表格里的「绝对定位 / .hb-info 215px」已被本节取代；实际代码：

- 单行是 CSS Grid，列宽写死 1920 设计基准：
  - 蓝方 `34px 38px 24px 202px 207px 114px 4px`，行 313..936（623px）。
  - 红方 `4px 114px 207px 202px 24px 38px 34px`，行 984..1607（623px）。
  - 红方 DOM 列号递减，CSS 必须给所有格子 `grid-row:1` 钉死，否则 Grid sparse 自动放置会把每个子项挤成新行。
- 实际绝对 x：视野 313..347，头像 347..385，等级 385..409，名字/CS/KDA 409..611，空孔带 611..818，状态条 818..932，尾部空隙 932..936；红方镜像为 1573..1607 / 1535..1573 / 1511..1535 / 1309..1511 / 1102..1309 / 988..1102 / 984..988。
- `.hb-info` 两行：第 1 行名字 + 分路（`flex:0 1 auto`，分路紧跟名字），第 2 行 `180 CS · 2/4/3` 内联；`.hb-bars` 是独立列 114px，三条 5.25px + 2.25px 间隙。
- 分辨率：`.hb-bottom-stage` 固定 1920×1080 画布，JS 写 `--hb-scale = min(innerWidth/1920, innerHeight/1080)`，`transform-origin: bottom left`。1366×768 是 0.711 倍缩略图，不做第二套字号/行高。
- 底部垂直偏移 `syncBottomOffset()` 用设计坐标固定计算：`offset = 1080 - row1Y - rowPitch*4.5`，1920×1080 = 50.85px，使 5 行中心落在 846/887/928/969/1010。
- 验收实测（1920×1080，假 LCDA + 6 件装备/人）：rowH=40.69、overlapCount=0、rowFitProblems=0、contentOverlapCount=0、outsideRowCount=0、10 个孔全部落在空孔带内、0 条重叠告警。

---

## 9. 原生血条/资源条视觉规格（t35 外部取证 + 实测，2026-11-14）

证据来源：`.tmp/spectator/kb/native_bar_visuals.md`（500 行、44 处 URL）、`.tmp/spectator/kb/native_bar_visuals.json`、`.tmp/spectator/kb/_raw/wiki/img/`。

### 9.1 血条渐变（贴图比例 + 实机色）

`Assets - Health Bar.png`（459×19）像素实测停靠点：`0% #0A5415 / 25% #015908 / 50% #016E06 / 75% #04C405 / 90% #02D804 / 100% #09C200`，主亮度跃迁在 75%→90%。
实机 2560×1440 逐像素实测（更亮，以实测色为准）：起点 **#10A142**、满条末端 **#00FB52**。
结论：**渐变锚定整条轨道、按当前填充长度裁切**（不是铺满填充宽度）——HUD 用 `background-size:(100/pct)% 100%` 实现。

### 9.2 资源条

health / mana / energy 三张条带同为 459×19、亮度曲线形状一致 → **同一亮度蒙版换色相**，左右端帽共用（各 4×18）。法力实机满条 **#2165DE → #46BFF7**。

### 9.3 掉血残影

`File:Damage taken.gif`（120 帧 × 30ms）实测确认**两段式**：即时层跳到新值 + 浅色拖尾层收缩消失；拖尾约 13 帧 ≈ 390ms（仅量级参考）。精确 ms/easing **无公开规格（unverified）** → HUD 取 400ms ease-out。

### 9.4 护盾

叠在**血条内部右端**（实测约占条内 17%），不是覆盖整段、也不是独立条。颜色：普通盾 `#C0C0C0`、魔法盾 `rgb(188,105,211)`、物理盾 `rgb(255,120,20)`。Mordekaiser 的**潜在护盾是独立资源条**，只有 W 激活后的真护盾才叠血条。

### 9.5 Rengar 残暴 pips

血条**下方**独立 4 格：单格宽 = 条宽 15.4%、间距 9%、起始 4%、总跨度 92%、高约 4px、斜平行四边形（逐行左移 1px）。未满白、满层橙（`#e07a2a` 近似，精确 hex unverified）。

### 9.6 Rumble 热量

上限 **150**（不是 100）、危险区 50、不使用基础技能 4s 后每秒 -10。**条上是否有 50 刻度线：无公开记录（unverified）**；危险区/过热颜色同样 unverified。HUD 的 1px 刻度线仅为可用性提示，透明度需压低。

### 9.7 血条刻度（新发现）

Wiki 原文：血条按**每 100 生命一个刻痕**（"Each mark represents one hundred health ... segmented every thousand health"），截图实测 5 刻痕 / 6 段、间距约 18.25px。HUD 目前未画；若要画，按 `条宽/(ceil(maxHP/100)-1)` 等距。

### 9.8 未验证清单（8 条）

floatinghealthbars 目录文件清单（CDragon 恒 522）、客户端真实贴图名、贴图与实机色差原因、残影精确时长/缓动、Rumble 刻度线与颜色、15 种资源类型独立色板、pips 角度与精确 hex、Assets 贴图对应版本号。

