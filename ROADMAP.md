# ROADMAP — 项目路线图

## 已完成（0.2.2）

- BP 广播页、局内 HUD、赛后庆典、转场页（OBS Browser Source，1920×1080）
- LCU / Live Client Data / Data Dragon 数据接入，mock 模式全流程演示
- OBS WebSocket v5 场景包一键创建、阶段自动切场景
- **血条/资源条像素读取**：OBS 游戏采集源截图识别侧栏百分比（切屏免疫）
- **金币/经验精确接入**：官方回放/观战协议流解码喂流，对位经济差显示精确值
- 龙/塔/潮虫事件增量账本；post_game 冻结后新局自动解锁
- 协议解码能力白皮书（[docs/DECODE-CAPABILITY.md](docs/DECODE-CAPABILITY.md)）
- GitHub 开源（GPL-3.0）+ 0.2.2 安装包 Release

## 近期计划

- [ ] live 协议流实机验证（需管理员权限抓取观战密钥 + 真实观战局）
- [ ] CS 口径修正：minionsKilled 与 jungleMinionsKilled 求和待拍板 🏷️ **good first issue**
- [ ] 潮虫 HordeKill 事件名真机验证
- [ ] CI（GitHub Actions 跑 node --test）🏷️ **good first issue**
- [ ] README 英文 TLDR 🏷️ **good first issue**
- [ ] 0.2.3 打包发布

## 中期想法

- 控台 UI 视觉升级（当前功能优先、样式朴素）
- HUD 不对称渲染的根治方案（A 键等输入问题）
- 多语本文档站（GitHub Pages）

> 协作方式：认领任务请在 Issue 里留言，避免重复劳动；大改动先开讨论再动手。
