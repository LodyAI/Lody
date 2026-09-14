# 本机附件直接引用（独立后续 PR）

Status: draft
Translation: current

[English](local-attachment-references.md)

## 摘要

本提案在独立后续 PR 中实现 Electron 向同机 Daemon 发送附件时跳过上传：原文件直接引用原路径，无路径内容保存为本机文件，两者不自动上传或后台补传。需要独立本地引用协议、可信登记、Daemon 解析、预览和版本兼容；原文件不是不可变快照，也不扩大 Agent 文件权限。当前[附件 draft PR](session-files.zh.md)只改变准备时机和待发送流程，沿用现有传输，不依赖本提案；这里保留后续设计，不作为当前 PR 的实现或验收要求。

## 1. 与附件 draft PR 的接口

沿用 draft PR 的输入快照、待发送管理器及 ready 边界。后续仅替换符合条件的附件准备策略，不另建新对话/继续对话的发送流程。

| 场景                                        | 后续 PR 的准备方式                                   |
| ------------------------------------------- | ---------------------------------------------------- |
| Electron 原文件 → 可信同机 Daemon           | 校验、登记原路径，不全量读取/hash/复制；返回本地引用 |
| Electron 无路径 File/Blob → 可信同机 Daemon | 点击发送后原子保存到本机持久附件目录，返回本地引用   |
| Web/移动端，或 Electron → 远程 Daemon       | 继续现有上传与校验                                   |

同机须由可信本地 runtime 身份匹配目标 machine ID，不能仅凭 Electron 环境、主机名或 project kind。身份未确定时等待；已知同机但能力缺失、Daemon 离线或准备失败时明确报错，不回退上传。原路径引用不机械继承网络上传大小上限，生成内容仍受本机存储限额约束。发送前替换了字节的编辑结果是 Blob，不能再冒充原路径。

## 2. 本机引用契约

### 2.1 来源、范围与权限

Electron 在原始 File 仍可识别时取得系统路径；无路径 File 进入 Blob 分支。通过可信的产品窗口及本机控制入口登记文件，绑定工作区、会话、目标机器和该次发送授权；同步文档只携带可验证的引用及必要展示信息，真实绝对路径保存在本机登记中。

Daemon 不能把同步消息中的任意 `path`、`machineId` 或引用 ID 当成新文件授权。解析必须查到有效本机登记，且验证当前输入与登记的使用范围。跨会话复制 ID、远程构造相同 ID、另一台机器的同名路径均不得获得读取权。引用也不能变成任意后续消息都能使用的环境权限；具体提交绑定及 fork 授权形态在协议实施阶段确定。

ACP 最终仍收到正确编码的 `file://` `resource_link`，不能退化为纯文本路径。用户选中的工作目录外文件可以登记，但不自动扩大 Agent 沙箱。Agent 无法读取时使用现有权限流程或明确报告不可用，不复制进允许目录或上传来绕过权限。

### 2.2 原路径不是字节快照

原文件内容可以在发送后改变，Agent 读取的是读取时的内容。准备和实际 dispatch 前检查可读普通文件；文件移动、删除或变成目录/设备/管道时失败，不静默使用旧缓存。Lody 永不修改或删除用户原文件。

路径校验须处理符号链接及父目录重定向：登记时解析目标，使用前检测是否转向未授权目标，变化后要求重新选择；不得无条件跟随替换链接。普通内容编辑不等于附件快照。最终 ACP 只传路径，因此不能保证校验与 Agent 稍后打开之间的字节不变；Agent 的沙箱仍是其读取边界。本版不承诺不可变快照或抵抗所有本地文件竞争。

### 2.3 生成文件、图片与历史

生成内容发送前只作为草稿；发送后保存到稳定目录，写完才返回引用，失败时保留原草稿。消息接受后仍需保留生成文件，供 Agent 执行、重试、预览和历史使用。临时 object URL 与持久附件文件分别管理；有待发送记录、历史或合法 fork 引用的生成文件不得回收。清理只处理明确无引用的应用自有文件，无法确认时保留。

本机图片保持视觉输入语义：根据目标适配器能力提供本地图片输入或从本机读取形成 ACP image，并保留需要的 resource link；不能仅发送图片文件名。适配器不支持时明确拒绝，不静默退化或上传。这里的“零上传”指 Lody 的附件上传/补传服务，不包括用户消息已有的同步，或 Agent 按其既有模型配置发送输入。

其他设备显示“仅在该电脑可用”，不尝试打开其本机同名路径。预览沿用 Electron 的窄文件资源能力，不把持久引用 ID 直接变成通用文件读取 URL。同机重发/fork 必须显式继承合法使用关系；跨机器 fork 或迁移需披露不可用并在实际执行前解决，不能隐式上传。分享/导出不得自动将此类型收集为云端附件；无法包含时须阻止或明确标注缺失，不能声称分享包含完整附件。

### 2.4 与旧协议并存

新增独立的本地引用输入表示，贯通解析、历史归一化、渲染、队列、dispatch、重发与 fork。旧 `transport: 'local'` 仍表示旧的待补传 blob，不能全局停止其恢复，也不能自动迁移成新语义。新原路径引用与新生成文件都不得进入旧补传扫描，恢复时也不例外。

按[Machine 协议协商](../packages/shared/AGENTS.md#machine-protocol-negotiation)声明版本能力；能力缺失就禁用新发送。旧 reader 保留未知内容的能力不等于旧 Daemon 可安全执行：必须保证旧 Daemon 拒绝包含新引用的整条执行请求，不能仅执行剩余文字。无法建立这个兼容条件的组合不开放本地引用发送。

## 3. 独立验收与待定项

后续 PR 单独证明：原路径 URI 的编码正确；无副本且实际附件 HTTP/补传出口为零；失败、重试和重启扫描不回退上传；生成图片保留视觉语义与历史文件；伪造引用/跨会话或跨机器复用不扩权；路径删除、重定向、沙箱拒绝可见；旧客户端/Daemon 安全拒绝不支持的整条执行；预览、重发、fork、分享与清理遵守本机引用边界。

需在该 PR 锁定引用 wire/IPC 字段、提交绑定、fork 授权继承、版本能力与旧 Daemon 拒绝策略、本机图片适配器支持和文件回收规则。这些决定不阻塞 draft PR；当前 draft PR 也不能提前宣称同机附件永久不上传。

## 4. 证据与状态

设计基于 `8c429a890037c5b21855ce7ef9f59e3677c25a38` 的源码检查；未实施、未做独立模型或真机验收。拆分决定见[决策记录](../.agents/notes/proposed/architecture/2026-09-14-deferred-attachment-send.zh.md)。当前 blob/补传链路见[CLI 附件说明](../.agents/docs/cli-lib-session-files.md)。

源码入口：`packages/components/src/lib/electron-session-file-sender.ts`、`apps/electron/src/main/ipc/services/local-projects-ipc.ts`、`apps/electron/src/preload/index.ts`、`apps/cli/src/lib/{message-handler,session-file-backfill,session-file-blob-store}.ts`、`packages/shared/src/{message-schemas,session-input}.ts`。原文件路径 API 参见 [Electron webUtils](https://www.electronjs.org/docs/latest/api/web-utils)。
