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

## 历史导入后续工作（2026-09-25）

历史同步报错 "does not advertise sessionCapabilities.list"：适配器只实现了 resume。
[LodyAI/acp-extension-pi#4](https://github.com/LodyAI/acp-extension-pi/pull/4) 通过 Pi 自带的只读
`SessionManager` 实现 `session/list`，`session/load` 则是 resume 之后按 `get_entries` 回放当前分支。
选用标准 ACP load 而非 Codex 的 `_lody/session/history/read`，因为导入器无需按 Provider 分支即可消费它。
声明 load 会让普通对话恢复回放整个会话，因此宿主对内置 Pi 与 Kimi 一样优先 resume。
回放丢弃 resume 时的清单快照，改为在原位置发出每次待办快照；若在末尾追加当前清单，它会在
轮次之间移动，破坏之后同步的前缀匹配。发布仍需新的运行时产物。

对抗性评审后适配器新增两条规则：会话文件不存在时 resume/load 失败，因为 Pi 会把它静默打开为
新的空会话；用户图片随回放发出，由导入器计为丢弃，从而阻止有损的冲突替换。列举可能在 Pi 存储中
留下空的按 cwd 目录：避免它需要复制 Pi 未导出的目录编码，一旦漂移会静默列出空结果。继续过或处于执行中途的会话再次同步仍可能冲突：只存在于 Lody 的内容（附件、任务
卡片、重试/压缩活动）不在 Pi 文件中。这是共享导入器的前缀模型所致，并非 Pi 适配器缺陷，留待单独处理。

[#972](https://github.com/LodyAI/Lody/issues/972)（导入的 Pi 会话没有模型选项，且丢失原模型）在所有
Provider 上是同一个根因：导入创建了可继续的会话，却跳过了 Lody 自己启动的会话在运行中记录的两项事实，
即 Provider（`agentConfigId`）和原生设置（`acpRuntimeConfig`），而列举和 `session/load` 本来已拿到这两项。
现在新导入通过该机器上唯一的同类型 Provider 列举、加载并绑定。没有或有多个时保持未绑定，因为猜测可能
把原生会话换到另一个账号或端点。会话必须用继续对话时的启动方式加载，否则 `CODEX_HOME` 这类 Provider
自设的数据目录会让刷新和继续对话指向不同的存储。因此刷新按会话自己的绑定加载，而不是当前唯一的 Provider；
之前未绑定的导入只有被该 Provider 列出时才绑定。这两处缺口是对抗性评审在第一版中发现的。每次导入写入（含刷新）都通过 `applyAcpRuntimeConfigPatch` 把
load 报告的设置记到最后一条导入用户消息上，它的 fence 保留更新的 Lody 消息的选择；刷新也必须写，因为
追加轮次会使旧选择失效。未改变：Codex 的只读历史不报告设置；没有运行时选择的输入框仍会发送猜测的默认值。

## 验证限制

Landing 按各 Provider 所属机器的 `builtinPi` 能力筛选旧 Provider。
卡片数量、显示条件和确认后的写入循环使用同一可迁移子集，避免旧机器阻塞其他机器。
不支持迁移的 Provider 保持不变，等所属机器更新后再确认迁移。没有可迁移 Provider 时，
隐藏卡片及其原本为空的提示容器；支持迁移的 Provider 仍保留进行中和重试反馈。

定向启动、迁移、认证和协议测试覆盖本地行为。打包 smoke 使用官方 CLI 连接本地模拟
模型，不证明商业模型效果，也不能替代在 Windows 上验证运行时。
