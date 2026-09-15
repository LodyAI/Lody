# 在能力探测前解析 Provider 配置

Status: implemented
Translation: current

[English](2026-09-12-provider-config-probe-race.md)

## 摘要

新建 Provider 对话框既可能对无名称的无效草稿发起探测，也可能在 daemon 的 Machine Flock
副本尚未看到刚创建的有效配置行时就发起探测；两种路径都会显示误导性的
“Provider config not found”。现在 Lody 会在必填名称存在之前禁用所有探测；daemon 首次查询
不到配置时，则先执行一次有时限的 Machine Flock 同步，再重新读取配置。配置确实不存在时仍会
返回原有错误，因此这个恢复过程不会把探测变成无限等待。

## 问题与归属

设置对话框负责草稿有效性，不应派发会被共享配置解析器拒绝的工作。daemon 仍然是探测输入的
权威来源，但 renderer 与 daemon 通过不同副本观察 Machine Flock：renderer 在本地提交配置行，
并不证明 daemon 已经能立即读取它。

Provider 创建流程同时暴露了这两个条件。名称为空时，Create 只通过 tooltip 表达禁用原因，Test
动作仍可触达；即使配置行有效，它也可能在 renderer 提交后的第一次 daemon 查询中暂时不可见。

## 决策

- 将去除首尾空白后的 Provider 名称作为能力探测、自定义命令探测和运行时覆盖探测的共同前置
  条件。必填字段显示可访问的行内错误，不再只依赖已禁用 Create 按钮的 tooltip。
- 保留 daemon 的持久化配置边界。第一次查询失败时，请求一次 Machine Flock 同步，默认超时
  1.5 秒且不安排后台重试，然后重新读取同一配置；只有第二次仍缺失才返回 not-found。

超时可通过 `LODY_PROVIDER_CONFIG_RESOLVE_SYNC_TIMEOUT_MS` 调整，并复用 daemon 其他同步路径
采用的有界超时机制。

## 备选方案与限制

把 renderer 草稿直接随探测发送可以避开副本时序，但会绕过 daemon 的权威配置边界并重复验证。
反复轮询可能遮蔽更长时间的同步故障，也会拖慢每一次真实的 not-found。一次明确同步加重新读取
足以覆盖创建竞态，同时保持持久错误契约不变。

本修改不改变内置 Provider 注册。若 Machine Flock 同步后配置行仍不可见，也不承诺探测成功；
有界尝试结束后仍按原行为返回错误。

## 验证

对话框测试证明名称为空时会显示必填错误、禁用顶部探测，并且既不写配置也不发起探测。daemon
测试从配置不可见开始，在同步过程中令其可见，并证明第二次读取后继续执行能力发现。聚焦的
对话框和 session execution 测试文件均已在本地完整通过。

Issue：[#652](https://github.com/LodyAI/Lody/issues/652)。
