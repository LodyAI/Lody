# 从持久化历史中丢弃工具图片

Status: implemented
Translation: current
PR: [LodyAI/Lody#1456](https://github.com/LodyAI/Lody/pull/1456)
Follow-up PR: [LodyAI/Lody#1473](https://github.com/LodyAI/Lody/pull/1473)
Correction Issue: [LodyAI/Lody#1723](https://github.com/LodyAI/Lody/issues/1723)
Correction PR: [LodyAI/Lody#1724](https://github.com/LodyAI/Lody/pull/1724)

[English](2026-10-11-drop-tool-images-from-history.md)

## 摘要

普通 ACP 工具可能把图片数据和内嵌图片 blob resource 写入会话历史，而会话附件已经使用引用。
最初的共享历史投影直接丢弃工具图片，不再上传附件；后续清空非图片 resource 中未使用的
blob 字节，保留下载引用，并移除子工具重复的 raw 副本。音频、可读输出、完整 diff、审批计划
以及权限和调度 metadata 保留。权限补全不改写已有内容，非法新输入仍进入 writer 校验。
这是针对未使用数据的清理，不是通用二进制大小上限。
后续修正对子工具数组输出的可读副本应用同一图片规则；此前子代理读取的图片会以文本形式
写入历史。

## 最初的图片决策（#1456）

```text
根工具 / 回放 → 根内容投影 ─┐
                           ├→ 丢弃工具图片 → HistoryWriter
规范化子工具 → 子内容投影 ──┘
```

`packages/shared/src/acp/tool-call-history.ts` 负责图片移除：丢弃所有 ACP image 块，以及
通过图片 MIME 类型或图片 data URI 识别的 blob resource。保留 resource link、文本 resource
和其他媒体。子投影只使用图片过滤器，保留读取结果和 diff，不套用根工具的终端压缩规则。
省略 content 时保留原列表；只包含图片的替换列表变为空列表。

没有选择为每张工具图片上传附件，因为这些执行产物无需在会话中持久保留。仅过滤根通知不够：
外部历史导入复用根 reducer，规范化子工具则使用独立投影。本改动不检查任意 raw 字段，也不
重写旧记录；未变更的不透明数据继续遵循[单一写入者决策](../architecture/2026-09-07-single-history-writer.zh.md)。
已有 R2 图片和 image-group 附件与工具内容相互独立。

## 验证

行为覆盖通过真实 Loro HistoryWriter 检查根与子输出、稀疏更新和仅图片列表替换，并将过滤后的
历史复制到 fork。导入覆盖使用共享回放入口。测试数据均为合成数据；本改动不迁移已有历史，
也不改变 provider schema。

## 后续：二进制与重复载荷

工具详情通过 URI 下载非图片资源，不读取 blob 字节。因此只清空 blob 字符串，保留资源
类型、MIME、annotations 和 URI。data URI 已被 UI 的 URL 策略拒绝，清空这个未使用的 URL，
保留链接标签或资源文本。音频有播放器，raw 输出有 JSON 或文本视图，diff 展示完整新旧文本：
这些属于已使用的数据，全部保留。

子工具 raw 输入保留计划审批读取的 `plan`；其余新输入以及无消费者的标量或数组输入副本
不保存。标量或数组 raw 输出只保留一份可读内容，不存入 `_meta.lody.subagentRaw`。
保留普通 raw 输出对象、metadata 以及根调度和权限字段。省略字段的更新保留原值，存量历史
不批量迁移。

本次清理撤回通用大小预算和 base64 猜测，因为它们会删除可见输出，也可能损坏权限 metadata。
早期投影静默丢弃非法新 locations，并重新解析旧内容，导致 5 个 CLI CI 回归暴露校验和兼容性
问题。现在仅转换已确认未使用的资源字段，不重新做 schema 解析。权限补全直接复用已有
content 列表；writer 继续原子拒绝非法新字段，且允许随后提交合法请求。

真实 Loro、fork 和回放测试检查 blob 字节移除，以及资源引用、音频、长文本、完整 diff 和
审批计划保留。CLI 批处理和权限 writer 套件覆盖非法通知隔离、原子拒绝与旧容器身份。
普通会话附件和 provider 执行输出保持不变。音频、可见或不透明输出仍可能很大；改为引用
需要另行设计并保留现有消费者。

## 修正：子工具数组输出中的图片

上一次后续改动把子工具的标量或数组 raw 输出保存为一个可读文本块，但数组可能就是工具结果
本身。Claude 转发子代理 `Read` 图片的结果时，形如
`[{ type: 'image', source: { type: 'base64', … } }]`；序列化成文本块后，图片绕过了只匹配
图片块的过滤。根历史不受影响，因为那里不保存读取输出。在已报告的会话（#1723）中，子代理
反复查看幻灯片截图，使会话文档增长到 502 MB，随后快照上传返回 HTTP 413。

现在生成可读副本之前，数组输出会按内容块的同一图片规则（图片条目，或以图片 MIME 类型或
data URI 标识的 blob resource）去掉匹配项；只含图片的数组不再保留副本。其他条目和标量输出
不变。这延续了此前不使用 base64 猜测和大小上限的取舍。对象形式的 raw 输出仍按原样保存，
存量历史不迁移，已经膨胀的文档仍会超限。

真实 Loro HistoryWriter 测试通过子事件发送混合数组和纯图片数组（Claude 结果格式）：修改前
两者都被原样保存；修改后图片都不会进入文档，文本条目保留。
