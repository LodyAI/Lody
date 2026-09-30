# DSH 思考可见性与文本交付调查

Status: implemented
Translation: current

[English](2026-09-27-dsh-thought-text-visibility.md)

## 摘要

DSH 显示工具而不显示思考，是因为对话渲染器在构建活动行时移除了思考条目。
本机安装的 DSH 适配器能够转发合成的思考增量，但普通文本要等每条原生助手消息
提交后才发送。这分别属于展示与流式交付行为；适配器并没有限制一轮只能发送最后
一条文本。后续改动仅为内置 DeepSeek Harness 恢复可读思考；文本流式输出仍是独立提案。

## 证据

- [活动分组](../../../../packages/components/src/components/ai-gui/assistant-turn-render-blocks.ts)
  将思考和工具放入同一组。
  [虚拟行构建](../../../../packages/components/src/components/ai-gui/view.tsx)
  中的 `appendBlockRows` 只保留 kind 不为 `think` 的工具调用。纯思考组直接返回，
  混合组即使展开也只遍历工具。本机安装的 renderer bundle 存在同样逻辑。
  `git blame` 将其定位到 `6f2051bcc`（#802），不是 DSH 适配器变更。
- [Provider 翻译层](../../../../packages/acp-extension-dsh/src/adapter.ts)
  转发 `agent/assistant-stream` 的思考增量与分隔符；忽略 `text-delta`，改从持久化
  `assistant/message` 事件发送文本和图片。最终 reasoning block 被有意跳过，
  避免重复发送已经转发的思考。
- 安装的适配器报告版本 `acp-extension-dsh` 0.2.0，使用 Harness 0.1.5-rc.2。
  临时隔离 profile 加载本机适配器和真实 Harness 依赖闭包，用合成 chunk 替换
  `llm/stream`。一个思考增量产生 ACP thought 及分隔符；两个文字增量产生一个
  ACP text。第二个场景加入不存在的合成工具，经过原生工具失败及下一模型步骤，
  工具生命周期前后均收到思考和已提交文本。这些 fixture 未调用模型、执行真实命令，
  也未使用捕获的用户对话。

## 职责与限制

后续改动根据 Session 元数据而非模型名称，仅为内置 DeepSeek Harness 恢复思考行，
并更新[渲染规则](../../../../packages/components/src/components/ai-gui/AGENTS.md)与
[draft Spec](../../../../specs/deepseek-thought-visibility.zh.md)。Provider 开关参与行缓存
身份判断；纯思考组显示展开标签，展开分组保持思考与工具顺序。折叠与删除行是不同操作；展开分组无法恢复根本没有
构建的行。该过滤逻辑不区分 provider。

仅凭这个共享过滤器，不能解释另一个 provider 为什么看起来正常。可见的过程说明
可能属于普通 `text`，与它的 `thought` 条目不同。一个 provider 在工具前输出
commentary，另一个只输出 reasoning 和工具时，前者仍然有可见的过程对话。
应先比较原生 block 类型与持久化 item 类型，再把特定 provider 的现象归因于
共享过滤器。文本流式输出只能改善模型实际输出 text 时的延迟，不能生成原本没有
的过程说明。

普通文本实时输出应单独在 provider 适配器实现，明确处理已提交消息去重、重试、
中断和图片。不能仅凭中间没有 text 就判断传输丢失：原生助手消息可以只有思考和
工具调用。

本调查补充[工具可见性决策](2026-09-24-dsh-tool-visibility.md)，
不改变工具投影契约。后续改动修改共享渲染器，未修改已安装运行时。原生 UI 检查工具超时，
所以渲染结论来自源码及安装包，而不是截图。隔离 ACP 探针验证了 provider 交付，
不代表已经完成端到端 UI 修复。

## 后续验证

在现有行身份测试中增加纯思考输出、可见性与缓存切换、中断后的混合输出，以及
完成回合答案折叠覆盖。完整 Vitest 启动被缺少 `@stylexjs/unplugin` 阻塞；借用的
依赖树也因包缺失或版本不匹配产生类型检查错误，现已移除。隔离执行真实行构建
函数及其真实分组、折叠辅助函数，通过了这些场景；无关的 footer/subagent 服务
使用 stub。此验证范围小于组件测试或桌面视觉验证。

DSH 纯思考组现在默认展开，展开外层已完成活动后也直接显示思考。显式收起的 false
状态仍优先，混合分组维持默认状态。回归覆盖默认展开、收起后重开以及混合分组。
