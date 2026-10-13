# 按需刷新 Provider 订阅额度

Status: implemented
Translation: current

[English](2026-10-13-provider-quota-refresh.md)

## 摘要

Composer 和 Agent 设置原先只展示缓存额度，没有主动获取当前值。Lody 现在把 Core 已有的 `rateLimits` 能力投影到 Provider 缓存，在符合条件的界面可见时发起独立查询。daemon 拥有短生命周期 ACP 进程，只初始化和查询，不创建对话。失败或语义含糊的空结果保留原额度；完整快照替换和更新时间仍留待后续实现。

## 契约与职责

Core 已定义 `_lody/rate_limits/get` 和 `{version: 1, query?: true}`，本次不修改 Core、adapter、托管产物或依赖版本。展示要求能力声明；刷新额外要求 `query: true` 和 Machine 协议 `providerRateLimitsRefresh: 1`。仅支持推送的 Provider 可以展示缓存。builtin 的环境变量／品牌覆盖配置和 Codex API-key profile 仍不适用；自定义 ACP Provider 对自己声明的账户语义负责。

共享 UI hook 在 composer／Provider 激活、页面回到前台、popover 打开时刷新。workspace runtime 合并请求，使用已有本地控制或 Machine RPC 路由，随后协调已有 Flock handle。没有轮询、新订阅、猜测百分比或加载遮罩。

RPC 只接受已保存的 config ID 和路由标识。daemon 固定配置，复用既有启动和 profile 凭据解析，依次执行 initialize 与 Core 查询。禁用 terminal、文件系统、权限授予及会话创建。builtin 检查运行时已安装，避免自动安装；自定义／registry 命令保留既有启动器行为。成功返回前终止自有进程。若无法确认清理完成，则隔离该 Provider 直到 daemon 重启，避免反复生成替代进程。

请求按 Provider 和配置指纹共享所有者：成功缓存 15 秒，失败退避 5 秒，限制已完成元数据数量。并发启动沿用 ACP admission。配置变更等待前一个底层操作结束。UI 卸载不会终止共享工作。进程启动后查询超时为 20 秒，总体 signal 为 45 秒。

## 持久化与顺序

推送和查询都使用已有 Provider 额度 writer。推送 revision 阻止较晚返回的查询覆盖新推送；写入前及 Flock 串行 writer 内再次检查配置身份。Provider key 支持自定义 agent 标识往返，legacy key 继续校验 builtin 类型。保持[Provider 隔离决策](../bug-fix/2026-09-30-provider-rate-limit-isolation.zh.md)。

Claude／Kimi v1 adapter 可能把上游失败编码为空快照。因此空查询视为未成功并保留旧行；非空结果只 upsert 返回的 bucket，不删除缺失项。本次不持久化或展示新鲜度时间。严格区分空结果与错误、完整快照替换，需要后续 adapter 契约变更。

## 替代方案与生命周期评估

复用对话连接可避免冷启动，但取消和凭据身份会耦合对话所有权。本次始终拥有独立只读连接。Core 保留公共协议定义，adapter 保留厂商请求，UI 不读取厂商凭据。

Effect feature/fix 评估发现 ACP 启动、启动 gate／transport 和 Loro 协调仍为 Promise 生命周期边界。原生迁移需要尚未完成的依赖，会超出此单元范围。因此 cache 使用小型显式 Promise owner，不宣称完成原生 Effect 迁移。更大范围继续由[迁移路线图](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md)管理。

## 验证范围

确定性测试覆盖无会话 initialize／query、能力声明、并发合并与退避、配置和推送竞态、清理隔离、严格本地路由、Machine RPC 响应、自定义 Provider key 和 UI 能力门控。没有使用真实凭据、额度接口或模型 prompt。

checkout 原有运行时元数据冲突：Codex 0.159.2 对 0.160.1、Claude SDK 0.3.284 对 0.3.293、Grok 1.0.40 对 1.0.46。CLI 行为测试另用临时、仅替换版本元数据的测试夹具运行；生产检查和发布 pin 不变。PR 分别记录正常检查与夹具辅助测试。
