# 从持久化历史中丢弃工具图片

Status: implemented
Translation: current
PR: [LodyAI/Lody#1456](https://github.com/LodyAI/Lody/pull/1456)

[English](2026-10-11-drop-tool-images-from-history.md)

## 摘要

普通 ACP 工具可能把图片数据和内嵌图片 blob resource 写入会话历史，而会话附件已经使用引用。
共享历史投影现在直接丢弃这些工具图片块，不再为其上传附件。根工具、导入历史和规范化子工具
共用图片过滤规则，并保留各自原有的非图片内容策略。已有存量历史和 provider 执行输出保持不变。

## 决策与边界

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
