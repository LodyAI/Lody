# 会话 PDF 查看器操作

Status: implemented
Translation: current

[English](2026-09-29-session-pdf-viewer-controls.md)

## 摘要

会话 PDF 预览在原有 PDF.js 文档视图上增加缩略图导航、旋转、适合页面及百分比缩放、
可展开搜索。实时 Storybook 检查还发现 PDF.js 拒绝相对定位的滚动容器；改为绝对定位后
文档可以渲染。PDF 仍为只读，沿用原有的范围读取和文件操作。Playwright 已验证
Storybook 验收路径；本 worktree 尚未验证真实 Electron 资源 scheme。

## 决策

文档预览负责阅读操作。会话侧边面板继续依据既有平台和文件能力负责打开、显示、下载与
分享。上传按钮意味着替换或写入会话文件，不属于这个只读查看器。这项改动扩展
[本地文件操作 Spec](../../../../specs/local-file-link-actions.zh.md)，不改变文件操作模型。

文档继续使用 PDF.js 分页查看器；缩略图画布仅为侧栏可见行渲染。正文和缩略图的翻页共用
查看器当前页。PDF.js 刷新旋转后的布局时恢复原页；初始缩放仍为适合宽度，侧栏宽度变化时
重新计算适合模式。搜索按需展开，显示匹配数量，关闭时清除高亮。产品布局及 Storybook
容器均使用 StyleX。

此前的 [PDF 预览决策](2026-09-29-session-pdf-preview.zh.md) 负责范围读取、每页 8 百万
像素预算和解析器兼容性。此前的 Storybook 构建验证没有实际挂载 PDF 查看器；实时故事页
因 PDF.js 对绝对定位的要求而失败。Playwright 验收录屏使用相同的四页合成 PDF，分别记录
此前的错误和现在可用的查看器。

## 验证

- `@lody/components` 类型检查通过。
- Playwright Storybook 验收覆盖缩略图跳页、旋转后保持页码、适合页面缩放、搜索结果导航
  与窄面板，均通过。
- 此处尚未验证真实 Electron `lody-resource://` renderer 路径。
