# 托管 Pi ACP 与确认式 Provider 迁移

Status: implemented
Translation: current

[English](2026-09-17-builtin-pi.md)

## 摘要

Pi 原先仅作为 registry 适配器出现。现在内置 Provider 通过托管运行时使用独立、固定
提交的适配器 submodule，包含官方 Pi CLI 及同一提交成功 CI 产出的 Windows 模块。
Landing 卡片只在所有者确认且目标 daemon 能力匹配后升级已有 Provider 行。
旧原生会话 ID 无法转换，卡片说明需要新建对话，同时保留旧启动入口。

## 决策

复用现有托管下载、缓存和更新路径，通过 Node 包归档交付，不将 Pi 依赖打进桌面。
独立冻结安装包含所有支持平台的可选依赖，移除含构建机路径和时间戳的安装元数据，
验证归档字节可重复，并对打包后的完整依赖运行适配器的本地模型 smoke。

迁移在 `flockRowUpdate` 内仅修改 Provider 身份字段，保留事务可见的并发设置修改。
不增加工作区 meta 标记，不改写历史。认证仍由执行机器管理，Pi 没有内置交互登录方法。
daemon 按实际 Node 版本和平台计算 `builtinPi`，不使用共享静态能力声明，避免旧版
Node 上的 CLI 将配置迁移成无法启动的运行时。
内置 Provider 自动注册在目标机器完成同步后先检查旧 Pi，再检查 builtin Pi，避免确认
迁移前创建第二个持久 Provider；不影响其他机器或其他内置 Provider。
详见[草案 Spec](../../../../specs/builtin-pi.zh.md)。

## 验证限制

定向启动、迁移、认证和协议测试覆盖本地行为。打包 smoke 使用官方 CLI 连接本地模拟
模型，不证明商业模型效果，也不能替代在 Windows 上验证运行时。
