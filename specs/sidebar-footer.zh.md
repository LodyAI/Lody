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

桌面端的 workspace 控件与三个操作按钮统一为 28px 高，垂直中心对齐。
操作按钮的点击区域为正方形，图标为 16px；workspace 头像保持 20px。
底栏上下各留 4px，所有相邻控件之间统一间隔 4px，包括 workspace 与帮助按钮。
长名称省略，不增加行高；
同步中的 workspace 与本地静态身份保持相同尺寸。workspace 菜单向上打开。
悬停和键盘焦点使用共享 ghost 按钮样式，归档打开时标识当前页面。
移动端保持 48px 操作按钮与 20px 图标，workspace 身份继续位于侧栏顶部。

## 依据

- 实现：[LoroSidebar](../packages/components/src/components/loro-sidebar.tsx)。
- 决策与验证限制：[底部入口记录](../.agents/notes/implemented/feature/2026-09-26-sidebar-footer.zh.md)。
- 控件尺寸：[紧凑底栏记录](../.agents/notes/implemented/feature/2026-10-04-sidebar-footer-density.zh.md)。
