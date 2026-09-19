# 桌面多窗口预热

Status: implemented
Translation: current

[English](2026-09-18-desktop-window-prewarming.md)

## 摘要

此前每次多窗口开窗都会完整冷启动一个渲染器，新窗口要等 bundle 解析、
Provider 和鉴权完成后才显示内容，并可能出现空白或错误帧。Developer mode 可以让
桌面端常驻一个隐藏的辅助渲染器，停在中性路由；开窗时直接占用这个备用窗口，通过
IPC 绑定目标并做客户端导航，立即显示后立刻再预热一个替补。该选项默认关闭，普通
路径仍是冷启动兜底。备用窗口预热的是应用外壳和共享 Provider，不是某个工作区的
数据，代价是多一个隐藏渲染器进程。它建立在既有的桌面多窗口决策
之上（[说明](../../proposed/feature/2026-09-10-desktop-windows.zh.md)、
[Spec](../../../../specs/desktop-windows.zh.md)）。

## 决策

- 备用窗口是真实产品窗口（启动需要产品 IPC），但会被标记为预热：它不会成为
  主窗口兜底、不计入用户可见窗口；最后一个真实窗口关闭时被销毁；启动时的
  清缓存逻辑会跳过它，避免它抢先消费为可见窗口准备的清理指令。
- `window-warm-pool.ts` 维护单槽状态机（`idle`/`warming`/`ready`）。渲染器
  commit 后发送 `app.windowReady`，主进程据此把备用窗口提升为 ready。30 秒
  超时会丢弃始终未就绪的备用窗口，避免崩溃或恢复页长期占槽。
- 备用窗口停在 `/?window=workspace&warm=1`。首页路由对它渲染中性占位页，
  不跳进工作区，因此绑定时不会闪现其他界面的内容，也不会在目标确定前启动
  工作区后台工作。
- 占用时主进程发送 `app.windowTarget` 并显示窗口。渲染器按新建辅助窗口从 URL
  推导的逻辑补齐存储标记，会话目标额外收起侧栏，然后做客户端导航。沿用同一个
  “新窗口” 路由和输入框焦点交接，不另写一套。
- 只有在「设置 > 关于」中展开 Developer mode 后才会显示这个开关。关闭时会销毁
  隐藏备用窗口；它只在当前进程内生效，应用重启后恢复关闭。
- `LODY_E2E` 下禁用预热（E2E 会统计并检查窗口），也可用
  `LODY_DISABLE_WINDOW_WARMUP=1` 关闭。任何失败都回退到原有冷启动窗口。

## 考虑过的其他方案

- 仿照 Cradle-app 的 `tearoff.html` 增加独立预热入口。暂不采用：会多一个渲染器
  入口和骨架页要维护，而相对本方案已有的中性路由，收益提升有限。
- 备用窗口直接停在工作区默认路由。不采用：占用时会先显示该工作区再导航，而且
  目标尚未确定就启动了它的后台工作。
- 复用窗口但重新加载目标 URL。不采用：重载保留了这套机制本就要消除的冷启动成本。

## 验证与限制

- `window-warm-pool.test.mjs` 覆盖单槽状态转换、重复信号、失效备用窗口和
  一次性占用。
- `@lody/shared`、Electron 主进程/preload/渲染器项目、`@lody/components`
  的类型检查通过。
- 一次新的 Electron/CDP 验收确认：开关打开前只有一个 renderer 且没有隐藏 spare；
  打开后为 `phase=ready`、1 个 spare，隐藏 spare working set 为 200,523,776 bytes；
  再次关闭后回到 `phase=disabled`、0 个 spare。E2E 中仍禁用预热，只覆盖冷启动路径。
- 备用窗口只预热应用外壳、路由、i18n 和根 Provider，不会预初始化工作区
  runtime 及其数据，因此第一个绑定窗口仍需加载自身路由数据。
