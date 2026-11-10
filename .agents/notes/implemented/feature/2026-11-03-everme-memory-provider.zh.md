# EverMe：按账号划分的记忆 Provider

Status: implemented
Translation: current

[English](2026-11-03-everme-memory-provider.md)

## 摘要

Nowledge Mem 为每个 Role 提供独立的记忆身份，由 Lody 在 ACP 进程启动时注入。EverMe 则是
一个账号一份记忆，Agent 通过 EverCLI 写入其自身配置的 hooks 或 MCP 服务访问这份记忆。因此
Lody 把 EverMe 作为“连接 Agent”而不是“由 Role 绑定”的 Provider 接入，并且只接受来自这台机器
自身的设置请求。代价是连接保存在 Agent 的全局配置中，在 Lody 之外同样生效。

## 决策

- **一个账号一份记忆。** 适配器不列出身份，拒绝创建和更新，Role 没有可引用的对象。
- **按 Agent 连接，不按 Role 绑定。** 设置页根据这台机器上 Lody 的 Agent 配置生成列表，并
  映射到 EverCLI 的平台；连接和断开执行 `evercli plugin install|uninstall`。Role 的记忆
  选择器不显示 EverMe，ACP 启动时也不为它注入环境变量。
- **只能在这台机器上设置。** 设备码授权会把机器绑定到完成授权的人，来自其他成员设备的请求可能让
  这台机器的对话进入对方账号。设置页只向当前这台机器发送 EverMe 请求，Daemon 也会拒绝经工作区中转
  和加密功能通道到达的此类请求，两端共用同一个判断 `isLocalOnlyMemoryProvider`。

只在设置页限制“仅限这台机器”的方案被否决：无论页面显示什么，中转通道都能直接到达 Daemon。

## 影响

读取独立配置目录的 Agent（例如 Codex 账号配置）看不到在默认目录中建立的连接。运行中的会话
要等 Agent 进程重启后才会加载新连接。

## 验证

`packages/components/tests/memory-setting.test.tsx` 覆盖 Nowledge Mem 在新布局下的设置页
状态，以及 EverMe 登录在短暂错误后继续等待、最终批准或过期的行为。
`apps/cli/src/lib/memory-providers.test.ts` 覆盖包含前置检查的连接和断开时间预算。
这些测试没有验证真实 EverCLI 登录和中转拒绝。
