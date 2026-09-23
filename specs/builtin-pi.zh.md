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

Registry 生成时排除 `pi-acp`，不再提供新建入口，已有 registry Provider
继续可用。同一机器存在旧 Pi Provider 时，启动不得自动创建 builtin Pi。
chat landing 动作只在用户当前选中的机器上新增独立的 `builtin/pi` Provider，
并保持旧 Provider 的身份、启动配置、环境变量和既有 Session 绑定不变。
稳定的内置 Provider ID 使重试保持幂等；若该机器已有内置 Pi，不得重复创建
或改变当前默认选择。内置 Provider 不继承自管 Provider 的环境变量。
daemon 仅在 Node 版本和平台满足固定运行时要求时
声明 `builtinPi`，不兼容的机器不得允许新增。仅当当前选中机器存在旧 Provider、
声明该能力且尚无内置 Pi 时显示 landing 卡片。其他机器和不支持的机器保持不变。
新增开始后，卡片可以保留按钮禁用的进行中反馈。

独立 Provider ID 只隔离接入设置，不会自动隔离 Pi profile。需要独立 profile 时，
用户可在其中一个 Provider 上设置 `PI_CODING_AGENT_DIR`；Lody 不移动凭据或配置文件，
独立 profile 可能需要重新配置认证和模型。内置 Pi 仍不能恢复旧 `pi-acp` ID，已有对话历史不被改写。

## 实现依据

- `packages/shared/src/pi-provider-migration.ts`
- `packages/components/src/components/chat/pi-provider-migration-card.tsx`
- `apps/cli/src/agent/setting.ts`
- `scripts/package-pi-runtime.mjs`
