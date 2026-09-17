# Chat follow-up 沿用目标 Session 上一轮 run config

Status: implemented
Translation: current

[English](2026-09-17-chat-follow-up-inherits-target-run-config.md)

## 摘要

向已有 Session 追加 follow-up（`lody_session_chat`、未带 `--model`/`--mode` 的 CLI `session chat`、
以及 review 自动化 chat）时，新的 user turn 不带模型，内置 agent 还会被写入内置默认 mode。
composer 把这轮空配置当成最新偏好，于是掉回目录默认模型。现在：follow-up 若不填 mode、模型或
config option，就从目标 Session 最近一次记录了模型的 user turn 复制这些字段。显式覆盖仍然生效；
能力目录不再提供的继承值会被丢掉。

## 问题

`sendSessionChatResult` 不读目标 Session 的历史。MCP chat 没有模型参数，因此传入空 dispatch
config。新 turn 的 `inputConfig` 没有 `modelId`，`withBuiltinDefaultTurnMode` 再填上默认 mode。
会话配置对模型不像 Role 那样 sticky，所以界面和之后被回收再 `session/new` 的 ACP 进程都会看到
目录默认模型，而不是用户已经在该 Session 选过的模型。

`ResolvedTurnDispatchConfig.runConfig` 上的注释声称 follow-up「沿用创建时的设置」。那只是愿望：
chat 路径既没有复制创建轮配置，也没有复制最近一次选择。

## 决策

继承来自目标 Session，不是请求方。来源是最近一条记录了 `modelId` 的匹配 user turn；若没有，
则退回最近一条匹配 turn 的 mode/options。之前那条没有模型的 follow-up 不得盖住更早选过的模型。
CLI `--model`/`--mode`/`--config-option` 仍校验并优先。当前能力不再提供的继承选择器直接丢弃，
而不是让 follow-up 失败。内置默认 mode 只在请求和继承 turn 都没有 mode 时补上。

`taskToolsEnabled` 仍是 MCP 路径上的请求方冻结：父会话会显式传入，因此不从子会话读取。语义
`runConfig` 仍然只用于创建。

## 备选

复制请求方的模型会把父会话的模型套到可能使用不同 agent 的子会话上。要求 MCP 调用方传入
`modelId` 救不了已有 coordinator，CLI 不带 flag 的 chat 也仍是错的。指望仍活着的 ACP 进程记住
模型，在空闲回收后会失败，而且 composer 仍然是空的。

## 验证

单元测试覆盖历史回溯（跳过 assistant 和其他 agent、优先最近一次记录的模型、退回仅有 mode 的
turn）以及合并（省略字段继承、显式模型保留继承的 mode/options、不兼容的继承模型/mode 被丢弃、
内置默认 mode 只填空 mode）。本次不包含真实的父到子 MCP chat。
