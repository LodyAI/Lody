# DeepSeek Harness 思考可见性

Status: draft
Translation: current

[English](deepseek-thought-visibility.md)

## 行为

内置 DeepSeek Harness 对话将思考放在独立、默认展开的分组中，将工具放在独立、
默认收起的分组中，保持原有顺序。保留用户手动开合，搜索可展开匹配的思考。
工具加入时不得收起前面的思考。输出过程中正文保持可见；完成后，共用的已完成过程
折叠将之前的思考、工具和中间正文整体收起，保留最终回答尾部。用户可再次展开
整个过程，搜索也会展开匹配的已折叠正文。中断且没有最终回答时保持展开。这些规则同时适用于新输出和已保存的历史。

思考保留其标识和存储类型；渲染不把思考转换成普通助手正文，也不重写历史。
Provider 身份由 Session 元数据判断，不按模型名称判断。其他 Provider 保留原有的
可见性和折叠行为，包括通过其他 Provider 使用 DeepSeek 模型的情况。

## 证据

- [对话渲染](../packages/components/src/components/ai-gui/view.tsx)
- [行行为测试](../packages/components/tests/chat-virtual-rows-identity.test.ts)
- [调查记录](../.agents/notes/implemented/bug-fix/2026-09-27-dsh-thought-text-visibility.zh.md)
