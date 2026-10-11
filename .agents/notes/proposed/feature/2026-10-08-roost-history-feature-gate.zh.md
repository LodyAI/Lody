# Roost 历史的 feature gate

Status: proposed
Type: feature
Translation: current
PR: [#1329](https://github.com/LodyAI/Lody/pull/1329), [#1391](https://github.com/LodyAI/Lody/pull/1391)

[English](2026-10-08-roost-history-feature-gate.md)

## 摘要

Roost 历史通过设置中的 opt-in 开关提供，同时让 Loro 继续作为新会话的安全默认值。
renderer 在接受会话时明确传递 backend 选择，已保存的会话 metadata 保持这个选择不可变，
因此关闭开关不会让已有 Roost 会话改用 Loro 打开。非 renderer 的创建路径无法读取本地
偏好，也统一默认使用 Loro。

## 决策

Experimental features 区域包含一个总开关和一个 Roost history 开关。有效 gate 要求两个
开关都打开。偏好按 renderer 保存在 local storage 中，并在创建会话前读取。

有效 gate 关闭时，共享创建默认值解析为 Loro。有效 gate 打开时，renderer 在任何会话
写入之前读取目标机器能力；仅受支持的目标保存 Roost 选择，能力缺失或较旧时为该新会话
保留 Loro。若调用者明确要求 Roost，而目标不支持，则在 metadata、历史和 warm-up 之前
报错。已有 discriminator 的会话无论偏好之后如何变化，都继续使用自己保存的 backend。

开关不迁移历史、不重写会话 metadata，也不提供按消息切换 backend 的 fallback。backend 选择
仍然是不可变的会话边界。

桌面会话 hover 卡片用一行中性的数据库图标与 Roost 或 Loro，展示会话保存的选择，方便
用户识别该对话的历史后端。工作区、按更新时间排列和置顶列表传递相同的 metadata 值；
旧 metadata 缺少 discriminator 时解析为 Loro。卡片接收已有行数据，不订阅设置或加载历史。
显示契约记录在[会话历史写入](../../../../specs/session-history-writes.zh.md)中。

CLI 保留 npm 发布的 `@loro-dev/roost@0.1.2`，锁文件记录 registry 校验值，不再依赖
相邻源码目录。[原生运行时接入](../architecture/2026-10-09-roost-native-runtime.zh.md)
使用已发布的 `@loro-dev/roost-node@0.1.1` 代替另行复制的 owner 可执行文件，并保留此会话开关。
发布等待规则仅豁免浏览器包、原生主包及六个匹配平台包的固定版本。

## 验证

session-actions 契约测试覆盖两个开关：只有两个开关都打开时才选择 Roost，总开关关闭时仍
保持 Loro 默认值。设置 Storybook 覆盖关闭、记住 opt-in 和开启三种状态。

创建回归还覆盖目标能力缺失/较旧、显式 Roost 在副作用前拒绝，以及显式 Loro 覆盖。
renderer 两个创建入口与 CLI 复用同一个能力解析函数。

hover 卡片改动通过 components 类型检查和现有的 23 个列表/hover 测试。Storybook 中的
Chromium 验证覆盖 Roost 与 Loro、中英文、深浅色，以及鼠标悬停行时打开卡片。

原生接入已通过完整工作区检查和实际 macOS arm64 打包，无须另行提供 owner 产物。
它也修正了此前四个过期 CLI 测试：等待异步 runtime-config 写入，并在机器注册预期中包含
`sessionHistory: 2`。运行时及跨平台验证边界记录在上文链接的原生运行时说明中。
