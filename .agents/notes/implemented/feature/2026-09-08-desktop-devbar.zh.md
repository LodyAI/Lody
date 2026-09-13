# 运行时桌面性能条

Status: implemented
Translation: current

PR: [#525](https://github.com/LodyAI/Lody/pull/525)

[English](2026-09-08-desktop-devbar.md)

## 摘要

桌面端性能排查需要在开发版与打包版中都能看到可见的测量值。一个运行时环境开关会启用底部状态条，
展示渲染进程的帧/布局偏移测量，以及 Electron 各进程的 CPU/常驻内存采样。这让诊断能力无需重新
构建、也无需开启遥测即可使用。GPU 进程指标与硬件利用率和显存被显式区分；外部 CLI/agent 进程不计入
总量。

## 决策

在主进程使用 `LODY_DEVBAR=true`，并通过既有的类型化 app IPC 服务暴露配置与快照。构建期的渲染层
开关会要求为生产排查另出一份产物，并与公开构建中经过审计的环境常量发生耦合。布尔开关在各构建
环境中完全一致，默认关闭，并保持本地 composition 不变。目前没有活跃记录拥有该功能；相关的平台
边界仍在[平台契约](../../../../packages/platform/AGENTS.md)中。

渲染层在首次挂载前预留 28 像素，并把状态条置于 router 之外。它测量动画回调与带缓冲的 CLS 会话窗口。
主进程在各窗口之间共享一份限速的按需 Electron 指标采样；它不启动任何定时器。渲染层在隐藏时暂停
轮询，并在卸载时断开各类 observer。首个 CPU 采样以及长时间暂停后的采样在下一个测量间隔之前不可用。
未加入原生 GPU 硬件监控，因为 Electron 的可移植指标报告的是 GPU 进程的 CPU/RSS，而非 GPU 利用率或
显存。GPU 测量共用一个紧凑字段 `GPU xx% xxxM`，进程 CPU/RSS 与 MiB 单位在 hover 时说明。这减少了
重复标签，且不改变采样节奏或测量范围；面向程序员的缩写保持不变。

堆内存在每个可见轮询周期从新取的 Chromium `performance.memory.usedJSHeapSize` 对象采样，显示为
`Heap xxxM`。主进程仅在启用 devbar 时才在 ready 之前打开 `enable-precise-memory-info`，以规避
Chromium 的分桶与长期缓存。这是当前渲染进程的堆估算，不含其他 worker 的堆或整个应用的内存；缺失
或非法读数显示为短横线。本次不引入额外的轮询循环、IPC 面或堆快照。精度选择依据
[Chromium 的实现](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/timing/memory_info.cc)。

## 结果与验证

[Spec](../../../../specs/desktop-devbar.md) 仍为 draft。全部 104 个 Electron 测试通过，覆盖环境
默认值/覆盖、聚合、数据缺失以及 CLS 间隔/时长边界。仓库类型检查、lint 与文档检查通过。一次使用
合成 IPC 测量与假时钟的无头 Chromium 组件冒烟验证了取值、28 像素预留、1280/640 像素视口布局以及
隐藏窗口占位，且无渲染层错误。这是组件级验证，而非打包桌面端启动；跨平台硬件测量仍未验证。Heap
组件冒烟还用注入值与假时钟验证了 64M → 128M 的更新、不可用读数、恢复，以及隐藏时清除读数。

在该环境中运行完整套件需要 `NODE_ENV=test`：继承而来的 `production` 值会禁用 React 的测试 `act`
API。加上该覆盖后，全部 441 个共享 UI 测试文件（3275 个测试）通过。完整 CI 测试命令仍报告未改动的
CLI `gh-shim-script.test.ts` 中子进程退出码断言失败。导入、平台、公开边界与 i18n 检查单独通过。
