# 会话 Office 与表格查看器

Status: implemented
Translation: current

[English](2026-09-29-session-office-and-table-viewers.md)

## 摘要

会话文件现可预览新版 DOCX、XLSX、PPTX 文档和 CSV/TSV 表格。Office 查看器
只读；CSV/TSV 保留原有可编辑的“源码”标签。这扩展了[文件操作规范](../../../../specs/local-file-link-actions.zh.md)，
不改变文件身份、授权或系统操作。

## 决定

通用文件查看器入口保持静态。Office 预览激活后才在空闲时安排限额读取，随后只按
当前格式导入渲染器及引擎。非活动面板不加载 Office 引擎或工作线程。Office 读取
上限为 25 MiB，远端 provider 原有的二进制传输上限仍先行适用。DOCX 强制在
工作线程解析，XLSX 使用只读虚拟化网格，PPTX 使用虚拟化幻灯片渲染。
不支持的旧版 Office 格式继续显示二进制提示。产品自有控件均使用 StyleX；
PPTX 引擎自带的样式表由引擎负责。

CSV/TSV 在可终止的工作线程中解析和搜索。表格限制行、列、单元格及保留的
搜索结果数量，并对网格双轴虚拟化。原有源码编辑器不被替换。终止工作线程及
中止检查避免隐藏面板或切换文件后显示过期内容。

这是先前静态查看器规则的有限例外：文件入口保持静态，较大的第三方 Office 引擎
只按需加载。PDF 专属设计见此前的[PDF 控件笔记](2026-09-29-session-pdf-viewer-controls.zh.md)。

## 验证

- Storybook 中的合成 DOCX、XLSX、PPTX 和 CSV 样例已在浏览器渲染。
- Playwright 验收覆盖渲染、控件、搜索，以及不请求引擎或工作线程的非活动
  Office 与 CSV 面板。
- 此 worktree 尚未验证本机 Electron 资源协议的实际渲染。
