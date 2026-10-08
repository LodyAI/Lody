# Roost 历史的 feature gate

Status: proposed
Type: feature
Translation: current

[English](2026-10-08-roost-history-feature-gate.md)

## 摘要

Roost 历史通过设置中的 opt-in 开关提供，同时让 Loro 继续作为新会话的安全默认值。
renderer 在接受会话时明确传递 backend 选择，已保存的会话 metadata 保持这个选择不可变，
因此关闭开关不会让已有 Roost 会话改用 Loro 打开。非 renderer 的创建路径无法读取本地
偏好，也统一默认使用 Loro。

## 决策

Experimental features 区域包含一个总开关和一个 Roost history 开关。有效 gate 要求两个
开关都打开。偏好按 renderer 保存在 local storage 中，并在创建会话前读取。

有效 gate 关闭时，新会话不显式选择 Roost，共享创建默认值解析为 Loro。有效 gate 打开时，
renderer 在接受首个 turn 前向新会话 metadata 写入 `historyBackend: 'roost'`。已有持久
discriminator 的会话无论偏好之后如何变化，都继续使用自己保存的 backend。

开关不迁移历史、不重写会话 metadata，也不提供按消息切换 backend 的 fallback。backend 选择
仍然是不可变的会话边界。

## 验证

session-actions 契约测试覆盖两个开关：只有两个开关都打开时才选择 Roost，总开关关闭时仍
保持 Loro 默认值。设置 Storybook 覆盖关闭、记住 opt-in 和开启三种状态。
