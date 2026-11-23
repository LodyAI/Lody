# 将会话止血补丁与 writer 重构分开

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/463

[English](2026-09-07-session-validation-hotfix.md)

## 摘要

Mirror 的全状态校验会因无关旧历史中的未知或损坏消息，拒绝合法的新消息。
临时在渲染端和 CLI 的会话构造处关闭 `validateUpdates`，可解除这条写入路径的阻塞，
不改变 writer 或存储。这会撤掉新本地数据的一层运行时保护；不能证明 malformed
写入不可能，也不会修复读取端的兼容问题。

## 决定与范围

- 独立基于 `main@d366a5a6`，不依赖 [#460](https://github.com/LodyAI/Lody/pull/460)。
- 只有两处会话 Mirror 跳过全状态校验，其他 Mirror 和显式外部消息解析器保持原检查。
- 不修改 schema、依赖、历史复制、回滚、持久化或传输；不新增迁移或清理，现有初始化行为不变。
- 不再把 writer 重构作为紧急修复的前置：审查发现 fork 初始化、编辑重发回滚存在待处理的交互。
  #460 单独保留，修复后进行多轮独立审查，覆盖真实订阅者、异步失败和跨版本历史内容。
- 重新启用或替换校验须以局部写入边界通过审查为前提，而非仅等待一两天。
  未更新的旧客户端仍会受原问题影响。

## 证据与限制

合成数据的真实 Loro 测试对照开关前后行为，覆盖实时导入、快照重开、追加、文本更新、
旧容器身份和未知内容的并发修改。构造点测试覆盖两处生产入口并排除其他 Mirror。
显式解析器仍拒绝未知或损坏的新输入。这些测试不覆盖已发布应用、磁盘失败恢复或 3000 轮验收。
见[临时契约](../../../../specs/session-validation-hotfix.zh.md)。
