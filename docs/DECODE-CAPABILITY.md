# RiftBroadcast 0xdd 观战数据解码能力（DECODE-CAPABILITY）

> 状态：解码核心已在真值局 NJ100-901131919780 全字段验证通过（2026-11-16，v12）。
> 实现：`tools/decode0dd/decode_statblocks.py`；报告：`.tmp/decode_<game>.json`。
> 相关：语料回放桥 `tools/protocol-corpus-replay.cjs` / `docs/PROTOCOL-FEED.md`；
> 语料与真值：`C:/Temp/obs4/`（statblocks/*.jsonl、corpus/index.json、dec_check.json）。

## 1. 传输层

- 观战下行包：Blowfish-ECB 解密 + `inflateRaw`（窗口位 10）解压。
- 语义标记 `0xdd`：标记 per-player stat block 语义消息（区别于其他帧类型）。
- stat 消息包络：`id(3B) [const] len(u32 LE=P) op(u16 LE) [const5] payload(P)`。
- keyframe state entry（len≈200–250K）内含全量 10 名玩家 stat block；
  anchor 命中恒 10/keyframe。playerId 按 keyframe 内出现顺序 0..9 赋值
  （`id` 字节跨 keyframe 不稳定，不可作主键）。
- 提取器：`tools/decode0dd` 流水线 → `statblocks/<game>.jsonl`
  （每行 `{t, order, payload-hex}`）。

## 2. Stat block 内部结构（经验证的字段布局）

stride-2 字节槽（偶数偏移承载语义字节，奇数位为结构字节）。已定位字段：

| 字段 | 偏移 | 类型 |
|---|---|---|
| xp | 79 | f32 |
| minionsKilled | 119 | f32(整值) |
| jungleMinionsKilled | 127 | f32(整值) |
| totalGold | 111 | f32 |
| kills | 151 | u8 |
| deaths | 159 | u8 |
| assists | 167 | u8 |
| (kills 副本槽) | 862 | 与 151 恒 rawEqual |

f32 为标准 IEEE 754 single：指数场天然横跨 b3（高 7 位，b3 = E8>>1）与 b2 最高位
（E8&1 奇偶位）——相邻指数时代的字节会合并，这是 era-spanning codepoint 一致性的来源。
b0=m&255、b1=(m>>8)&255、b2=(m>>16)&0x7F|par<<7、b3=E8>>1。

## 3. S-box（cp→byte 映射）模型

- 映射**按负载偏移 mod 64 分表**：`byte = M[offset % 64][cp]`。
  实证：1025 个 (offset,cp) 对在 P=64 下零冲突；P≤48 均有结构性冲突
  （如 minions b0 结构性为 0 与 u8 语义值在相距 32 的偏移上撞 cp）。
  lane 间隔 8 字节 → 8 条 lane 共用一个 64 槽周期。
- **S-box 每局随机**：映射必须按局重建。真值局用 timeline 真值（dec_check.json）
  求解；无真值的实时局需要局内自解（见 §6 开放问题）。
- pad codepoint（本局 0xc9，`detect_pad` 自动检测）→ byte 0。

## 4. 求解方法（按字段类型）

1. **u8 语义字段**（kills/deaths/assists）：truth pairing 直接得 cp→value 双射；
   罕见值跨字段冲突如实上报（multiValued），不合并。
2. **整值 f32 lane**（minions/jungle）：int 真值 ±tol 的 `struct.pack('<f', int)`
   字节投票 ×10；pad→0 ×100；加权多数 + 2× 歧义规则。
3. **xp/totalGold（v12 直接派生法）**：对每个有真值的样本，从 tv 的 IEEE 位
   派生 4 个存储字节，按 (residue, cp) 跨全部出现做**多数票**。亚单位
   payload 漂移（payload 值与 timeline 值低尾数位差异 <1 单位）在多数票中被
   吸收；严格平票的 cp 保持未钉 → 解码为 null（绝不伪造）。

## 5. 真值局验证结果（NJ100-901131919780，30 帧 × 10 玩家）

| 字段 | 覆盖 | 精度 |
|---|---|---|
| minionsKilled | 300/300 | exact，maxErr 0.00 |
| jungleMinionsKilled | 202/300 | exact，maxErr 0.00 |
| kills/deaths/assists | 全覆盖 | 双射 mismatches=0 |
| xp | 207/300 | **floor-exact 100%**，maxErr 0.00 |
| totalGold | 204/300 | **floor-exact 100%**，maxErr 0.01 |

floor-exact：`int(decoded) == int(truth)`，与原版解码器结论一致
（原版 n=256/252 floor 100%）。覆盖缺口来自严格平票的 cp（漂移把低尾数字节
劈成两半时诚实弃权），不解码不伪造。

## 6. 开放问题

1. **实时局自解**：S-box 每局随机，实时局无 timeline 真值。候选：
   局内结构约束自解（pad、整值 lane、单调性）或首局校准续用（待验证 S-box
   是否按对局/按会话轮换）。
2. 覆盖率打磨：平票 cp 可用 floor-window 交集/相邻字节桶做二次仲裁（保持诚实性）。
3. 除 7 个已定位字段外的其他字段（damage 类等）偏移与类型未定位。
