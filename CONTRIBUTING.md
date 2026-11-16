# 参与贡献（CONTRIBUTING）

欢迎参与 Khada Jhin 开发！本文档帮你 10 分钟内跑起来并提交第一个 PR。

## 环境准备

- Windows 10/11 x64，Node.js ≥ 18
- `git clone` 后在项目根目录执行 `npm install`（首次需联网下载 Electron 与 electron-builder）
- `npm start` 启动桌面程序（Electron 托盘 + 本地服务，默认 http://127.0.0.1:3210）
- 只跑服务不开窗口：`npm run server`

## 开发约定

- 动手前先读 [ARCHITECTURE.md](ARCHITECTURE.md)（技术选型与模块关系）与 [CONVENTIONS.md](CONVENTIONS.md)（编码与接口约定）
- 内部开发记事（决策脉络、踩坑史）在 [docs/internal/](docs/internal/)，对外文档在根目录与 docs/
- 代码全部 CommonJS：单引号、2 空格、分号；新增路由/模块沿用既有形状
- 本地测试服务端口请使用 3311..3330，不要占用 3210

## 测试与验证

    node --test

提交前请保证测试全绿。视觉改动建议用截图工具自检：

    npm run shot -- --base-url http://127.0.0.1:3210 --phase in_game

## 提交 PR

1. Fork → 分支（`feat/xxx` 或 `fix/xxx`）→ 提交
2. 说明改动动机与验证方式（测试结果/截图）
3. 涉及 UI 的改动请附截图

## 合规红线（必须遵守）

本项目**只读**：不读取游戏内存、不注入游戏进程、不修改游戏文件、不绕过反作弊、不模拟游戏操作。任何 PR 不得引入以上行为，包括"临时调试用"的实现。涉及 Riot 数据的功能只允许使用官方本地接口（LCU、Live Client Data API）、官方回放文件与公开 Data Dragon 数据。

## 反馈问题

使用 [Issues 模板](https://github.com/RyeRaven/-lol-broadcast-hud/issues/new/choose) 提交 bug 或功能建议。
