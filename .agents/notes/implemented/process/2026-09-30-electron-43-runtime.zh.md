# 桌面运行时升级到 Electron 43

Status: implemented
Translation: current

[English](2026-09-30-electron-43-runtime.md)

## 摘要

桌面端原先运行在 Electron 39。这个版本已停止维护，并且强制关闭了 Chromium 在 macOS 上的
WebContents 遮挡检测，所以 Lody 窗口被遮住时，无法经由这条路径进入后台节流。运行时现在
升级到 Electron 43.7.6，同时使用 electron-vite 6.0.0-beta.5；这是第一个在构建目标表中覆盖
Electron 42–44 的 electron-vite 版本。Electron 43 仍支持 macOS 12，也保留了同步的剪贴板
API，所以这一步不需要任何用户可见的迁移。但它需要维护者接受两项策略例外：使用预发布版的
构建工具，以及让 19 个包绕过 pnpm 的七天发布隔离期。恢复遮挡检测后能省多少电，目前还没有
测量。

## 起因

2026-09-29 的一次能耗排查发现，Electron 39 的每个进程都带着
`--disable-features=MacWebContentsOcclusion`。Electron 一直强制关闭这个特性，直到
[electron/electron#50579](https://github.com/electron/electron/pull/50579) 修复了多个
WebContents 时的可见性错误，修复进入了 40.9.0、41.2.0 和 42.0.0。此外，Electron 39 已经
不在官方支持范围内（截至 2026-09-30，官方支持 42、43、44）。

之前的 Electron 44 升级（[#635](https://github.com/LodyAI/Lody/pull/635)、
[#636](https://github.com/LodyAI/Lody/pull/636)）按"不接受临时绕过"的升级原则被关闭。
electron-vite 5.0.0 没有 Electron 39 之后的构建目标，遇到未知主版本时会静默退回
Node 16 / Chrome 108；并且 Electron 42+ 在安装依赖时不再下载二进制。兼容性的 API 预备改动
已单独合入（[Electron API 预备](../bug-fix/2026-09-13-electron-api-preparation.md)）。

## 决策

- 锁定 `electron@43.7.6`，而不是最新的 44.5.1。Electron 44 放弃了 macOS 12，移除了图片
  导出仍在使用的同步剪贴板 API，并且在 macOS 27 上，当系统电源通知注册失败时会在启动阶段
  崩溃，该问题仍未关闭（[electron/electron#54490](https://github.com/electron/electron/issues/54490)）。
  43.7.6 是 43 系列中第一个包含 WASM 代码缓存修复的版本
  （[electron/electron#54234](https://github.com/electron/electron/pull/54234)）；Lody
  会加载 Loro 和 Flock 的 WASM，而 Sparkle 会在补丁版本之间原地更新。它同时包含
  ELECTRON_RUN_AS_NODE 子进程退出崩溃的修复（43.4.1）、透明窗口被误判为遮挡物的修复
  （43.2.0）以及空闲唤醒的优化（43.4.1）。Electron 43 将于 2027-01-05 停止维护；届时升级到
  44 只需再处理剪贴板接口和 macOS 13 的最低版本要求。
- 使用 `electron-vite@6.0.0-beta.5`。它是唯一带有 Electron 42–44 构建目标的版本，现有配置
  无需任何修改。Vite 仍保持 7，所以 renderer 依旧由 Rollup 打包。
- `scripts/postinstall.mjs` 在 `install-app-deps` 之前执行 Electron 自带的 `install.js`
  （幂等），因为开发、预览和 E2E 测试都通过 `electron/path.txt` 启动二进制。
- 在 `minimumReleaseAgeExclude` 中放行 Electron、electron-vite、rolldown、magic-string
  这几个版本，以及全部 15 个 `@rolldown/binding-*@1.2.11` 包。处于隔离期的可选 binding 会被
  静默地从锁文件中去掉，不报任何错误；rolldown 1.2.11 随后解析到了被提升的 1.1.5 binding，
  并在打包 `electron.vite.config.ts` 时失败（`sourcemapPathTransform ... returned object`）。
  单独干净安装 rolldown 1.2.11 并使用其自带的 binding 则一切正常。

## 备选方案

- Electron 44.5.1：暂不采用。原因是它放弃了 macOS 12，剪贴板迁移必须一次性完成
  （[桌面原生交互](../../../../specs/desktop-native-interactions.md)），并且 macOS 27 的
  启动崩溃问题仍未关闭。
- 保留 electron-vite 5，显式写构建目标并手动安装二进制：这正是 #635 评审中被拒绝的绕过方式。
- 等待 electron-vite 6.0.0 正式版：如果不能接受预发布版，这是最稳妥的选择。从 2026-04 到
  2026-09-29 共发布了六个 beta，其中三天内出现了两次破坏性修复。

## 验证

在 macOS 27 arm64 上，与同一基线升级前的构建对比：

- `pnpm --dir apps/electron build`（包含类型检查）通过；主进程产物增加 5 字节，preload
  完全相同，renderer 同为 598 个文件，体积增加 0.25%。
- Electron 单元测试 199/199；CLI 测试套件在 Node 24.21（即 43.7.6 内置的 Node）上 3253 个
  通过、4 个跳过。
- 基于 43.7.6 执行 `pnpm run package --dir`，通过内置 CLI 启动检查以及 SQLite、node-pty
  加载检查。应用中所有原生模块都是 Node-API，无需重新编译。
- `pnpm e2e:check`、`pnpm e2e:smoke`（6/6）和 `pnpm e2e:full`（24/24 个场景、249 个步骤）
  均通过。
- Electron 43.7.6 和 44.5.1 的子进程参数 `--disable-features` 中已不再包含
  `MacWebContentsOcclusion`，而 39.5.1 仍包含。
- 删除 Electron 二进制后执行 `pnpm install`，能自动恢复。

## 局限

- 没有在本地构建或启动 Windows、Linux 版本。binding 被静默丢弃的问题与平台相关，必须靠 CI
  覆盖。
- 遮挡检测能否降低 Lody 的能耗尚未测量。一次"窗口被完全遮挡"的对照实验没有得出结论，因为
  测试窗口无法稳定地显示在屏幕上。即使有效，它也解决不了同一次排查中测到的主要开销：窗口
  可见时，无限循环的动画会让窗口按显示器刷新率持续出帧。
- electron-vite 6 仍是预发布版，后续 beta 可能再次改变行为。
