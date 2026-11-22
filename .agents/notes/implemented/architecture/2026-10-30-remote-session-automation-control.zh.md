# 远端 Session 自动化控制

Date: 2026-10-30
Status: implemented
Translation: current

[English](2026-10-30-remote-session-automation-control.md)

## 摘要

Electron 的 Session 控件通过现有 Machine RPC 上限定范围的操作，管理另一台机器上 Session 的 Automation；远端 Workspace Host 和账本仍是权威。Workspace RPC 无法认证请求中声明的用户，因此每个请求都携带仿照远端 Preview、绑定具体操作的云端证明。机器 owner 以及当前能编辑该 Session 的协作者可以列出、配置和取消；每条命令、读取和交付都以一个经过验证的主体执行，并在生效时重新检查其编辑权限。加密 Workspace 的 RPC 被禁用，因此没有远端控制。

## 设计边界

对于支持的明文 Workspace，Session UI 通过 Workspace Machine RPC facade 寻址该 Session 的实际机器。该传输将本机请求送往现有本地 owner，将远端请求送入现有 Streams RPC。目标 daemon 对准确的 Workspace 和 Session 调用已有 Automation Workspace owner；账本、调度、取消和接纳仍由它负责。界面只有 list、settings、configure 和 cancel，并返回有界的公开结果；不通过此界面转发任意 Agent 程序，也不把账本复制到 Workspace 元数据。

目标机器公布带版本的 Automation 控制能力。旧机器显示不支持；离线、超时和结果未知不能显示为空列表或确认成功。修改始终绑定同一个 Session，取消仅能作用于该 Session 的 Wait。写入超时不代表失败，也不能盲目重放；应刷新 owner 状态以确认可观察的结果。可核对的内容由现有 Session 策略和取消语义决定。

远端 Wait 列表按账本顺序和字节数分页；客户端为每个游标签发证明，合并页面后再展示。Automation 响应使用独立的有界加密信封大小，以容纳合法的长原因，同时不扩大其他 RPC 密钥用途的限制。机器快速握手使用控制通道；Session 操作使用普通有界请求通道，因为证明验证可能等待云端 I/O。慢验证不会占用 Stop 和 Steer 的保留槽位，但普通通道过载时 Automation 请求可能被拒绝。

## 调用者身份

调用者授权遵循[远端 Preview 证明](../../../../apps/cli/src/preview/preview-control-authority.ts)的模式：签名意图绑定请求者、Workspace、机器、Session、准确操作和参数、runtime nonce、请求 ID 和响应公钥。云端签发方从登录会话取得请求者，从不采用请求体中的值；目标 daemon 使用自己的 CLI 凭证核验同一意图，验证方还要求请求者可以使用该机器。Automation 有独立的签发、验证接口、token 版本和密钥域，Preview 证明不能授权 Automation 操作。

[Machine RPC 规则](../../../../packages/loro-streams-rpc/AGENTS.md)明确指出 Workspace RPC 无法认证请求中声明的身份。`verifyMachineAccess` 检查指定用户能否访问机器，不证明请求由该用户发出。Code Collab 信封的内容密钥由 Session ID 派生，不能证明调用者身份。RPC 参数里的 `userId` 不是凭证：验证前目标只检查 Session 是否在本机有效，验证后经验证的请求者必须等于声明的请求者。

## 谁可以执行

账本保存在本机，但其中的规则、Wait 和待恢复工作都记录作者。每条命令、条件读取和交付都以一个主体执行：远端请求是经验证的请求者，MCP 命令是当前 Agent 输入的作者，本机 CLI 和 Electron IPC 是机器 owner。该主体必须当前能编辑目标 Session：机器 owner，或拥有机器共享（本地项目还需项目共享）的协作者。`SessionAutomationAuthority.canEdit` 复用 Session 输入使用的同一机器/项目检查，加密 Workspace 中包括已验证的共享策略。无法确认的检查返回 `unknown`，工作会等待，而不是执行或失败。

能编辑某个 Session 的人可以看到其中所有作者的 Wait 和活动，并可以取消。Session 策略每个 Session 只有一条规则，因此最后一次配置它的编辑者成为作者，恢复续跑以该作者身份、使用机器上的 Agent 配置执行。交付时重新检查作者的编辑权限；撤销权限会停止之后的续跑。由规则启动新 Session 仍只限机器 owner。

## 信封与限制

目标以其 runtime nonce 对每份证明只接收一次，并在验证后再次检查编辑权限。RPC 复用现有 owner Session 信封封装请求和响应。owner 关闭时等待在途验证；取消和执行仍由现有 Automation runtime 负责。

owner Session 信封不能向知道 Session ID 的 Workspace 成员保护 bearer 证明：它的密钥由该 ID 派生。意图绑定临时响应公钥，目标用该公钥加密结果；成员不能通过替换接收者转移有效结果。但这不能认证响应发送者：任何持有公钥的人都能加密伪造响应，成员也仍可抢先使用一次可见的证明。这是共用 Workspace RPC 信任模型的现有限制。

协作者的命令、读取或交付每次生效时都会向后端检查编辑权限，没有缓存；机器 owner 不需要网络检查。测试使用合成密钥、编辑权限桩和内存 RPC 传输；不能证明已部署的云端授权或真实跨机器交付。加密 Workspace 在本机运行 Automation，但共享内容策略禁用其 RPC；Fleet 和界面依据该 `rpc` 判断决定是否提供远端控制。
