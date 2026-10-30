# 远端 Session 自动化控制

Date: 2026-10-30
Status: proposed
Translation: current

[English](2026-10-30-remote-session-automation-control.md)

## 摘要

Agent 可以管理自己所在机器的 Automation，但 Electron 的 Session 控件拒绝远端 machine ID。拟议方案在现有 Machine RPC 中增加限定范围的 Automation 操作，继续由远端 Workspace Host 和账本负责执行。Workspace RPC 无法认证请求中声明的用户身份；现有远端 Preview 证明提供了具体授权模式，但其专用于 Preview 的云端签发和验证接口必须扩展才能支持 Automation。加密 Workspace 不在本提案范围内。

## 设计边界

对于支持的明文 Workspace，Session UI 通过 Workspace Machine RPC facade 寻址该 Session 的实际机器。该传输将本机请求送往现有本地 owner，将远端请求送入现有 Streams RPC。目标 daemon 对准确的 Workspace 和 Session 调用已有 Automation Workspace owner；账本、调度、取消和接纳仍由它负责。界面只需要 list、settings、configure 和 cancel，并返回有界的公开结果；不要通过此界面操作转发任意 Agent 程序，也不把账本复制到 Workspace 元数据。

目标机器公布带版本的 Automation 控制能力。旧机器显示不支持；离线、超时和结果未知不能显示为空列表或确认成功。修改始终绑定同一个 Session，取消仅能作用于该 Session 的 Wait。写入超时不代表失败，也不能盲目重放；应刷新 owner 状态以确认可观察的结果。可核对的内容由现有 Session 策略和取消语义决定。

远端 Wait 列表按账本顺序和字节数分页；客户端为每个游标签发证明，合并页面后再展示。Automation 响应使用独立的有界加密信封大小，以容纳合法的长原因，同时不扩大其他 RPC 密钥用途的限制。

调用者授权应遵循现有[远端 Preview 证明](../../../../apps/cli/src/preview/preview-control-authority.ts)的模式：签名意图绑定已认证用户、Workspace、机器、Session、准确操作和参数、runtime nonce、请求 ID 和过期时间；云端签发方授权登录用户，目标 daemon 使用自己的 CLI 凭证核验相同意图后再调用 owner。现有 Preview 证明只允许 Preview/Simulator 操作；Automation 需要云端签发与验证显式支持，并定义独立公共端口契约，不能伪装成 Preview 操作。当前账本、命令 owner 和动作授权都使用 daemon 的 `auth.userId`；第一步仅允许已验证的请求者同时是 Session 和 daemon owner。共享机器上的协作者需要修改这些归属检查，并在交付时重新检查实际用户权限，不能只修改 RPC 入口。

[Machine RPC 规则](../../../../packages/loro-streams-rpc/AGENTS.md)明确指出 Workspace RPC 无法认证请求中声明的身份。`verifyMachineAccess` 检查指定用户能否访问机器，不证明请求由该用户发出。现有 Code Collab 信封的内容密钥由 Session ID 派生，不能证明调用者身份。RPC 参数里的 `userId` 不是凭证。

公开的[远端意图和证明 schema](../../../../packages/shared/src/automations/control.ts)定义了拟议的准确范围，并排除程序注册。Workspace owner、Machine RPC 和 renderer 路由已连接到注入式验证和签发端口，云端组合会安装签发器和验证器，并在云端机器上声明该能力；UI 也要求签发器已安装。目标以其 runtime nonce 对每份证明只接收一次，并在验证后再次检查 Session 归属。RPC 复用现有 owner Session 信封封装请求和响应；直接检查 Session 身份，不要求 worktree 或 Roost 历史。owner 关闭时等待在途验证；取消和执行仍由现有 Automation runtime 负责。

owner Session 信封不能向知道 Session ID 的 Workspace 成员保护 bearer 证明：它的密钥由该 ID 派生。意图现已绑定临时响应公钥，目标用该公钥加密结果；成员不能通过替换接收者转移有效结果。但这不能认证响应发送者：任何持有公钥的人都能加密伪造响应，成员也仍可重放可见的证明。这是共用 Workspace RPC 信任模型的现有限制；一次性消费和 nonce 不能认证回复或隐藏证明。合成测试验证接收者保密和绑定，不能证明通信双方身份。

云端签发和验证需要部署匹配的后端。公开客户端和 daemon 端口已接通，但当前分支及其后端改动尚未一起部署。测试使用合成密钥验证签名，并使用合成 Workspace owner、renderer 端口和内存 RPC 传输；不能证明已部署的云端授权或远端交付。既有加密 Workspace 策略继续禁用 RPC 与 Automation。当前可访问机器目录只有一台在线机器，因此未进行真实跨机器测试。
