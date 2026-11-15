# 像素读条接入（t23）

HUD 底部条上的**生命条 / 资源条**来自像素读条，而不是任何官方接口。这一节说明它为什么存在、
数据怎么流、精度和延迟是多少、什么时候会失效，以及为什么永远没有绝对数值。

## 1. 为什么需要像素读条

| 数据源 | 生命 / 资源百分比 | 绝对数值（当前 HP/最大 HP、当前法力/最大法力） |
| --- | --- | --- |
| LCU（本地客户端 API） | 无 | 无（观战接口不暴露对局内实时状态） |
| Live Client Data（127.0.0.1:2999） | **无**：allPlayers[] 不含 health / maxHealth / resourceValue / resourceMax | 无 |
| 观战协议流（0xdd 等） | 未解出 | 未解出（t17 已证明 gold/xp 无真值锚点） |
| 读游戏进程内存 | 技术上可行 | 技术上可行 |
| 像素读条（本项目采用） | **有**（0..100%） | **永远没有** |

读游戏进程内存被明确禁止（见 [USER-GUIDE.md](USER-GUIDE.md) §8：不读取游戏内存、不注入、不绕过反作弊），
实际尝试 OpenProcess 也被反作弊拒绝。因此唯一合规可行的手段就是**截屏读原生血条的长度**。

结论：HUD 上这三条**只画长度，不显示数字**。数字要么拿不到，要么只能靠猜——猜就是伪造。

## 2. 数据流

    hp_bars.py（同机独立进程，截屏读像素）
            │  stdout，每行一个 JSON（NDJSON）
            ▼
    tools/pixel-bars-bridge.cjs（桥：限速 1..10Hz、崩溃退避重启）
            │  POST http://127.0.0.1:<PORT>/api/pixel-bars
            ▼
    src/main.js  →  src/pixel-bars.js（校验 + 2000ms TTL 缓存）
            │
            ├─ state.pixelBars = {active, updatedAt, stale}
            └─ players[].hpPercent / resourcePercent / shieldPercent / resourceColor
            │
            ▼
    src/live-data.js normalizeLiveState（按 (team, 行序) 回填）
            │
            ▼
    src/data-capability.js（hpPercent/resourcePercent：unavailable ⇄ estimated）
            │
            ▼
    /events SSE → HUD 页面按契约画条

主进程**不直接调 GDI / 截屏**：像素采集必须在独立进程里做，主进程只负责 HTTP 与状态，
这样采集端崩了不会带崩直播服务，也便于替换实现（python / C# / 任意语言，只要按行吐 JSON）。

## 3. 请求体与字段

POST /api/pixel-bars

    {
      "ts": 1794509940336,
      "source": "pixel",
      "bars": [
        {
          "side": "blue",
          "rowIndex": 0,
          "kind": "hp",
          "fillPercent": 42.5,
          "shieldPx": 5,
          "dominantColor": [40, 200, 90],
          "status": "ok"
        }
      ]
    }

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| side | blue / red | 与 Live Client Data 的 team 一致 |
| rowIndex | 0..4 | 该队伍内的**出场顺序**（不是屏幕坐标） |
| kind | hp / resource | 生命条 / 资源条 |
| fillPercent | 0..100 的有限数，或 null | null = 这一轮没读到，**不等于 0%** |
| shieldPx | 非负有限数 | 白色护盾段的像素宽度（可选） |
| dominantColor | [r,g,b] | 资源条主色（可选，用于把能量/怒气等染成原色） |
| status | ok / ok_pale / absent / unsupported | absent = 该条不存在；unsupported = 形态未被支持 |

校验规则（任何一条不满足 → 整包 **400**，且**不写入任何状态**）：

- fillPercent 必须是 0..100 的有限数或 null（120、-1、"abc"、Infinity 全部拒绝）；
- side / kind / rowIndex 必须在枚举内，rowIndex 必须是 0..4 的整数；
- 同一 (side, rowIndex, kind) 不允许出现两次——无法判断哪个是真的，宁可拒绝也不猜；
- absent / unsupported 的条即使带了 fillPercent 也一律按 null 处理。

安全约束：

- 只接受来自 127.0.0.1 / ::1 的请求（检查 req.socket.remoteAddress），其它来源一律 **403**；
- **不设 Access-Control-Allow-Origin**：这是内部写接口，浏览器页面不该能跨源调用它；
- 请求体上限沿用 MAX_BODY_BYTES（1 MB），超限返回 **413** 且服务存活。

诊断：GET /api/pixel-bars/status → {ok, active, updatedAt, stale, ttlMs, lastBars}。

## 4. 精度与延迟

- **精度 1px ≈ 1.96%**：原生血条在 1920×1080 下有效满宽约 51px，1/51 ≈ 1.96%。
  所以 fillPercent 的最小刻度约 2 个百分点，不是连续值。
- **延迟 ~14ms**：一次截屏 + 像素扫描的端到端耗时（t15 实测），相对 1Hz 的 HUD 重绘可以忽略。
  桥的默认上报频率是 5Hz，可配 1..10Hz；高于 10Hz 对 1Hz 刷新的 HUD 没有意义。
- **契约精度**：hpPercent / resourcePercent 在契约里是 estimated（source: 'pixel-bars'），
  **永远不是 exact**——它是读出来的长度，不是游戏给的数字。

## 5. 失效条件（最重要的一条）

> 超过 **2000ms**（PIXEL_BAR_TTL_MS）没有收到新的读数，对应字段一律变 null。

具体行为：

1. src/pixel-bars.js 的 store 只保留最后一包读数，超过 TTL 的条目在 snapshot() 里被过滤掉；
2. src/main.js 每秒执行一次 refreshPixelBars()：没有有效读数时把玩家的
   hpPercent / resourcePercent / shieldPercent / resourceColor / pixelBars 全部清成 null；
3. 同时用 applyPixelBarsAvailability(state.capability, false) 把契约里的
   hpPercent / resourcePercent 降回 unavailable，HUD 的 capUsable 门控随即停止画条，
   改为 .unknown 占位；
4. 桥进程崩溃时会退避重启（1s 起、上限 15s），期间同样走上面的失效路径。

**绝不保留旧值**：宁可画一个「—」，也不能让观众看到一条早已过期的血量。
这一条是 t20 契约的直接要求（unavailable 必须显式占位），也是本项目所有数据源的统一原则。

## 6. 为什么没有绝对数值

- Live Client Data 的 allPlayers[] 不含 health / maxHealth / resourceValue / resourceMax；
- 观战协议流里的 gold/xp 已证明无法用真值锚定（t17），生命/资源更没有可用的锚点；
- 读进程内存被禁止（合规）且被反作弊拒绝（技术）；
- 从百分比反推绝对值需要「最大生命值」这个数，而它随等级/装备/符文变化，官方接口不给逐时刻值，
  用 Data Dragon 静态值反推会在装备变化后立刻失真——那就是伪造。

因此 HUD 上这三条**只画长度**：经验条（紫，来自协议流 xp，暂不可用）、生命条（绿）、资源条（原色）。
对位经济差、CS、KDA、等级、装备、符文、召唤师技能这些仍然走各自的数据源与精度，见
[src/data-capability.js](../src/data-capability.js) 与 [USER-GUIDE.md](USER-GUIDE.md) §5。

## 7. 启动与排障

    # 1) 先启动主服务（默认 3210）
    npm start

    # 2) 再启动像素桥（另开一个终端）
    node tools/pixel-bars-bridge.cjs --port 3210 --rate 5

    # 3) 诊断：active=true 且 lastBars 非空，说明读数在流
    curl http://127.0.0.1:3210/api/pixel-bars/status

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 桥打印「找不到像素脚本」并退出码 2 | 像素采集脚本不存在 | 用 --script 指定实际路径；**桥不会伪造读数** |
| status.active=false 且 updatedAt=null | 从没收到过读数 | 检查桥是否在跑、端口是否与主服务一致 |
| status.stale=true | 收到过但已超过 2000ms 没更新 | 看桥的 stderr；游戏是否已退出 |
| 400 invalid_pixel_bars | 包里有非法字段 | 响应体的 detail 会指出具体是哪个 bars[i] |
| 403 forbidden_source | 不是本机来源 | 只允许 127.0.0.1；不要试图从局域网写 |

## 8. 相关文件

- src/pixel-bars.js —— 校验、TTL 缓存、(team, 行序) 映射、HTTP 处理
- tools/pixel-bars-bridge.cjs —— 像素进程桥（NDJSON → HTTP，限速 + 退避重启）
- src/live-data.js —— normalizePlayer 的 hpPercent 等字段、normalizeLiveState 的 pixelBars
- src/data-capability.js —— hpPercent/resourcePercent 的 unavailable ⇄ estimated 切换
- src/main.js —— POST /api/pixel-bars、GET /api/pixel-bars/status、refreshPixelBars()
- docs/PIXEL-BARS.md §9 —— 真实脚本 hp_bars.py 的字段结构、驱动模式与端到端验证命令
## 9. 对接真实像素脚本（t27）

t23 只把管道接通，读数来自假脚本。t27 把真实采集脚本 hp_bars.py 接进来，并在没有对局的情况下
用离线截图跑通了「真实像素 → 桥 → 主进程 → SSE → HUD DOM」的完整链路。这一节记录对接时发现的
真实差异、脚本输出的逐字段含义，以及可复现的验证命令。

### 9.1 真实脚本在哪

像素脚本不属于本项目仓库，它是 t15/t24 在另一个 workspace 里的产物，只读使用：

    C:/Users/RyeRaven/Documents/deepseek-harness/default-workspace/.tmp/spectator/pixel/
      hp_bars.py        40 KB，python 实现（主实现）
      hp_bars.ps1       21 KB，PowerShell 实现（与 py 共享同一 geometry 与决策规则，用于 parity 校验）
      README.md         19 KB，几何解析、标定、字段语义的原始文档
      calibrate.sh      标定辅助
      geom/             1920x1080.json / 2560x1440.json / live_2560x1440.json

桥的默认路径就是这个位置（tools/pixel-bars-bridge.cjs 的 DEFAULT_SCRIPT =
path.join(项目根, .tmp, spectator, pixel, hp_bars.py)）。路径不同时用参数覆盖：

    node tools/pixel-bars-bridge.cjs --script <你的>/hp_bars.py --python <真实解释器>

也可以用环境变量：PIXEL_BARS_SCRIPT、PYTHON、LOL_PIXEL_GEOM、PIXEL_BARS_IMAGE。

**python 解释器必须显式指定**：Windows 自带的 python 是 Microsoft Store 的别名 stub，
运行 python --version 没有任何输出，脚本会静默失败。本机可用的真实解释器是

    C:/Users/RyeRaven/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe

### 9.2 脚本的三种输出与三种驱动

hp_bars.py 有两种运行方式，桥对应三种驱动模式：

| 脚本调用 | 脚本行为 | 桥的 --drive |
| --- | --- | --- |
| 无参数常驻 | 从 stdin 读命令：scan / bench N / bench1 N / calibrate / geometry / calib / quit，每条 scan 输出一行 JSON | scan（默认）：桥按 --rate 每 1/rate 秒向 stdin 写一行 scan |
| --image <png> --json | 处理单张截图，输出一行 JSON 后退出 | image：桥每轮 spawn 一次，读完一行等进程退出再排下一轮 |
| 自建循环 | 脚本自己按频率输出 | none：桥只读 stdout，不写 stdin |

注意 hp_bars.py **不认 --rate**（它的 argparse 只有 --image / --geometry-file / --calibrate /
--save-geometry / --calib-hud），频率完全由桥决定。

几何文件解析顺序（脚本自身）：--geometry-file > LOL_PIXEL_GEOM > 自动探测 > baseline。
桥的 --geometry 只是把值透传成 --geometry-file。

### 9.3 一行输出的真实结构

    {"seq":1,"ms":13.182,
     "bars":{"L1":0.6667,"L2":1.0,...},
     "mana":{"L1":null,"L2":0.784,...},
     "detail":[ 20 条 ]}

detail[] 才是逐条读数（bars/mana 是它的压缩映射，桥优先读 detail[]）：

| 字段 | 实测取值 | 含义 |
| --- | --- | --- |
| side | "L" / "R" | 屏幕左侧 / 右侧。**桥负责归一化成 blue / red**，主进程只认 blue/red |
| rowIndex | 0..4 | 该侧自下而上的行序（对应队伍内出场顺序，不是像素坐标） |
| kind | "hp" / "resource" | 生命条 / 资源条（桥把 mana/energy 也归到 resource） |
| fillPercent | 0..100 的有限数，或 null | 0 表示条在屏幕上但为空（阵亡）；null 表示没有可用像素 |
| confidence | 0..1 | 本次读数的置信度，低于阈值时 status 会退化 |
| satMedian | 数值或 null | 条带区域饱和度中位数，用于判断是不是真的资源条 |
| lumEmpty | 19.0 | 空条区域的亮度基准 |
| dominantColor | [r,g,b] 或 null | 条带主色，用来把能量/怒气染成原色 |
| shieldPx | 非负整数 | 白色护盾段像素宽度 |
| status | ok / ok_pale / unsupported / absent | ok_pale = 读到了但颜色偏淡；unsupported = 形态不支持（如无资源条英雄的灰色占位）；absent = 该位置没有玩家卡片 |
| reason | 字符串（可选） | 人类可读的原因，例如 grey placeholder (lum 198 < 215): champion has no resource bar |

两处必须记住的差异：

1. side 是 L/R，不是 blue/red —— 桥做归一化，否则服务端会 400 invalid_pixel_bars；
2. 常驻模式靠 stdin 的 scan 驱动，传 --rate 会被忽略 —— 桥改成周期性写 scan。

### 9.4 离线实测（C:/Temp/spec1.png，1920x1080）

    <bundled-python> hp_bars.py --image C:/Temp/spec1.png --json

输出（exit=0，ms=13.182，20 条 detail）：

| 位置 | hp | resource |
| --- | --- | --- |
| L1 | 66.7 | null（unsupported，灰色占位 lum 198 < 215：该英雄没有资源条） |
| L2 | 100 | 78.4 |
| L3 | 56.9 | 47.1 |
| L4 | 0（阵亡，条是空的） | null（unsupported：champion is dead） |
| L5 | 62.7 | 92.2 |
| R1 | 88.2 | 100 |
| R2 | 43.1 | 88.2 |
| R3 | 39.2 | 88.2 |
| R4 | 80.4 | 94.1 |
| R5 | 51 | 62.7 |

1px = 1/51 ≈ 1.96%，所以所有数值都是 1.96 的整数倍（66.7 = 34px、100 = 51px、0 = 0px）。
0 与 null 是两种不同的东西：0 是「条确实空了」，null 是「没读到」，HUD 对前者画 0 长度条、
对后者画 unknown 占位。

### 9.5 端到端验证（可复现）

没有对局时也能验证真链路：假 Live Client Data 提供 10 名玩家，真脚本读离线截图，桥持续喂帧。

    # 1) 假 LCDA（10 名玩家，端口 3314）
    node tools/fake-live-server.js 3314

    # 2) 主服务（端口 3313，绝不占用 3210）
    PORT=3313 LIVE_CLIENT_URL=http://127.0.0.1:3314 node src/main.js

    # 3) 桥：图像模式，1Hz，指向真实脚本与真实解释器
    node tools/pixel-bars-bridge.cjs --port 3313 --drive image \
         --image C:/Temp/spec1.png \
         --script C:/Users/RyeRaven/Documents/deepseek-harness/default-workspace/.tmp/spectator/pixel/hp_bars.py \
         --python C:/Users/RyeRaven/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe \
         --rate 1

实测结果（.tmp/t27-smoke.js）：

- 桥未起：pixelBars={active:false,updatedAt:0,stale:false}，契约 hpPercent.precision=unavailable；
- 桥起 4s：GET /api/pixel-bars/status → {"active":true,"stale":false,"n":20}，
  lastBars[0]={side:"blue",rowIndex:0,kind:"hp",fillPercent:66.7,status:"ok",dominantColor:[13,182,67]}；
- /api/state：hpPercent 依次 66.7 / 100 / 56.9 / 0 / 62.7 / 88.2 / 43.1 / 39.2 / 80.4 / 51，
  resourcePercent null / 78.4 / 47.1 / null / 92.2 / 100 / 88.2 / 88.2 / 94.1 / 62.7，
  resourceColor 如 [49,138,232]，shieldPercent 全 null；契约升为 estimated/pixel-bars；
- /events：17 帧里 12 帧带 hpPercent，最后一帧与 /api/state 逐字段一致；
- HUD DOM：<span class="hb-bar hp" title="生命 67%"><i class="hb-bar-fill" style="width:66.7%;
  background:rgb(13,182,67)"></i>...</span> —— 10 名玩家的 hp 宽度与 hpPercent 全部相等，
  resource 宽度与 resourcePercent 相等（null 时为 0%）；
- 停桥 3.2s：status={active:false,stale:true}，10 个 hpPercent 全变 null，契约降回 unavailable，
  HUD 渲染成 hb-bar hp unknown 且宽度全为 0%（占位，不是实心 0% 血条）。

### 9.6 常驻模式（有对局时）

    node tools/pixel-bars-bridge.cjs --port 3210 --rate 5 --python <真实解释器>

此时脚本常驻、桥按 5Hz 写 scan。**没有对局**（游戏没开、HUD 被遮挡、几何不匹配）时，
脚本的 20 条 detail 全是 fillPercent:null + status:"absent"，桥照常转发——
主进程据此把三条状态条降级为 unknown，而不是沿用旧值或画成 0%。这是刻意行为：
「没有读数」必须显式到达服务端，桥不能因为看起来没数据就跳过发送。

### 9.7 回归覆盖（test/pixel-bars.test.js，16 个用例）

t23 的 12 个用例之外，t27 补了 4 个：

| 用例 | 钉住的行为 |
| --- | --- |
| L/R + detail[] 归一化 | 真实脚本输出能被解析成 blue/red，且归一化后必须通过服务端校验；认不出的条丢弃、整行认不出则不发空包 |
| --image 驱动持续采样 | 每轮脚本退出后桥仍按 --rate 继续，700ms 内至少 3 包（防回归：定时器 unref 导致桥一轮就退出） |
| 参数解析 | --image 隐含 image 驱动、--geometry 透传、非法 --drive 报错、rate 夹到 1..10 |
| 真实脚本条件用例 | 脚本与截图都在本机时实跑 hp_bars.py，断言 10 条 hp + 10 条 resource、能通过服务端校验、存在 hp=0 的真实读数；缺失则显式 skip，绝不伪造 |
- test/pixel-bars.test.js —— 16 个回归用例（含真实服务 + SSE + 413 + 403 + 陈旧降级 + 真实脚本对接）
