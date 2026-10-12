# 全局 Streams 诊断日志使用进程级归属

Status: implemented
Translation: current

[English](2026-10-12-streams-diagnostic-log-scope.md)

## 摘要

CLI 只安装一套进程级 console/fetch 拦截器，却在每个工作区连接 Streams 时替换其
logger，导致先前工作区的错误被标成最后连接的工作区。现在每次输出都读取现有根
logger，沿用配置好的日志输出目标，不再猜测工作区归属。这项修复移除误导性标签，
不会补出缺失的文档 ID，也不解决同步失败。

## 证据与决定

[Issue #1469](https://github.com/LodyAI/Lody/issues/1469) 报告了多工作区 daemon 日志的
归属错误。在 `5f13f917` 上，所属文档管理器测试沿生产路径创建并连接合成的 A/B
管理器，再真实调用被拦截的 `console.error`。修复前，同一个 A stream URL 在 B
连接前进入 A logger，之后进入 B logger；HTTP 诊断也进入 B。新增断言在原代码上
失败，改正输出目标后通过。

移除可变的工作区日志目标及安装函数参数，每次输出时调用 `getLogger()`，因此根
logger 后续重新配置后仍沿用当前的文件或混合输出。不能创建独立 logger，也不能
提前缓存可能只有控制台输出的根 logger。保留 debug 级别、前缀、URL 脱敏、只安装
一次的保护、无关 console 透传，以及 fetch 返回值和异常。

固定使用第一个工作区仍会错误归属。偶尔出现的 URL 无法补出 SDK 未提供的工作区或
文档 ID。完整结构化归属需要另行处理 SDK，本补丁仅引用 issue 并保留其开放状态。
已有工作区级 transport 诊断回调继续保留真实上下文。

Effect 功能修复评估保持小范围：这里只改现有拦截器内同步的日志输出目标，不改变
生命周期、重试、资源归属或传输协议，因此不扩展原生生命周期迁移。

## 验证与限制

- 原实现的 A/B 回归失败：同一个 A 事件的实际输出目标先为 `workspace-a`，后为
  `workspace-b`。
- 修复后，文档管理器、logger、日志格式化及脱敏四套测试共 46 项通过，覆盖根 logger 替换、重复
  安装、两类 console 前缀、URL 账号与查询参数脱敏、fetch 返回对象/正文/异常保持
  不变，以及无关 console 输出。
- 仓库、令牌响应、presence transport 及 machine-monitor 连接采用合成替身；真实
  管理器连接和诊断拦截器仍执行。没有使用真实云账号、生产日志或桌面 UI。
