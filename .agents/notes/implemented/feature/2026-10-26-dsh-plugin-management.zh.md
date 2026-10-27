# DSH Provider 插件管理

Status: implemented
Translation: current

[English](2026-10-26-dsh-plugin-management.md)

## 摘要

此前 Lody 启动时会替换 DSH profile 清单与包管理配置，导致原生 CLI 安装的插件注册丢失。
现在启动只协调 Lody 的基础层与生成的 host bundle，保留用户依赖、bundle 顺序、包管理字段、
锁文件、workspace 配置及 YAML patch。已保存的 DSH Provider 通过能力协商后的 Machine RPC
提供注册表插件安装、列表、升级和卸载。设置界面提供安装、列表和卸载；因尚未检测可用新版本，
按用户要求暂不显示升级按钮，保留 RPC 升级能力。本次不改 Skill。

## 所有权与执行

持久化 Provider 必须属于执行机器且类型为 builtin DeepSeek。请求只携带 Provider ID 和
有界的注册表包名，不接受启动参数、路径、环境变量或替代 home。接口禁止修改固定运行时包及
Lody host bundle。本机设置通过本地 Machine RPC 修改插件；远程 workspace 传输仅允许列表读取。
共享工作区流无法认证机器所有者身份，因此服务端在调用 Provider 服务前拒绝安装、升级和卸载。
客户端同样拒绝远程修改，界面提示在所属机器的 Lody 中操作。包名校验和安装环境凭据隔离
不能授权插件后续使用 Provider 凭据执行代码。
`dshPlugins: 1` 同时控制路由和界面；新 Provider 必须先保存，离线机器不启用操作。

现有固定版本 npx/Node 启动器运行 `dsh plugin --profile lody-acp`，插件操作额外在同一
运行环境中提供 pnpm 10.20.0。原生包管理器负责 bundle 发现、兼容性检查及激活。普通包显示为
已安装但未启用的 bundle。启动复用登录 shell 的 PATH，再按白名单筛选环境；安装不传递 Provider API 凭据。界面只发送用户明确操作，完成后提示
重新连接；不替换活动 ACP 连接，也不自动刷新能力。

启动与包操作共享以 Provider home 为键的跨进程文件锁。锁覆盖生成 bundle 发布及清单协调，
或整个包操作及结果读取；不同 Provider 独立。清单格式错误会报错，不重置用户内容。
最终 host guard 继续维持 ACP、历史路径及关闭产品遥测的边界。

新增包操作通过原生 Effect 组合已有 FileLocks 和进程服务，由 SessionExecutionService 在已有
Legacy 文件锁边界执行。Promise 启动准备位于该原生单元之外；不宣称迁移既有启动器或会话执行
所有者。进程有 240 秒截止时间及有界输出，类型化失败恢复和释放锁之前先完成进程清理。
关闭界面不取消已接受的操作。RPC 等待另有上限；传输结果不确定时先刷新再重试。
保留原生进程释放缺陷，不将其当作清理成功。

普通进程失败时，在同一锁内恢复操作前的清单与锁文件。这保护配置，但不是 node_modules 的
事务快照；部分完成的包操作可能需要重试修复。安装诊断留在所属机器 profile 的
`.plugin-manager/logs` 中，响应不保留原始 npm 输出。直接运行外部 `dsh plugin` 使用上游的
另一把锁，因此在界面之外管理此 profile 前应停止 Lody。

## 证据与限制

行为测试覆盖并发启动及适配器升级后清单、workspace 和锁文件保留，损坏配置，包写入互斥，
安装、升级及卸载结果，失败写入恢复，严格 RPC 输入，远程只读分发、拒绝远程修改并保持列表不变，以及界面成功与失败状态。
沿用现有 Provider 和 Machine RPC 测试作为所属覆盖。macOS 上固定 DSH 0.2.1-rc.2 的真实冒烟已验证合成 bundle 的原生安装、自动注册和卸载，
并确认原有 host 层保留；未使用 API 凭据或模型请求，不作为依赖网络的单元测试。
Windows 和打包 Electron 的安装仍需平台冒烟验证。

合入 main 并限制远程操作后，`pnpm check` 通过类型与 lint 阶段，617 个组件测试文件全部通过。
CLI 通过 334 个文件、跳过 1 个；原生 Git 递归子模块测试仍报 `context_unreadable`，
该传输模块不在本次改动范围，不能宣称全量检查通过。
组件定向测试 98 项通过；RPC 测试 161 项通过、3 项跳过。
格式化、静态边界及文档检查通过。
