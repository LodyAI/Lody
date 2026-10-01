# Once 计划使用统一机器时钟

Status: implemented
Translation: current

[English](2026-10-01-schedule-once-clock.md)

PR: https://github.com/LodyAI/Lody/pull/1197

## 摘要

Once 输入按目标机器的墙上时间转换为绝对时刻，预览和摘要却按查看者时区
显示该时刻。Once 切回日历规则时也复制了查看者的小时和分钟，改变了预期
执行时间。显示和转换现在显式接收机器时钟，持久化仍保留 Once 的绝对时刻。
DST 输入在跳时区间向前解析，重叠时间选择第一次；验证使用隔离 fixture，
不创建生产计划。

## 决策与证据

本项修复了[机器拥有计划的决策](../feature/2026-09-24-machine-owned-scheduled-tasks.zh.md)
在实现中的缺口。[时间 Spec](../../../../specs/schedule-time.zh.md) 以 draft 状态
记录完整的输入、切换、持久化和执行契约。

main `7d502f3d99fdcdbbdd43d032c6d903d4ed497e04` 中，`triggerTimeZone` 和
`describeRecurrence` 对 Once 使用设备时区，datetime 输入则使用机器时区。
`timeOfDayOf` 在离开 Once 时使用 Date 的本地时间 getter。两轮偏移转换在
春季 DST 跳时边界振荡，返回较早的墙上时间，与声明的向前策略不符。

编辑器向预览格式化和类型转换传入目标时区。列表上下文将机器时区元数据
传给周期说明和下次执行时间，提案摘要使用已解析的机器时区。Once 摘要
明确标注时区。每周、每月的默认值使用该时钟的当前日历日期。DST 转换在
本地日期两侧采样偏移，重叠时选最早的精确候选，跳时时选较晚候选。

```text
机器本地输入 → Once 绝对时刻 → Schedule 文档 / Registry
                       ├→ 机器本地预览与摘要
                       └→ 引擎到期槽 / 隔离 SQLite ledger
```

切机器时保留 Once 墙上时间会重新安排已有绝对时刻。保留绝对时刻并重新
显示符合现有存储契约，避免迁移。周期规则在目标变化时保留墙上时间。
进入 Once 时沿用当前时间加一小时的初始值。不替换持久化 schema 或执行策略。

## 验证与限制

现有测试覆盖查看者与机器时区相同或不同、日期边界、输入与预览和保存结果、
切换机器、重新打开表单、Once/日历/Manual 切换、DST 跳时和重叠、
未修改的第二次重叠时刻、Loro snapshot 恢复后的 Registry 指纹稳定性和
引擎 ledger 时间槽。回放 main 的表单和转换代码得到七个预期回归失败。
最终相关测试通过 84 项；UI/shared 套件把查看者时区从新加坡换成洛杉矶后，
复跑的 72 项也全部通过。

在基线 `93545f01b69cb0c98ddd3f19d46540decd95a007` 上，
`NODE_OPTIONS=--no-experimental-webstorage NODE_ENV=test pnpm run check` 通过，
包括 components 4,601 项、shared 1,269 项、CLI 3,298 项，以及 Electron
和其他工作区测试。现有 CLI/RPC 套件跳过七项。Node 26.10 默认的全局
Web Storage 导致无关的 boot-shell 存储 fixture 失败；仅对检查进程关闭
该实验功能后，其 19 项测试通过，没有修改产品代码。
`pnpm run format`、定向 Oxfmt 验证和 `pnpm run docs check --base origin/main` 通过。

没有从真实账号或捕获的对话重建原始生产时间差。10 月 1 日洛杉矶与新加坡
fixture 的偏移为 15 小时，仅凭报告中的 9 小时差异无法确定生产浏览器时区
或已保存时间戳。机器查询只确认了可用性和 Schedule 协议能力。
没有创建生产任务；打包桌面与真实 Provider 执行仍未验证。
