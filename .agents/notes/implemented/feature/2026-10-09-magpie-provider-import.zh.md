# 确认后导入本地 Magpie Provider

Status: implemented
Translation: current
PR: [#1357](https://github.com/LodyAI/Lody/pull/1357)

[English](2026-10-09-magpie-provider-import.md)

## 摘要

Lody 已能连接自定义网关，但缺少 Magpie 应用导入入口和运行时模型目录准备。
版本化的本地链接现在会暂存请求并展示全局 checkbox 对话框，确认后通过现有
Machine Flock 路径创建选中的内置 Provider。daemon 根据 Magpie 实时目录准备
Claude、Codex、Pi 和 DSH，不改动用户的原生配置。本次完成 Lody 接收端，Magpie
应用列表适配仍需独立实现，真实供应商完整会话验收尚未完成。

## 决策与职责

[Spec](../../../../specs/magpie-provider-import.zh.md) 定义公开数据、本机限制、命名
和生命周期。采用 Cindy 式交接，使确认、持久化和运行时准备由 Lody 自己负责。
没有采用 Magpie 对 T3 Code JSON 配置的直接编辑方式，因为直接写 Lody 存储会
绕过这些职责。

只接受 Magpie 本机公开归属 token `magpie-lody`。这不是通用 API Key 导入，供应商
密钥仍由本地网关保管。Provider env 保存 Agent 使用的固定映射；网关地址放在独立元数据字段，启动
准备在 `getLodyDataDir()` 下生成配置。Codex 使用独立 home 和现有 adapter 启动
覆盖契约：模型目录必须在原生 `model/list` 前生效，不能仅在随后创建会话时覆盖。
Pi 使用隔离配置，不改动用户的 `models.json`；代价是不会隐式继承原生全局 Pi
设置或扩展。

网关专属能力来源后缀避免把默认原生目录误当成导入 Provider 的目录。刷新和后续
启动重新读取网关，正在运行的会话保持原来的快照。托管运行时复用后台准备；非托管
DSH 直接写配置，启动时发现端点。因此导入完成表示配置持久化，不代表上游推理成功。

内部网关开关现已移到独立的 `AgentConfigMeta.magpieGatewayUrl` 字段，环境变量只保留
Agent 实际使用的配置。存储、恢复、分叉、能力探测与缓存标识均传递该元数据；未发布
草稿中的环境变量开关已删除，不保留旧开关回退。

## 证据与验证

- 检查了 Magpie 提交 `62b1c995ffaebb223ad040b4c54ebabab0078c7a`：
  [Cindy adapter](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/internal/agent/cindy.go)、
  [T3 Code adapter](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/internal/agent/t3code.go)、
  [接入契约](https://github.com/yetone/magpie/blob/62b1c995ffaebb223ad040b4c54ebabab0078c7a/docs/integrating.md)。
- 确定性测试覆盖数据边界、勾选目标、本机写入、部分失败重试、运行时目录生成、
  无效和超大响应、全局对话框选择与异步提交、桌面路由。
- 隔离的合成目录冒烟使用本机安装的 Codex 0.159.2 `app-server` 和固定版本 Pi：
  原生 `model/list`、`--list-models` 均接受并列出生成的合成模型，没有付费模型调用。
- `pnpm check`（完整测试、类型检查、lint、i18n 与边界检查）、`pnpm format`
  和 `pnpm docs check` 均通过。测试使用原生 Git：
  `env -u GIT_EXEC_PATH PATH="/usr/bin:$PATH" pnpm check`，避免编写会话注入的
  Git shim 干扰合成的递归克隆测试。
- 另外通过 ACP 验证了当前 manifest 固定的已安装成品
  `acp-extension-pi 0.2.0-lody.693d6964a676`：对本机合成网关运行
  `prepareMagpieRuntime`，`session/new` 列出两个模型，
  `session/set_config_option` 切到第二个模型，`session/prompt` 使用公开 token
  请求 `/v1/chat/completions`。原生 `read` 工具读取合成文件并回传结果，回合以
  `end_turn` 完成。这验证了适配器链路，不代表商业模型推理验收。
- 尚待验收：四种 Agent 的真实 Magpie 对话和工具调用，各 OS 打包后的冷暖启动，
  以及独立的 Magpie 上游适配器。测试不声称这些已经执行。
