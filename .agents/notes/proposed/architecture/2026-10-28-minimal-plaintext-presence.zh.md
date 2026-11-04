# 加密工作区的最小明文 presence

Status: proposed
Translation: current

[English](2026-10-28-minimal-plaintext-presence.md)

## 摘要

加密工作区关闭 presence 后，机器在线、会话状态和查看者信息都不可见。选定方案复用普通工作区的临时通道与 90 秒 TTL，发布和接收分别通过只允许 ID、枚举及时间戳的白名单。自由文本详情在写入本地来源 store 或发布到云端前即被去掉。服务端能看到这些在线元数据，同时无需另建加密、密钥可用性和重放处理流程；文档保护仍独立工作。

实现草稿：[#1999](https://github.com/LodyAI/Lody/pull/1999)。

## 决定与边界

本方案替代 [M2 集成提案](2026-10-22-e2ee-m2-product-integration.zh.md)中关闭 presence 的部分。
加密 presence 实现 [#1994](https://github.com/LodyAI/Lody/pull/1994) 已关闭、未合入。在线元数据与连接、流量和账号身份已经暴露的信息重合；该功能的保密收益不足以抵消额外密码学生命周期的复杂度与可用性成本。

- 保留现有 Loro EphemeralStore adaptor、稳定 key、房间路由、队列、心跳和 TTL。使用加密工作区已授权的 bucket 和现有 token owner；能力缺失时不能改用普通 bucket。
- 共享最小 schema 独立列出 ID、`kind`、状态 `type`/`activity`/`phase`/`stage` 枚举以及 `since`/`updatedAt` 时间戳。忽略额外字段，包括 `detail`、未来文本字段和格式错误的多余内容。已知字段不合法时只丢弃该条状态。
- ID 的类型标记不代替校验：session 必须使用 UUID；只有内部生成的 instance 还允许有界的旧版浏览器时间戳/base36 格式；machine 使用 UUID 或 64 位小写十六进制；user 使用 32 位字母数字、UUID，或 `local:` 加 32 位小写十六进制。无效查看参数会先清除旧查看状态，不保留参数或继续心跳。CLI 在登记 producer key 前拒绝无效 ID，因为 Loro 删除不存在的 key 也会发送该 key。校验失败不抛错；格式通过不证明会话实际存在，也不授予身份权限。最小模式不发布非 UUID 会话 ID；时间戳前缀不能证明来源。若以后支持真实历史 fallback，必须由可信本地会话记录确认，不允许仅凭路由值例外放行。
- CLI 在创建时选择最小模式，早于本地来源和工作区 store 的任何写入。心跳重发不能找回已去掉的详情。云端和本地 renderer 快照都经过最小接收解析；查看状态的发布也显式经过白名单。
- 普通 presence 的既有正文、解析和 90 秒 TTL 不变。启用 presence 不会启用任何带内容的侧通道。presence 只是不可信的在线提示，不是成员、身份或执行授权。
- 房间不可用或未加入时仍为 unknown，不能仅据此阻断发送。presence 连接失败不会撤销受保护的文档连接；既有 presence owner 继续负责清理和恢复，并输出有界警告。不增加队列、计时器、重试 owner、密钥操作或同步屏障。

[#1990](https://github.com/LodyAI/Lody/pull/1990) 中的 presence 正文 codec 不使用，也不删除，后续另行处理。

## 验证与限制

确定性回归先复现详情泄漏、接收解析、presence 未启用及界面不可用判断，再验证修复。覆盖真实 Loro 编码、SDK POST 字节、服务端式 apply/encodeAll bootstrap、收到的额外字段、本地来源重发，以及普通正文保持不变。另加 RED→GREEN 回归，对每种 ID 字段拒绝文本、路径和超长值；查看状态覆盖启动前、启动后、心跳及清理，包括 Loro 删除更新字节。另加 RED→GREEN 回归，拒绝伪装成时间戳前缀的可读会话文本，覆盖查看发布、CLI 发布/心跳/清理与接收，同时保留内部 instance fallback。验证支持的生成格式与普通模式任意非空 ID 的兼容行为。CLI 组合测试验证加入前为 unknown、加入后返回在线集合；既有发送测试继续验证 unknown 放行、明确离线拒绝。使用假时钟、注入时钟和显式信号，不依赖 sleep 或网络时序。

启动测试隔离可选的机器监控、建议云端连接，保留既有可控原生 presence 服务。降级启动用例通过显式 Deferred 失败触发 meta 超时，并在 `finally` 中释放 manager，去掉该测试中无关的真实 SDK I/O 和时钟调度依赖；生产传输行为不变。

受影响测试、类型、静态检查和文档检查的结果见 PR。本地测试不证明真实部署网关、已安装双设备行为或各平台打包验收。草稿仍待审查。
