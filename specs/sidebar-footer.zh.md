# 侧边栏底部入口

Status: draft
Translation: current

[English](sidebar-footer.md)

侧边栏底部从左到右显示三个入口：帮助（`?`）、归档、设置。
帮助菜单依次包含文档、GitHub、社区、反馈和问题报告。
GitHub 在外部浏览器打开 `https://github.com/LodyAI/Lody`；
反馈在外部浏览器打开 `https://github.com/LodyAI/Lody/issues`。
归档通过独立按钮直接打开。
在归档页中，归档按钮返回上一页；没有历史记录时返回首页。
帮助和设置始终可用。共享的桌面和移动侧边栏使用相同顺序。

## 依据

- 实现：[LoroSidebar](../packages/components/src/components/loro-sidebar.tsx)。
- 决策与验证限制：[底部入口记录](../.agents/notes/implemented/feature/2026-09-26-sidebar-footer.zh.md)。
