# 编辑导入的记忆档案

Status: implemented
Translation: current

[English](2026-10-05-memory-provider-profile-editing.md)

## 摘要

仅修改本地名称会使导入记录与 Provider 档案不一致。根据用户要求，编辑表单现在通过
适配器修改 Nowledge Mem，再将返回的显示元数据保存到 Lody。身份 ID 保持不变，
名称、描述和角色与创建表单使用相同字段。Provider 失败时不会宣称本地保存成功；
Provider 成功但本地写入失败无法原子回滚，会显示保存错误。

## 决策与证据

此决策替代[关联目录记录](2026-10-05-memory-association-catalog.zh.md)中仅修改本地
元数据的约定。删除仍仅移除 Lody 导入记录。
[draft Spec](../../../../specs/agent-role-memory.zh.md)描述当前行为。

类型化更新请求使用精确机器和 Provider 路由。Daemon 通过独立参数调用
nmem agents set，空的可编辑值会清空对应字段，隐藏的 Space 与来源字段不传递，
保持原值。编辑器只从库存初始化一次，刷新不会覆盖用户输入。
仅在成功取得更新后的列表时将显示元数据写入现有 Flock 记录。

机器 Tab 复用 Agents 的在线状态圆点，默认选择本机并将本机排在首位。
记忆列表的灰度 logo 位于文字前方并垂直居中。组件和 CLI 类型检查通过。
按用户要求未运行测试。实现：[PR #1246](https://github.com/LodyAI/Lody/pull/1246)。
