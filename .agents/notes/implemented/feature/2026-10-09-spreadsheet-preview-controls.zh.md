# 表格预览控件

Status: implemented
Translation: current

[English](2026-10-09-spreadsheet-preview-controls.md)

## 摘要

CSV、TSV 和 XLSX 现在支持调整列宽及复制单元格或矩形选区，不保存文件。
现有渲染器、工作线程和虚拟化保持不变。小型 XLSX 复制适配层绕过已安装引擎的
工作线程剪贴板缺陷。复制保留显示值与矩形结构，通过明确上限而非静默截断约束工作量。

CSV/TSV 管理预览列宽及支持边缘滚动的指针、Shift、键盘选区，尺寸变化后重新测量
虚拟轴。XLSX 保留引擎选区并启用 `allowResizeInReadOnly`，也允许只在预览中调整行高。
react-xlsx 0.16.5 的工作线程加载会清空 `getClipboardData` 依赖的主线程工作簿。
适配层使用公开的 `getRowsBatchAsync`，保留格式化值、缓存公式值及合并非主格的空值。
禁用工作线程或解析第二份工作簿会增加主线程成本，因此未采用。

复制输出转义的 HTML 表格与带引号的 TSV，上限为 200,000 格及 10 Mi 字符。
XLSX 分批整行读取另设一百万格上限。剪贴板写入在用户操作内开始，以 Promise 提供
数据；取消防止被替换的预览发布过期内容。任何控件均不调用文件保存。参见
[先前查看器决策](2026-09-29-session-office-and-table-viewers.zh.md)及
[文件链接规范草稿](../../../../specs/local-file-link-actions.zh.md)。

聚焦测试扩展已有剪贴板与 Office 验收覆盖；Storybook 不验证本地 Electron 资源协议。
