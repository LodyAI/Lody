# 统一冻结 turn 执行输入的解释

Status: implemented
Translation: current

[English](2026-10-08-frozen-turn-execution-input.md)

## 摘要

Issue [#1332](https://github.com/LodyAI/Lody/issues/1332) 暴露出首次执行与重试使用不同
文本来源：create 发送组合后的 Config/Role/任务，continue 则优先使用原始任务块。
现在由共享执行输入解析函数统一 create、continue 和 steer 的规则。它使用冻结文本并保留
结构化附件，不改变原始历史或存储格式。持久化 turn 回归测试验证了启动失败后的重试；
真实 provider 集成和打包桌面交互仍未验证。

## 决策与职责

`inputConfig.prompt` 拥有有效执行文本，包含接受 turn 时已组合的指令。`inputBlocks`
保存原始输入及结构化附件。shared session input 中的 `resolveSessionExecutionInputBlocks`
将冻结文本与图片、文件、评论、视觉标注组合。显式空文本保留附件，但不恢复原始任务文本；
缺少 prompt 的旧输入继续使用规范化 blocks。派发层已有历史回退逻辑。原文 spans 只与原文
绑定，不复制到组合后的执行文本。

execution service 的所有入口都使用此解析函数，包括陈旧会话恢复时重新构建 continue
prompt。create 仍添加其运行时上下文，continue 可能前置历史回放。daemon 负责附件落地；
这些运行时职责不改变已接受的任务，也不重新读取 Role 目录。Role id/revision/snapshot 和
其他冻结配置保持原样。通用输入 normalizer 不变，继续服务展示、编辑、队列及 RPC 历史构建。

该设计落实[编排契约](../../../../specs/session-orchestration.zh.md)，并延续
[本地编排决策](2026-09-29-local-session-orchestration.zh.md)。只修 Role continue 会留下
steer 分叉；改写原始历史会丢失用户输入表示；全局修改 normalization 则把执行策略混入展示
和编辑。增加第三份持久化 execution blocks 会重复现有数据并引入混合版本迁移，本问题无需
承担这一成本。未来若要支持文本与媒体交错语义，可以另行定义契约。

## 验证

- shared session-input 测试覆盖组合指令、所有结构化块、原文 spans、解析幂等性、旧输入、
  显式空文本和纯附件。
- 执行测试使用真实 Loro SessionDocument 持久化 turn，让第一次 provider 调用失败，然后
  创建新的执行器，分别经 create、continue 和缺失会话恢复重试。provider 端口收到的请求
  中 Config/Role/任务各出现一次，文件引用和冻结 Role 元数据完整，历史仍是原始输入。
- 现有 steer 交接测试同时验证 provider 端口收到完整指令及 invocation 归属。原有浅层
  文件 builder 调用次数测试已替换为持久化 turn 回归矩阵。
- 仅把 execution service 换回原 HEAD 实现时，continue、restore、steer 回归测试失败，
  create 仍通过。恢复修复后，执行/派发套件 270 项通过，shared input 27 项通过。
  shared 与 CLI 源码类型检查通过。

测试替代了附件 I/O 和 provider transport，没有证明真实模型响应或目录编辑 UI 行为。
断言的是冻结语义输入；运行时上下文和本地附件路径可能变化，因此不要求整个 provider 请求
字节相同。无需迁移 schema 或改写目录。

PR 前 `pnpm format` 和文档检查通过。全仓 `pnpm check` 通过类型检查和 lint，
但在无关的原生 SSH 子模块测试（`github-git-transport.test.ts`）处停止：Lody Git
包装器报 `context_unreadable`，单独重跑亦复现。CLI 共 3512 项通过、1 项失败、
4 项跳过，全仓测试流水线未完整结束。i18n、code-collab、platform 和 public-boundary
检查已单独运行并通过。
