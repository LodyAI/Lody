# Lody 子 agent 事件

Status: draft
Translation: current

[English](subagent-events.md)

Agent 委派任务后，用户应能看到子 agent 的状态，以及 provider 实际提供的执行细节。
没有文本通道的运行中任务，不应显示得像流式输出故障。本草案描述目标契约；
首轮实现仅接入 Codex，等待用户实测，不承诺所有 provider 都有相同输出能力。

## 职责与传输

共享类型和校验由 `acp-extension-core` 所有；provider 扩展转换原生事件，
宿主负责路由、持久化和渲染，不在业务代码里判断 provider 名称或解析私有载荷。

使用扩展通知 `_lody/subagents/event`。外层 `sessionId` 始终是根 ACP
会话，兼容连接的归属边界；`runId` 标识子执行。过程内容复用 ACP 的文本、工具和
富内容载荷，不重新定义这些格式。

双方 initialize 均声明 `_meta.lody.subagentEvents: { version: 1 }` 后启用。
它与现有 Core `subagents` v1 分开，保留其 list/output/cancel 方法和生命周期
metadata 的兼容性。没有双向协商时使用原有 provider 路径；已协商的同一执行只发
一份规范化生命周期和内容，不再向父对话重复发送旧任务行或原生子会话输出。

这个载体有明确取舍：新增一个 Core 扩展，但避免让每个 Lody 消费者分别实现 ACP
草案和 xAI 不同的子会话协议。扩展仍可为其他客户端保留原生协议。

## Schema

以下概括 Core 中已编译的契约。`AcpOutput` 表示下列现有 ACP 联合类型
成员，保留原字段及校验，不是任意 JSON。

```ts
import type { SessionNotification } from '@agentclientprotocol/sdk';

type SubagentState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

type SubagentSupport = {
  stream: Array<'text' | 'thought' | 'tool' | 'plan'>;
  progress: boolean;
  outputRead: 'none' | 'live_tail' | 'final_tail';
  cancel: boolean;
};

type SubagentSnapshot = {
  state: SubagentState;
  // null = direct child of root; absent = lineage not yet established.
  parentRunId?: string | null;
  parentToolCallId?: string;
  name?: string;
  description?: string;
  modelId?: string;
  startedAtEpochSeconds?: number;
  endedAtEpochSeconds?: number;
  summary?: string;
  outputIncomplete?: true;
  reason?: { code: 'error' | 'timeout' | 'cancelled' | 'disconnected' | 'lost'; message?: string };
  support: SubagentSupport;
};

type SubagentProgress = {
  summary?: string | null;
  lastToolName?: string | null;
  toolsUsed?: string[] | null;
  durationMs?: number | null;
  turnCount?: number | null;
  toolCallCount?: number | null;
  errorCount?: number | null;
  totalTokens?: number | null;
  contextTokens?: number | null;
  contextWindowTokens?: number | null;
  contextUsagePercent?: number | null;
};

// Existing ACP variants: agent_message_chunk, agent_thought_chunk,
// tool_call, tool_call_update, plan. Preserve content blocks and tool fields.
type AcpOutput = Extract<
  SessionNotification['update'],
  {
    sessionUpdate:
      'agent_message_chunk' | 'agent_thought_chunk' | 'tool_call' | 'tool_call_update' | 'plan';
  }
>;

type SubagentEvent = {
  version: 1;
  sessionId: string;
  runId: string;
} & (
  | { type: 'snapshot'; snapshot: SubagentSnapshot }
  | { type: 'progress'; progress: SubagentProgress }
  | { type: 'output'; update: AcpOutput; nativeTurnId?: string; messageId?: string }
);
```

`AcpOutput` 是封闭的 ACP 判别联合。
权限、提问、根配置、标题和计费通知不属于输出类型。

### 语义

- `snapshot` 完整替换任务已知 metadata，在发现任务和实质变更（包括结束）时发送。
  扩展先合并原生稀疏事实再发快照；未知字段保持缺失。恢复时首次发现已结束的任务，
  可以直接发终态，不伪造运行阶段。
- `progress` 是当前绝对观测值的稀疏更新：缺失表示保留，null 表示清空。
  计数非负，不是增量；context 占用可在压缩后下降。累计消耗 token 与 context
  token 分开，不把缺失指标补成零。
- `output` 保持 ACP 语义：文本/思考追加，工具按 `(runId, toolCallId)` 合并，
  plan 替换该执行的计划。可用的 message/turn ID 属于子执行，不能代替宿主根
  turn 的归属，也不授予 native fork 能力。
- 只有 completed、failed、cancelled 是终态。unknown 表示失去观测，不证明
  进程停止。确认执行超时失败才记 failed；仅监控超时记 unknown。取消 RPC 的
  ACK 也不证明任务已经取消。
- 进度 token 只用于展示；计费继续以现有 Core usage 为唯一入口，不能再次累加。

## 身份、顺序、恢复与存储

`runId` 是根 ACP 会话范围内的不透明执行身份，不等同于可复用的 agent/thread ID。
终态子 agent 重启或重新激活获得新 run ID；有证据的活跃执行续接保留 ID。
扩展负责原生身份映射，恢复时只有原生证据或持久映射才能复用 ID，否则旧观测记为
unknown，不把新执行并入旧执行。映射持久化是后续实现工作，并非现有扩展的保证。

事件按 ACP 连接的投递顺序处理。Envelope 不包含流身份或序号，不承诺事件重投、
去重或缺口检测。断连时将受影响的观测标为不完整；重连不代表已经补齐遗漏内容，
也不授权重跑任务。不自动把输出回放到实时追加路径，恢复需要独立的历史对账契约。

扩展先发 snapshot，再发该执行的进度和内容；原生竞态采用有界缓冲。
无法归属的事件不能混入父输出。终态之前排空此前内容，终态之后忽略该执行迟到内容。
嵌套关系检查循环与跨根引用；未解析的父身份保持未知，待后续快照纠正。

宿主在首次将执行绑定到发起它的父工具/turn 时捕获归属，不在 flush 时读取当前 turn。
无法确认归属时保持待解析/不完整，不随意挂靠。父 prompt 返回不代表子执行完成。
保留各 provider 现有 prompt 完成契约，本提案不新增后台调度器。

接收的任务状态和内容通过现有 SessionMirror / HistoryWriter 唯一写入者保存。
建议在所属 Lody 会话内建模每个 run 的 transcript；原生孙 agent 可以在其中嵌套，
不额外创建 Lody 子 Session，也不改变其一层创建规则。可选的 `subagent_task.run`
保存根 `sessionId`、快照、最新进度和 items，`taskId` 为 run ID；子文本与思考使用
流式 CRDT 文本，不额外设置 transcript 保留上限。不持久化每次心跳：保存有意义的状态和进度，批量写内容；
有界投递丢弃内容时显式标记不完整/截断。输出查询是独立有界快照，重复查询的尾部
不能直接追加到增量 transcript。
扩展通过 `snapshot.outputIncomplete: true` 报告已知内容丢失，此标记在该 run 内
不可撤销。宿主在断连时也标记受影响执行不完整。没有此标记，不证明开始
观测之前的原生历史已经完整恢复。

## 控制与上线

保留已有 list/output/cancel RPC，扩展内部解析 run ID 对应的原生 task ID，
不能假定它们字符串相同。启用规范 run 控制前，Core 需要向后兼容的 run 寻址字段，
与旧 taskId 互斥；output 响应需要明确可用性/截断 metadata。Codex 首轮不提供
单个 run 取消，也不提供输出补拉。

权限与问题仍是请求/响应交互。对支持它们的 provider，将子请求映射到根 ACP 连接及
经过校验的 run 归属，复用宿主已有授权机制。工具事件不代表授权；未知子请求不能
默认转给父会话；不为 Pi 子 agent 打开 questionnaire 或嵌套启动能力。
只有当前执行支持时才提供取消，不回退为取消父任务。

首轮包含 Core、宿主路由、唯一写入者持久化、UI 和随应用构建的 Codex 扩展。
宿主与扩展双方协商后才使用新载体。Daemon 声明 `subagentEvents` v1 控制新实时
UI 消费者，离线仍可阅读已存 transcript。旧历史不重写；其他扩展及所需的托管包
发布等待 Codex 实测通过后再进行。

重点审阅：是否接受 Core envelope，而非宿主直接消费原生子会话；是否接受一个 Lody
会话内的多 run transcript；是否接受按真实能力降级，而不承诺所有 provider 输出一致。

## 证据与验证限制

Provider 事件清单与理由见
[提案 Note](../.agents/notes/proposed/architecture/2026-09-26-subagent-events.zh.md)。
Codex 合成测试覆盖路由、授权、嵌套/复用执行、终态竞态和跨轮次持久化，真实
provider 验证仍待完成。首版存储保留文本、思考、工具和计划；非文本消息块会将
执行标为不完整，不假装已经保存。工具内容保留。UI 显示最新行动，并在弹窗中
展示全部已保存历史。本草案尚无链接的正式批准。
