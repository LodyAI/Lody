# Roost 历史的 feature gate

Status: proposed
Type: feature
Translation: current
PR: [#1329](https://github.com/LodyAI/Lody/pull/1329)

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

CLI 固定使用 npm 发布的 `@loro-dev/roost@0.1.2`，锁文件记录 registry 校验值，不再依赖
相邻源码目录。七天发布等待规则仅对这个固定版本开放例外。CLI 通过包的 ESM 导出解析
Node client；Electron 优先从 CLI 安装的包复制 client，再考虑相邻开发检出。原生 owner
二进制仍是单独的构建产物。

## 验证

session-actions 契约测试覆盖两个开关：只有两个开关都打开时才选择 Roost，总开关关闭时仍
保持 Loro 默认值。设置 Storybook 覆盖关闭、记住 opt-in 和开启三种状态。

没有相邻 Roost 源码树的独立检出通过了 `pnpm install --frozen-lockfile`、全仓库类型检查
和 lint。发布包 API 与 Node client 的导入正常。使用合成 owner 文件验证了 darwin、linux、
win32 的 x64 与 arm64 client 复制和文件选择；这不代表验证过原生二进制。完整桌面打包
仍需提供目标 owner 构建产物。

完整 `pnpm check` 在 CLI 测试阶段停止：3514 个通过、4 个失败、7 个跳过。三个 runtime-config
断言仍将已返回 `Promise<boolean>` 的 `applyAcpRuntimeConfigPatch` 当作同步布尔值；machine
registration 的预期 capabilities 缺少 `sessionHistory: 2`。这次 npm 依赖更新没有处理这些
feature 测试契约不一致。
