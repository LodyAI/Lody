# Linux 定时任务的时区识别

Status: implemented
Translation: current

[English](2026-10-18-linux-schedule-timezone.md)

PR: https://github.com/LodyAI/Lody/pull/1685

## 摘要

Linux Node 在 `TZ=HKT-8` 或绝对 zoneinfo 路径下，可以正确显示香港本地时间，
但 Intl 不返回默认时区名称。Lody 把缺失名称转成 UTC 并发布为机器时区，导致
本地上午 10 点的任务在香港时间下午 6 点执行。机器注册现在传入环境时区提示，
由共享解析函数恢复地区时区或等价的固定 IANA 时区。缺陷已在 Linux x64 复现；
报告中的 ARM 主机及其确切环境仍未验证，已有任务不会自动迁移。

## 原因与决策

本修复补充了此前的 [Once 时钟修正](2026-10-01-schedule-once-clock.zh.md)。
编辑器已经使用机器元数据，引擎也已经遵守保存的时区。在 `450595e07` 上，
`getDeviceTimeZone()` 使用
`Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'`。
Node 24.22.0 在 `TZ=HKT-8` 下的 Date 时差为 -480 分钟，但 Intl 时区为 undefined。
因此每日规则计算出 `2026-10-18T10:00:00Z`，而非正确的 `02:00:00Z`。
手动创建和继承机器时区的 Agent 提案都会受影响。

已检测到的 Intl 时区仍优先。仅在名称缺失时解释调用者提供的提示：去除可选
POSIX 冒号和标准 zoneinfo 路径前缀，保留地区名称及其夏令时规则，或将固定
整小时时差的 POSIX 格式按相同的反向符号转成 `Etc/GMT`。结果由 Intl 验证。
两处机器注册都传入 `process.env.TZ`；共享和浏览器代码不读取进程全局变量或
文件系统。这是纯转换逻辑变更，不改变 Effect 生命周期或迁移单元。

不根据今天的时差猜测地区，否则可能丢失夏令时规则。不改写已有任务，因为
显式 UTC 时间可能是用户有意指定的。无法识别的提示仍沿用原有 UTC 回退，
包括 Intl 无法命名时的 `/etc/localtime` 等任意路径、非整小时 POSIX 时差和
完整 POSIX 夏令时规则字符串。本补丁不是完整的 POSIX 时区解析器，也不监视
系统时区的实时变化；元数据仍需通过注册刷新。

## 验证与限制

现有 zoned-input 套件覆盖机器本地每日/单次上午 10 点、显式 UTC、香港别名和
POSIX/路径提示，以及纽约冬夏时差保留。在独立临时环境中安装仓库版本的
Croner 10.0.1、Zod 4.3.6、Vitest 5.0.2，并使用锁定的 Core/DSH 源码；复制产品
源码，没有替换调度实现。UTC 和香港环境下 18 项仓库测试通过；包含真实进程
回放在内的全部 19 项在 `TZ=HKT-8` 下也通过。另一个真实进程回放
使用 `TZ=HKT-8`：原函数失败且恰好偏移八小时，修复后通过，验证了 cron 执行
时刻和 Once 时间转换。

嵌套检出没有工作区依赖；已尝试 `pnpm check` 和 `pnpm format`，但因缺少
`tsgo` 和 `oxfmt` 未能完成。定向 Oxfmt 0.65.0 和 diff 空白检查通过。完整 UI、
CLI、类型/构建检查仍未验证，以上证据不代表打包 ARM 验证。当前可读工作区没有报告中的 Linux 任务，因此生产原因
仍需结合后台实际环境和保存的触发器确定。文档检查报告已有的 ACP 子模块链接
目标缺失。
