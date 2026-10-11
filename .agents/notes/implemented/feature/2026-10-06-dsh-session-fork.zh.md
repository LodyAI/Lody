# DSH 会话分叉

Status: implemented
Translation: current

Provider PR: [acp-extension-dsh #27](https://github.com/LodyAI/acp-extension-dsh/pull/27)

[English](2026-10-06-dsh-session-fork.md)

## 摘要

DSH ACP 适配器现已通过 Core 既有版本 1 元数据及固定版 Harness 0.1.5-rc.2 日志实现普通分叉和指定已结束轮次分叉。原生历史前缀用于创建独立根 Agent，保留历史配置并使用目标 cwd/MCP；原生持久化成功后才返回成功。无需升级 Harness。ACP 边界测试及原生事件存储探针已通过；未结束轮次内部截断和 ACP load/resume 不属于本次变更。

## 源码证据

检查范围为适配器 `fbc54496b2770b8bf4e756636238459d064ffc12`、Harness 发布版
[`fb2c4b9e`](https://github.com/deepseek-ai/deepseek-harness/tree/fb2c4b9e698e30edb738bca4cf0618587db7d203)
（`dsh-v0.1.5-rc.2`），以及上游
[`5badb150`](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc)
（`0.2.1-alpha.1`）。同时核对了发布产物。

- 固定版 `packages/core/session/src/index.ts` 的 `sessions.fork(source, boundary?, childSessionId?)` 按包含切点的事件前缀复制 live Session；轮次未闭合时拒绝 `OPEN_TURN`。父会话继续运行不影响复制较早的已结束轮次。
- 固定版 `packages/api/session-controller/src/commands.ts` 通过 `sessionQuery.observeSession` 读取 live 或持久化历史，再用 `agents.create({ seed, inheritedEventCount, meta, setup })` 创建带分叉血缘的独立根 Agent。这适用于不持有源运行时的 ACP 进程。该 UI 接口的 `atSeq` 会对齐到后续轮次结束，越界时回退到最近已结束轮次；精确 ACP 切点不能沿用这种语义。
- Session 日志仅追加。上下文压缩替换模型可见视图，不删除原始事件；原始事件仍可读取时，截取前缀能还原压缩前的上下文。
- 上游 `packages/core/session/src/fork.ts` 新增 `buildForkSeed`，标记继承历史，并为未闭合切点补工具结果和 step/turn 结束事件。固定版没有对应公共 helper，且拒绝这种切点。不要在适配器复制新版存储和生命周期逻辑。
- `subagent-fork-in-process` 为委派任务选取最近已结束轮次的前缀，不是独立 ACP 会话分叉接口。

## 已实现的适配器职责

1. 通过 Core `_meta.lody.turnId` 输出稳定原生轮次标识，关联当前 prompt 的根输出。请求时在原生日志中解析标识，精确复制到对应 `turn/end`；未知、格式错误或未结束的目标必须拒绝。不能从显示文本、工具 step 或缺失原生标记的 Lody 旧历史猜测切点。
2. 明确定义运行中不指定切点的行为：直接拒绝；显式指定更早已结束轮次时允许分叉，且不取消父会话。已有持久 `turn/end` 的停止或失败轮次在结构上也已闭合。
3. 读取一次原生快照，创建带 seed 的新根 Agent。保留血缘和选定前缀，使用目标 cwd/MCP，复用现有会话配置、提问、工具、用量和释放逻辑。模型、推理、权限及 preset 应按切点恢复，避免误继承之后的配置。不能把文本历史作为新 prompt 重放。
4. 报告持久分叉成功前等待 `sessions.flush(child)`，配置或落盘失败时释放运行时及 MCP 资源。落盘失败错误包含子会话 ID，因为 Harness 没有公共存储产物删除接口。带 seed 创建成功本身不保证落盘；冷加载和续聊仍需单独验证，当前适配器没有暴露 `loadSession` 或 `resumeSession`。
5. 声明标准 ACP fork 与 Core `forkAtTurn`；能力来源 profile revision 升为 v15，触发宿主重新探测。Git worktree 和项目文件回滚仍由宿主负责。

[Grok 分叉决策](../../implemented/feature/2026-09-24-grok-session-fork.zh.md) 提供已有宿主契约；本次只增加 DSH 翻译。[DSH fork Spec](../../../../specs/deepseek-harness-session-fork.zh.md) 保持 draft。

## 验证及限制

- 适配器构建及全部 41 项单元测试通过。新增四个 ACP 边界用例覆盖冷源完整/指定轮次复制、历史模型/推理/preset、目标 cwd/MCP、子会话续聊输出的原生轮次元数据、源历史不变、错误或缺失及未结束目标、配置及落盘失败、资源释放，以及确定性的子会话/源 prompt 持久化屏障。Harness 在请求和工具前做检查点，不保证最终 `turn/end`；现在 prompt 完成前会 flush 已结束前缀，以支持立即跨进程分叉。
- `DSH_TEST_RUNTIME_ROOT=<固定版 node_modules> node --test scripts/session-fork-smoke.mjs` 在 Harness 0.1.5-rc.2 发布包上通过。适配器实际前缀构造器的输出进入原生 SessionStore，验证完整/指定复制、压缩视图替换前后切点、源隔离、子会话独立追加、序列化恢复，以及源运行时分叉较早轮次。仅使用合成数据，没有模型、凭证或用户数据。
- 实际压缩模型执行、模型续聊、JSONL/zstd 磁盘重启、附件生命周期及跨进程并发持久化尚未验证。原生探针恢复序列化 Session 数据，没有启动 daemon。
- 当前嵌套 checkout 缺少根 workspace 依赖（`rimraf` 不可用），不能运行根桌面构建。适配器检查使用其独立安装。
