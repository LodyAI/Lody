# Ryugi 反馈投递

Status: draft
Translation: current

[English](ryugi-feedback-delivery.md)

## 场景

Lody 会话里的 agent 打开了一个 [Ryugi](https://github.com/Innei/ryugi) 产物：画板、
文档、白板、幻灯片或验收报告。用户在页面上选一个方案、钉一条评论，或者判定通过。
无论会话由哪个 provider 运行，这条反馈都应该回到同一个会话，出现在会话历史里，
并像其他输入一样交给 agent 处理。

Ryugi 目前按各 harness 的原生方式投递反馈。在 Lody 里，这些方式要么绕过 Lody，
要么根本送不到：

- Pi 和 DeepSeek Harness 扩展会让 provider 自己起一个回合，这个回合不是 Lody 提交的。
  Lody 看不到它的输出，下一条 prompt 还会因为"正在忙"被拒绝；
  [acp-extension-pi#38](https://github.com/LodyAI/acp-extension-pi/issues/38)
  显示这个拒绝被报成内部错误，导致会话被终止。
- Codex 的投递需要 App Server 地址，而 Lody 的 stdio 适配层不提供。Kimi、Devin、
  Grok 则完全没有主动推送的通道。

## 决定

Lody 通过 Ryugi 公开的自定义宿主契约，充当 Lody 会话的 Ryugi 宿主。这个契约包括
`hosts` 配置、`RYUGI_HOSTS_CONFIG` 覆盖、每个事件执行一次的投递命令，以及回执。
整套机制只在 Lody 核心里实现一次，不含任何按 provider 区分的代码。

```text
Ryugi page ── event ──> ryugi-hook (host lody) ──> Lody delivery command
          ──> Session Inbox ──> ordinary ACP prompt ──> any provider
```

1. **环境变量。** 每个 ACP agent 进程和 Lody 提供的 terminal 已经带有
   `LODY_SESSION_ID`。Lody 再设置 `RYUGI_HOSTS_CONFIG`，指向 Lody 数据目录下一个由
   Lody 自己管理的文件。
2. **宿主文件。** 这个文件声明一个以 `LODY_SESSION_ID` 识别的 `lody` 宿主，命令是
   Lody CLI 投递命令的绝对路径。Lody 只读地读取用户自己的 Ryugi 配置，把其中的其他
   宿主一并带过来。Lody 从不写用户的文件。如果用户已有宿主以 Lody 设置的某个变量
   识别，Lody 就不注入，避免 Ryugi 同时匹配到两个宿主。
3. **订阅。** Ryugi 先匹配自定义宿主，再匹配内置宿主。所以无论哪个 provider，
   从会话里打开的产物都会订阅为 `lody/<sessionId>`。Ryugi 的 Claude 和 Codex watcher
   遇到自定义宿主会让路，Pi 和 DeepSeek Harness 的 watcher 收不到事件。
4. **投递。** 命令读取 Ryugi 的数据，把 Ryugi 的 wake message 原样作为会话排队输入提交，
   来源标记为 Ryugi。输入经过常规的会话 Inbox 准入、队列、Stop 和访问控制。它排在
   正在运行的回合之后，从不 steer，也从不在 Lody 提交的 prompt 之外让 provider 开始工作。
5. **回执。** 输入被接受时退出码为 0，输出 `{"status":"queued"}`。暂时失败时（例如
   daemon 连不上、同步未确认）返回 `{"status":"retry","reason":…}`，由 Ryugi 重试。
   会话已归档、已删除或不再有访问权限时退出码为 10，取消订阅。

## 保证

- Ryugi 反馈只会以 Inbox 输入的形式、经过常规准入进入会话。它和用户自己的消息
  由 Lody 的队列排序。
- 历史里把这条输入标为来自 Ryugi，而不是用户输入的。投递以
  [自动化规则](../apps/cli/src/automations/AGENTS.md)为 CLI 命令规定的机器所有者身份
  执行，并在投递时重新检查对该会话的编辑权限。
- Lody 只加来源标识，按照根规则中关于发给 agent 的文本的要求，不往 Ryugi 的文本里
  加任何指令。
- 没装 Ryugi 的会话行为完全不变。用户的 Ryugi 配置从不被修改。
- 适配层必须把"正在忙"的拒绝报成 `invalid request`（`-32600`），而不是内部错误。
  这个适配层修复单独跟踪，不依赖本 Spec。

## 范围限制

- agent 需要加载 Ryugi 的 skill。安装方式因 provider 而异，不在本 Spec 范围内；
  例如 Pi 需要在 Lody 里勾选该扩展。
- 如果某个 provider 在不继承 agent 环境的进程里执行工具，会回退到 Ryugi 的原生投递方式。
- Ryugi 的 hook 使用 Unix socket，只发布 macOS 和 Linux 版本，所以不覆盖 Windows。

## 待定问题

- 投递应该默认开启并提供机器级开关关闭，还是由用户主动开启？
- 别人在已发布的 Ryugi Cloud 产物上留的评论也会被 Ryugi 转发。Lody 是否接收它们进入
  会话，又该如何标识？
- 从 Ryugi 的后台 worker 调用投递命令，在本地模式和云模式下能否正确认证？会话自己的
  进程能否往该会话投递？
- Ryugi 的投递是至少一次，回执丢失可能导致重复输入。Lody 是否按 Ryugi 的事件标识去重，
  数据里是否带有稳定的标识？
- 加密工作区要求排队的自动化输入由机器签名。第一版是支持它们，还是拒绝投递？
- 会话结束后，Ryugi 的 worker 要等下一次投递被拒绝才会退出。Lody 是否需要更早地停止它？

## 依据

这里只描述预期行为，尚未实现，也未执行任何验证。查阅过的源码：

- Ryugi `7a3ee3c`（1.108.2）：`hook/src/hosts.rs`（自定义宿主、`RYUGI_HOSTS_CONFIG`）、
  `hook/src/cmd.rs`（投递数据、回执、退出码 10）、`hook/src/subs.rs` 的 `identity()`
  （自定义宿主优先）、`hook/src/watch.rs` 和 `hook/src/codex.rs`（内置 watcher 让路）、
  `.pi/extensions/ryugi.ts` 和 `.dsh/index.mjs`（自己起回合的投递方式），以及
  `docs/install.md`（Codex 需要 App Server 地址）。
- Lody：`apps/cli/src/session/session.ts` 的 `buildShellEnv`，`createAgent` 和
  terminal manager 都使用它。
- Pi 适配层 `66cc30a`：`src/connection.ts` 只认 ACP 发起的回合，发送 prompt 时不带
  `streamingBehavior`，没有 ACP 回合时丢弃事件。
