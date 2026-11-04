# 不依赖运行中 daemon 的 Electron 文件预览

Status: implemented
Translation: current

[English](2026-10-16-daemon-independent-local-file-preview.md)

## 摘要

Electron 原本已负责读取内容，但 daemon 不可用时，桌面用户仍无法打开本机文件。
现在 Electron 使用磁盘上的持久化机器身份核对目标，直接解析并读取文件，
不再要求 daemon 请求、协议能力查询或文件索引就绪。相对路径仍需原属主会话的
工作目录，远程文件仍走既有受限 RPC。这次改变的是预览获取路径，
不改变 daemon 负责的索引、保存和 Agent 执行。

## 决策和职责

```text
桌面预览 → 主进程核对磁盘上的机器身份
  匹配本机 → 共享路径解析器 → Electron 文件资源
  其他机器 → 既有远程路由及有界 file/preview
```

- `machineRpc.previewFile` 校验输入及产品窗口来源。它从对应平台的 credentials 文件
  仅读取机器身份，在解释文件路径之前核对目标。本机读取失败不会转发到云端；
  缺失机器身份不能授权本机读取。
- 绝对路径和 home 路径不依赖会话根目录。相对路径使用属主会话的缓存元数据
  （子会话使用父会话）；缺少项目或根目录就报错，不替换成聊天目录或进程 cwd。
- 桌面 provider 在索引等待或失败期间仍存在，已知文件链接仍可打开。
  索引状态单独报告。Markdown 打开流程在缺少 daemon 身份时核对磁盘身份，
  保留其他 worktree 文件的绝对路径。
- 本机读取属于桌面用户的文件系统能力，与现有系统打开、定位一致，不授权
  执行 Agent 或修改会话。不新增会话权限数据库，也不缓存陈旧授权。
  IPC 仅限产品窗口，嵌入页面不会获得文件系统 API。
- 将既有解析器移至 `shared/node/file-preview-path-policy`，保持大小写、NFC、
  符号链接、空白及错误分类行为。CLI 包装层提供相同的远程默认根目录，
  旧 `file/resolve-local` 继续服务旧客户端。Electron 复用有界资源读取、
  文件版本检查及 renderer 生命周期隔离。外部文件保持只读，不新增写 API。
- 文件路径 hook 与系统文件操作共用。没有改变 Effect 工作流或生命周期所有者；
  迁移周围 runtime/cache 对直接读取无帮助，因此不纳入此次修复。

此实现替代早先持久化桌面会话权限上下文的提议：桌面用户预览本机文件不需要该体系。
[冷聊天修复](2026-10-09-cold-chat-file-preview-workspace.zh.md) 仍适用于旧客户端或远程 daemon 读取；
[路由缓存](2026-09-29-local-file-preview-route-cache.zh.md) 已非当前桌面预览必需。
保留[失败恢复](2026-10-16-file-preview-failure-recovery.zh.md) 的错误语义。
意图：[文件链接](../../../../specs/local-file-link-actions.zh.md)。

## 验证

行为测试覆盖无运行中 daemon 时读取真实磁盘身份和文件、无效或缺失的根目录和路径、
拒绝将远程机器当作本机、本地失败不转云、远程路由，以及索引失败时仍能获取预览。
既有资源与 CLI 路径、服务测试继续覆盖文件版本、Range、符号链接和远程授权。
完整检查结果及剩余环境限制记录在 PR；不声称完成打包 UI 冷启动或停止真实 daemon 的实验。
