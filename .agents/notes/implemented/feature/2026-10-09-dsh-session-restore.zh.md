# DSH 原生 ACP 会话恢复

Status: implemented
Translation: current

Provider PR: [acp-extension-dsh #28](https://github.com/LodyAI/acp-extension-dsh/pull/28)

[English](2026-10-09-dsh-session-restore.md)

## 摘要

DSH 此前提供 fork，却没有 load/resume，宿主恢复时因此回退为带文字历史的新原生会话。
适配器现已使用固定版 Harness 0.1.5-rc.2 的 `agents.resume` 事务，并声明两种 ACP
能力。Load 回放根历史，resume 不回放。真实存储探针验证了跨进程保持原身份和后续模型
上下文；历史子代理回放仍不在范围内。

## 决策与证据

本变更扩展[分叉决策](2026-10-06-dsh-session-fork.zh.md)，其中排除 load/resume 的表述
描述的是当时的范围。无需升级 Harness，也无需修改宿主回退逻辑。
[恢复 Spec](../../../../specs/deepseek-harness-session-restore.zh.md) 保持 draft，不声称
获得人类批准。

原生工厂在未发布的 setup 前取得写入所有权并修复未结束日志。因此在 setup 内读取重建
后的会话，避免恢复前查询过期快照。保留 cwd 和身份，拒绝子代理激活，重建 preset／模型
及请求中的 MCP；恢复及回放成功后才发布。失败时释放原生句柄和 MCP 名称预留。即使后续
setup 失败，Harness 恢复仍可能已追加修复事件。

原生事件被投影为根消息／工具／标题，不会作为新 prompt 发送给模型。Resume 跳过显示
回放及历史附件读取。两种路径都静默重建统计，后续用量增量排除重建基线。模型切换原先在
写入 request header 前只存在适配器内存中；现在初始选择以及模型／推理变化通过原生
`model/selection` 事件落盘。Profile revision 升至 v16，以刷新能力缓存。

## 验证与限制

- 适配器构建及 45 项单元测试通过，覆盖原 ID 续聊、顺序回放、静默 resume、存储的模型
  选择、cwd／缺失会话／子代理拒绝、重复激活、setup 名称预留清理及缺图后的恢复。
- 原生探针使用独立进程、固定版发布包、合成模型／preset 和临时状态。普通 JSONL 与 zstd
  均通过创建、冷 load、未结束尾部修复、后续模型上下文、冷 resume，以及累计／仅新增用量检查。
- 既有完整 settings/profile 探针还检查 close/load 后的模型和权限选择。未访问真实模型服务
  或用户会话数据。
- 嵌套 checkout 缺少 workspace 依赖（`rimraf`），不能完成根桌面构建；根 docs check 也会
  报告指向其他未初始化子模块的缺失链接。提交前 `pnpm check` 和 `pnpm format` 也因缺少
  workspace 依赖／Oxfmt 受阻。不声称完成整桌面打包、真实远程模型、历史子代理
  回放或真实安装中的附件生命周期验证。
