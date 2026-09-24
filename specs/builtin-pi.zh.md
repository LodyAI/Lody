# 内置 Pi Provider

Status: draft
Translation: current

[English](builtin-pi.md)

用户可以选择内置 Pi Provider。Lody 下载带校验和的运行时，其中包含固定版本的
公开 ACP 适配器及锁定的官方 Pi 依赖。适配器是独立 submodule，不进入桌面依赖图。
Windows 原生模块必须来自同一提交的成功构建。凭据继续由执行机器或已有 Provider
环境变量管理。

重新打包可能保留源码版本号，但改变制品校验信息。此类缓存不得阻断 daemon
启动，也不得作为当前运行时启动；通过正常校验流程重新安装。格式非法的元数据
仍然报错。

启动缓存清理和后台更新扫描按运行时隔离错误：记录警告，跳过失败项并继续
处理其他运行时。缓存错误不得导致 daemon 启动失败；实际启动和安装仍严格校验。

Registry 生成时排除 `pi-acp`，不再提供新建入口。已有 registry Provider 在其所有者
明确确认 chat landing 卡片之前仍可启动。同一机器存在旧 Pi Provider 时，启动不得自动
创建 builtin Pi；确认迁移后复用相同 ID 的 builtin 行。
daemon 仅在 Node 版本和平台满足固定运行时要求时
声明 `builtinPi`，不兼容的机器不得允许迁移。迁移要求目标 daemon 声明 `builtinPi` v1，
在原 Provider 行上改为 `builtin/pi`，保留 ID、机器、名称、环境、提示词及其他字段。
已删除或已切换类型的行不会被恢复或覆盖。部分失败可以重试，已完成的行不会重复迁移。
只要至少一个待迁移 Provider 所属机器声明上述能力，landing 就显示升级卡片。
确认时只迁移支持升级的机器上的 Provider；其他机器不阻塞迁移，其 Provider 保持不变，
等机器支持升级后再次确认迁移。没有可迁移 Provider 时隐藏卡片。
迁移开始后，卡片可以保留按钮禁用的进行中反馈。

这是 Provider 迁移，不是原生会话转换。新适配器接受 Pi 原生 JSONL 路径，不能恢复
旧 `pi-acp` ID。确认卡片要求升级后新建对话，已有对话历史不被改写。

## 用户选择的扩展

在声明 `piExtensions` v1 的机器上，用户可扫描默认或已保存 Provider 的 Pi 全局配置目录，
显式勾选已安装的扩展，也可手填绝对路径或 `~/` 路径。扫描复用 Pi 的包解析器读取配置和
manifest，不加载代码、不安装包、不读取项目配置。新发现的候选默认不勾选，重新扫描不改变
已有选择。界面显示实际扫描目录，因为未保存的环境变量编辑不会影响扫描。

Provider 的 `runtimeOverrides.piExtensions` 是唯一持久选择。显式测试和会话启动通过 `-e`
传入这些路径，保留 `--no-extensions`。原生子代理继承同一列表，以便使用扩展注册的模型。
这意味着同意扩展以用户权限执行代码，不是沙箱，也不承诺任意插件或 TUI 兼容性。路径不存在
或加载失败不得静默成功。修改或清空选择使对应模型目录缓存失效，不热更新已运行的进程。

扫描 RPC 只接受可选的已保存 Pi Provider ID，不接受调用方提供的启动参数或环境变量。
本地路由失败不得回退到云端。只有校验清单声明 `piExtensionsProtocolVersion: 1` 且主机兼容时，
daemon 才声明支持。启用扩展的启动必须使用该固定运行时，不回退到旧缓存版本。当前固定产物
尚不支持此协议；启用界面前，需要发布包含同一源码提交所构建 Windows 模块的新产物。

## 实现依据

- `packages/shared/src/pi-provider-migration.ts`
- `packages/components/src/components/chat/pi-provider-migration-card.tsx`
- `apps/cli/src/agent/setting.ts`
- `scripts/package-pi-runtime.mjs`
