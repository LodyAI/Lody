# 消息作者身份

Status: draft
Translation: current

[English](message-author-identity.md)

## 场景

Agent A 通过 Lody MCP 向 Agent B 委派提示时，B 的会话显示 A 为发送者。
A 使用 Role 时，其 emoji 和名称优先于 Agent 名称。B 的回复署名 B，后续
B 向 C 发送消息也署名 B；原始人类用户始终是授权主体。

## 契约

- 会话 `role` 描述输入/输出/系统语义；`userId` 保留人类授权和归属，新增可选、
  带版本的 `author` 描述消息生成者。Agent 发给 B 的提示仍是 user-role 输入。
- 来源作者冻结 Session/Turn、Agent Config、名称、图标/品牌标识、可选 Role 的
  id/revision/名称/emoji，以及白名单模型/运行摘要。区分运行时实际模型和配置选择；
  不记录启动环境、提示词、凭据、任意配置字典或头像图片字节。
- MCP 从确切的活跃调用和对应助手快照取得作者；旧活跃运行可以使用其冻结输入配置
  与本地元数据。工具参数不能指定作者。人类权限、机器访问、链深度限制和接收方配置不变。
- Operation 接受时原子冻结来源作者和目标 Role 展示。create/chat、批量与恢复路径
  传递这些值。Role 删除或改名不改变已接受快照。可选扩展存储兼容旧 Operation 严格
  读取器；旧执行器仍可能生成没有作者元数据的旧式消息。
- Composer 提交逐轮冻结已选 Role 展示。显式 None 清除 Role 展示，不能用会话创建
  来源标记所有后续轮次。未指定执行覆盖的 CLI/MCP 续聊继承目标选择，显式覆盖清除 Role 标记。
- 助手轮次打开时捕获自己的作者，重新打开时保留。A 的身份不能成为 B 的助手身份。
  Operation 完成信封保持系统身份，不冒充某个批量成员。
- 单人工作区也显示 Role 名称。Agent 输入显示 Agent/Role 头像，助手正文保持全宽，
  不展示作者身份入口或其弹窗。输入消息的身份详情展示来源模型配置和来源会话导航，不打开人类联系人卡片。
  渲染不读取目录或来源文档。
- 人类编辑/重发产生新的人类署名输入。存储复制、fork 和结构化历史导出保留作者元数据。
  旧历史保持可读，不主动回填或重写，也不根据标题、父子关系或当前目录猜测缺失身份。

## 性能与兼容

元数据有界，仅在提交、执行打开或 Operation 接受时写入。流式文本更新不解析或重写身份。
目录查询使用本地状态，不进入 token 处理，也不新增产品云请求。存储随消息轮次数量增长，
不随 token 分块增长。尚未进行设备帧耗时和大型历史内存基准测试。

## 证据

- [共享作者契约](../packages/shared/src/message-author.ts)
- [MCP 捕获](../apps/cli/src/mcp/lody-mcp-server.ts)
- [Operation 扩展存储](../apps/cli/src/orchestration/operation-store.ts)
- [运行时捕获](../apps/cli/src/session/message-author.ts)
- [展示组件](../packages/components/src/components/ai-gui/message-author-identity.tsx)

Role 未设置 emoji 时保留名称并使用来源 provider logo，不生成机器人 emoji。缺少 provider 信息时显示 Agent 名称首字，不猜测 provider；明确设置的 Role emoji 保持优先。
