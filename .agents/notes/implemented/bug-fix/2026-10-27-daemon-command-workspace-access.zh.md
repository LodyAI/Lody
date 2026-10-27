# Daemon 命令无需工作区发现即可解析工作区

Status: implemented
Translation: current

[English](2026-10-27-daemon-command-workspace-access.md)

## 摘要

运行在 daemon 内的 MCP Session 工具本已使用绑定工作区的副本，却仍要先联网获取当前
登录的全部云端工作区列表，因此发现接口的故障或不兼容会让本机的列表、归档、创建操作
失败。Cloud daemon 命令现在从 Fleet 已维护的访问结论中取得工作区描述：实时访问订阅；
订阅首次应答前，则用启动该运行时的缓存条目。只有确认的撤权或 token 被拒才会拒绝命令。
订阅不可达时保留最后一次授权结论，这与保持运行时本身继续运行的规则一致。独立 CLI 的
`--offline` 会话读取和导出改从当前登录的本地工作区目录解析。

## 问题与证据

`resolveWorkspaceOrThrow` 只识别本地平台的 `SessionCommandEnvironment`。Cloud daemon
的 `withDaemonCommandScope` 只注入 `DaemonWorkspace`，所以每个需要解析工作区的工具都会
先调用 `listWorkspacesForToken`，然后 `withWorkspaceManager` 才借用 daemon 副本。
2026 年 10 月的故障起因是客户端发送了 `includeEncrypted`，而后端拒绝该字段。生产后端
现已接受该字段，但多余的往返仍在：离线、慢网以及以后的发现接口故障都会造成同样的阻断。
`session.ts` 另有一个解析函数，即使在 `--offline` 下也会查询同一列表。

## 决定

- `DaemonWorkspace.readAccess()` 返回 `authorized`（附带摘要）、`revoked`、
  `unauthorized` 或 `unknown`。`LodyFleet.readWorkspaceAccess` 同步应答：
  - token 被拒时报告 `unauthorized`；
  - 其次由最新远端快照应答，快照中缺失即为 `revoked`；
  - 尚无远端快照时，使用启动时的缓存条目；
  - 没有来源覆盖该工作区时，结果为 `unknown`。
- 在 daemon 作用域内，账号和机器必须与 daemon 一致。selector 只能指向 daemon 自己的
  工作区；显式指定其他工作区会被拒绝，绝不替换为当前工作区。`unknown` 回退到原有的
  发现路径，并保留其错误。
- role、内容模式和 genesis hash 只来自服务端快照，或 daemon 依据快照写入的目录，绝不
  拼凑。`createLocalSessionCommandEnvironment` 仍只用于本地。
- 每个操作保留自己的授权检查：机器访问、项目共享、委托访问和 E2EE 路径。这些检查不
  并入列表枚举，也没有新增逐次的云端检查来替代它。
- 独立 CLI 在工作区未知、选择有歧义或选择全部工作区时，保留在线发现。`--offline`
  只在目录身份与登录一致时读取 active 目录条目。登录不同或没有条目时给出明确错误，
  绝不返回空列表。加密目录不可读时其条目缺失，只有可读工作区的精确 id 或 slug 能解析；
  默认、名称或全部工作区的选择会报告缓存错误，而不会静默选中剩下的明文工作区或漏掉
  加密工作区。

## 否决的方案

- 让本地环境同时服务 Cloud：这会赋予 `owner` 角色并套用本地机器规则，属于提权。
- 用逐命令的云端访问查询替代枚举：只是换个名字的同一可用性依赖。
- 要求订阅保持连接：网络故障会阻断本地工作，却不能改进撤权，因为旧的逐次查询在同样
  条件下也会失败。

## 验证与限制

`daemon-session-tools.test.ts` 在发现接口被拒的情况下运行真实的 `lody_session_list`
和 `lody_session_archive` handler，覆盖：

- 列表查询调用次数为零；
- 撤权后拒绝；
- 无需重启即可恢复；
- `unknown` 回退保留发现错误；
- 账号、机器、selector 和摘要不一致；
- token 被拒；
- 借用副本的失败路径。

Fleet 测试按以下顺序驱动真实订阅回调：启动缓存、授权快照、订阅错误、移除、恢复，
最后 token 被拒。`command-runtime.test.ts` 覆盖在线歧义和错误传递，以及离线目录身份
、`remote_missing` 和加密目录损坏的处理。未对生产环境做真实 MCP 全链路验证。订阅断开期间，撤权会在
订阅重连后生效。独立 `--offline` 的 E2EE 打开以及其他独立命令仍需各自的网络路径。

相关：[daemon 托管的 MCP 工作区命令](../architecture/2026-10-16-daemon-hosted-mcp-workspace-commands.zh.md)。
