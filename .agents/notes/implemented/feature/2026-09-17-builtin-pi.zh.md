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

## 扩展后续工作（2026-09-20）

[#780](https://github.com/LodyAI/Lody/issues/780#issuecomment-5712334027) 已确认显式扩展
与全局扫描方向。后续工作不改变原迁移逻辑，复用 Pi 的只读包解析器而非复制其包布局。
发现不等于授权；所选路径仅存于 Provider 的运行时覆盖字段，并传递给原生子代理。
能力刷新和启动配置归一化必须保留数组，清空列表也必须使旧插件模型目录失效。

源码实现和模拟测试不代表运行时已发布。发布仍需带校验和、包含同一提交 Windows CI
模块的产物；旧 manifest 故意不声明扩展能力。具体契约见更新后的草案 Spec。
不引入新的执行器、配置目录副本或插件沙箱。

## 验证限制

Landing 按各 Provider 所属机器的 `builtinPi` 能力筛选旧 Provider。
卡片数量、显示条件和确认后的写入循环使用同一可迁移子集，避免旧机器阻塞其他机器。
不支持迁移的 Provider 保持不变，等所属机器更新后再确认迁移。没有可迁移 Provider 时，
隐藏卡片及其原本为空的提示容器；支持迁移的 Provider 仍保留进行中和重试反馈。

定向启动、迁移、认证和协议测试覆盖本地行为。打包 smoke 使用官方 CLI 连接本地模拟
模型，不证明商业模型效果，也不能替代在 Windows 上验证运行时。
