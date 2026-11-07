# SET-13 补齐工作区 Prompt Shortcuts

[总计划](../2026-10-16-settings-reorganization.md) · [任务索引](../2026-10-16-settings-reorganization.md#任务索引)

| 字段     | 内容                                   |
| -------- | -------------------------------------- |
| 阶段     | 第三阶段                               |
| 优先级   | P2                                     |
| 状态     | 已完成（首版）                         |
| 依赖     | [SET-06](./06-phase-one-acceptance.md) |
| 当前授权 | 已授权按 09 → 13 → 14 → 15 → 16 推进   |

## 目标

提供可复用 Prompt 与提及的工作区管理入口，并和现有本机快捷回复保持清楚边界。

## 当前依据

本机 QuickRepliesProvider 使用原生本地偏好保存 label／message；这不是已验证的工作区 Prompt Shortcuts 同步协议。现有 mentions 可作为消费路径调查起点。

以下是本轮确认的调查入口；开工前重新检查工作树、调用方、导出、fixture 和配置。新增文件及协议以实施时的证据为准。

- `apps/mobile/src/features/settings/quick-replies.tsx`
- `apps/mobile/src/features/settings/quickReplies.ts`
- `apps/mobile/src/screens/QuickRepliesScreen.tsx`
- [packages/cloud-runtime/src/models/mentions.ts](../../../../packages/cloud-runtime/src/models/mentions.ts)
- `apps/mobile/src/screens/SettingsScreen.tsx`

## 工作内容

- [x] 核实 Prompt Shortcuts 的 ID、内容结构、提及展开规则、可见性、权限和持久化协议。
- [x] 决定工作区列表与最小编辑／创建范围；不迁移、不覆盖本机快捷回复数据。
- [x] 明确在聊天／新会话中如何选择和展开，复用实际存在的 composer 与 mentions 边界。
- [x] 在长度、空内容、引用失效、权限变化和冲突处保留输入校验与草稿。

## 验收标准

- [x] 快捷回复与工作区 Prompt Shortcuts 两类数据互不覆盖，切换工作区不会改变本机回复。
- [x] 实际插入／发送内容与所选 shortcut 一致；被撤销访问的提及不能继续展开私有内容。
- [x] 保存失败保留草稿，内容和提及的长度边界有行为检查。

执行总计划的[验证与交付规则](../2026-10-16-settings-reorganization.md#验证与交付)。新分支、错误恢复、权限与持久化逻辑要有小而有效的行为检查；只有静态分组搬迁不新增实现快照。

## 范围边界

不将纯字符串模板冒充支持完整提及语义；改共享 composer 时覆盖每个受影响宿主。

## 关联任务

[SET-02](./02-preferences-page.md) · [SET-11](./11-agent-roles.md) · [SET-20](./20-roadmap-closeout.md)

## 2026-10-17 协议预查

已找到[官方公开客户端契约](https://github.com/LodyAI/Lody/blob/main/packages/cloud-api/src/index.ts)：`promptShortcuts` 提供目录发现、分资源授权、staging、activate、settle 和撤销。正文并不在普通工作区目录中；索引按所有者与 private／workspace 分域，正文使用独立文档授权。不能用现有工作区 grant 读取私有正文。

本地参考源码还确认正文是 Loro 文档，包含 revision ancestry 和原子保存的 prompt／mentions；索引是 Flock。现有纯文本 mention 展开不能直接代替这套语义。下一步先接入原生认证与 scoped grant，再做目录／正文读写、冲突与撤销边界，最后接设置页和聊天消费。首版不迁移本机快捷回复。尚未调用真实云端，也未实现本仓适配。

## 实施记录

- 开始日期：2026-10-17。
- 首版范围：独立的 private／workspace 目录、分资源授权、Loro 正文与 Flock 索引；创建和编辑无上下文依赖的纯文本模板。已有上下文或结构化提及模板可查看，所有者之外不可编辑；本机快捷回复完全独立。
- 发布采用新 body 文档、版本校验和服务端 activate 比较；未知结果只允许当前原稿的手动重试。发送前重新读取目录与正文，撤销权限、版本冲突和重复命令均拒绝展开。
- 消费入口：复用聊天／新会话的命令选择器，使用 `/shortcut:名称`，和 Agent 命令分开。展开为单次替换，模板正文不再作为另一层引用解析；错误通过现有发送边界给出可操作提示。
- 适配来源：官方公开客户端的纯模型、范围、正文和索引校验；保留 AGPL 来源说明，没有引入 `@lody/shared` 根入口或私有后端包。
- 验证：定向协议行为检查通过；Release 签名构建完成。iPhone 英文浅色／深色的入口、空内容校验、只读、失败原稿与完整读回已通过；表单背景差为 13／41。最终统一验收证据关联至总计划。
- 首版限制：移动编辑器最多 16,000 字符；上下文／结构化提及编辑与消费、已有模板可见性迁移、删除及离线自动发布不在此首版内。真实云端读写与 iPad 未验证。
