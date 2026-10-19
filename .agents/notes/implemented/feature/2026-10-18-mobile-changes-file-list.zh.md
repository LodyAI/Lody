# 对齐移动端与桌面的变更文件导航

Status: implemented
Translation: current
PR: [#1695](https://github.com/LodyAI/Lody/pull/1695)

[English](2026-10-18-mobile-changes-file-list.md)

## 摘要

桌面点击变更统计会打开分类文件列表，移动端此前直接进入多文件 diff。移动端现在先展示同一套「类型／文件」列表，沿用分类、汇总、未知统计及加载状态。选中文件后携带完整路径集和精确聚焦请求进入全部变更；返回列表时保留列表与已打开 diff 的状态，并暂停隐藏内容的新读取。消息内的具体文件与评论链接继续直接进入目标 diff。本变更位于共享响应式 UI，不增加原生接口或数据协议。

## 流程与职责

```text
变更统计 → 共享「类型／文件」列表 → 选择文件 → 精确聚焦的全部变更 diff
                        ↑                  │
                        └──── 返回 ────────┘
文件／评论链接 ─────────────────────────→ 精确 diff
```

`SessionDetail` 继续拥有数据来源、选中文件、评论定位及请求序号。移动视图记录首次浏览列表、查看 diff，以及 diff 已挂载后的返回列表。选文件会清除旧评论目标并产生新序号，包括重复选择同一文件。现有摘要实时更新保留该视图状态；新会话、轮次或评论导航仍通过原处理器替换目标。

`SessionMobileDiffDrawer` 在一个抽屉中展示两级内容，直接复用 `SessionChangesSidebar`，不复制分类推断、文件树或统计。首次列表不挂载 diff 子树；选文件后保留列表，从而保留分组展开、「类型／文件」模式和滚动位置。返回列表时保留 diff 子树，将隐藏分支设为 inert；调用方传入 `active=false`，由现有视口／请求 owner 暂停新任务。数据 Hook、缓存、请求隔离和完整输入比较不变；纯展示变化不引入 Effect 迁移单元。

两级内容共用一个 modal，避免兄弟抽屉交接。既有[移动 modal 包含关系决策](../bug-fix/2026-10-03-mobile-diff-portal-scope.zh.md)继续拥有 popup host，[文件预览交接](../bug-fix/2026-09-28-mobile-diff-file-handoff.zh.md)保持不变：打开源文件前先关闭 diff。沿用已有本地遥测禁用边界；摘要入口和实际 diff 入口使用对应的既有 sidebar／viewer 事件。

## 验证与限制

导航套件覆盖分类首级、汇总、两种模式下精确路径及完整文件集选择、返回时保留评论输入及列表模式、未知统计、加载／错误状态和直接 diff 入口。既有抽屉套件现在把完整生产 wrapper 放入旧会话 modal，验证首次已打开、点击打开时的指针包含关系、焦点、选择，以及只关闭内层抽屉。现有 diff panel 套件保留精确文件及视口行为覆盖。

Computer Use 在 390×844 视口用合成 provider 数据运行真实抽屉、共享列表及 diff panel，验证分类选择、返回、目录树选择、切到另一个目标 diff，以及中文／深色界面无横向溢出。此浏览器 fixture 不运行完整 `SessionDetail` runtime，也不能验证 iOS／Android 真机手势；设备验收仍是独立步骤。不提交私人截图、会话或捕获的文件内容。

[文件界面文档](../../../docs/sessions-file-surfaces.md)与 [Story 文档](../../../docs/sessions-stories.md)记录当前行为和专用 fixture。41 条针对性测试、根 `pnpm check`（含组件 577 个文件／5,606 条测试）、根 `pnpm format` 与 diff 空白检查通过。docs 检查仅报告 6 个指向未初始化 Kimi/Pi 子模块的现有断链，没有受保护主题变化。
