# 默认让桌面 E2E 窗口在后台运行

Status: implemented
Translation: current

[English](2026-09-12-desktop-e2e-window-visibility.md)

## 摘要

桌面 E2E 仍然启动构建后的 Lody 应用、真实 Electron main process、preload、renderer、
IPC graph 和 bundled CLI，但默认不显示产品窗口。这样，串行执行的每条 Cucumber 场景
不会反复激活 Lody、抢走开发者的键盘焦点。`LODY_E2E_SHOW_WINDOW=1` 会为交互式调试
恢复正常可见窗口。隐藏的 E2E renderer 会关闭 Chromium background throttling，确保
timer 和性能采样继续正常运行。

## 决定

- 只有未打包应用收到 `LODY_E2E=1` 时才启用隐藏模式。打包应用忽略测试窗口开关，
  保持正常的窗口可见性和 throttling 行为。
- 所有模式都继续以 `show: false` 创建窗口。触发 `ready-to-show` 后，普通桌面启动和
  显式 headed E2E 会调用 `show()`；默认 E2E 不调用。
- 隐藏和 headed E2E 都设置 `backgroundThrottling: false`。headed 开关只改变可见性，
  不产生第二套计时环境。
- harness 环境 allowlist 只新增 `LODY_E2E_SHOW_WINDOW`。其他继承的 Lody 变量仍不能
  进入隔离的场景进程。
- Cucumber 继续串行执行。隐藏窗口解决桌面干扰，但不解决当前阻碍并行运行的固定操作
  系统 endpoint。

这项决定补充[五条旅程矩阵](2026-09-12-desktop-e2e-user-journey-expansion.zh.md)，不改变
旅程交互契约或公开产品意图，因此无需修改 Spec。

## 证据与限制

纯窗口策略测试覆盖普通模式、隐藏 E2E、headed E2E 和打包应用行为。harness 环境测试
证明 headed 开关可以穿过隔离边界，同时不会放行无关变量。每次 harness 启动还会在
renderer 第一帧后读取真实 `BrowserWindow` 状态；只有可见性符合请求模式且 background
throttling 已关闭时才能继续。真实 Electron 验证通过了四条隐藏 smoke 场景及其 28 个步骤，
以及 21 条隐藏场景及其 223 个步骤。一条包含六个步骤的 headed 场景也通过，证明显式显示
开关不会改变计时策略。
