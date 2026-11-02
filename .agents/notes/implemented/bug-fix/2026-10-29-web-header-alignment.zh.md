# 对齐桌面 Web 工作区顶栏

Status: implemented
Translation: current

[English](2026-10-29-web-header-alignment.md)

## 摘要

桌面 Web 的侧边栏和工作区顶栏起点不同：工作区卡片比侧边栏低 4px。Web 现在复用已有的 macOS 顶栏几何参数，使两侧顶栏共享 y=23 的中心线。移动原生外壳和 Electron 平台标题栏继续使用原有规则；浏览器中的视觉效果仍需验证。

侧边栏使用 2px 顶部内边距；工作区中无下边框和有下边框的顶栏分别使用 6px 和 5px 底部内边距。这将[薄工作区边框决策](2026-10-23-thin-workspace-frame.zh.md)中的几何关系扩展到桌面 Web，无需改动边框或原生窗口控件。
