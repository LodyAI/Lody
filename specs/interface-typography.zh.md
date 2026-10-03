# 界面文字角色与全局字号

Status: draft
Translation: current

[English](interface-typography.md)

## 摘要

Appearance 中的字号选择应同步缩放普通界面文字，而不抹平层级或改变字体。
一个文档基准驱动现有正文、控件、辅助与标题角色，包含 portal 弹层。
终端保留独立保存的字号偏好，再乘全局比例。本草案扩展五档设置的作用范围，
不代表该修订已经获得人工批准，也不是 UI 重设计。

## 场景与职责

用户在 Appearance 选择 Smaller、Small、Default、Large、Larger，对应
12、13、14、15、16px。侧栏、Composer 输入和选项、消息、工具输出、代码、终端、
菜单、弹窗、Tooltip 与表单说明同步变化。正文大于控件和辅助文字，标题大于正文，
保留等宽与品牌字体。

设置负责选择、归一化和持久化，文档控制器发布唯一基准，`@lody/ui` 负责现有
文字角色及行高。组件选择角色，不建立第二套字号或父级相对字号。嵌套代码、紧凑
工具正文和 portal 内容不能重复乘缩放比例。

| 角色 | Default 字号 / 行高 | 常见内容 |
| --- | --- | --- |
| caption | 11 / 16px | 元信息、代码语言 |
| footnote | 12 / 16px | 分组、说明、Tooltip |
| subheadline | 13 / 18px | 控件、代码、工具输出 |
| body | 14 / 20px | 侧栏标题、输入、消息正文 |
| headline | 16 / 24px | 弹窗标题 |
| title | 18 / 24px | 页面或 Markdown 主标题 |

字号和行高均为 Default 值乘所选基准再除以 14。独立消息预览显式传入的字号
不受宿主文档基准影响。

目标为支持 CSS length/length 类型除法的现代内核。消息正文、代码、标题和终端输出
均使用此能力，包含显式预览。不新增旧内核回退、polyfill 或平行数值角色尺度。

## 持久化与边界

保留 `lody-conversation-font-size` 及现有归一化：旧 `small/default/large`
分别为 12/14/16；旧数值选最近档，等距向上；非法值使用 14。刷新保留所选档。

保留终端基准字号（9–24px，默认 13）、字体、终端实例和输出缓冲。xterm 的实际
字号为 `保存字号 × 全局基准 / 14`，1.2 倍行高保留为终端专用指标。改变界面档位
不得改写终端偏好。

五档下控件都应容纳中文和拉丁下伸字符。长文本可以换行、滚动或有意省略，但不得
造成意外的整页横向溢出。字号变化保留键盘焦点和关闭行为，验收亮暗主题及窄桌面窗口。

品牌图形、图标几何和第三方文档/画布内容不在范围内。有意设计的 landing 标题、
图表、文件查看器及编辑器 zoom 不属于本次普通文字迁移，不引入新字体或全局间距比例。
设置段落可保留现有比例行高，其字号与行高仍从同一基准派生。

## 证据

- [文字角色](../packages/ui/src/tokens/scales.stylex.ts)、
  [设置控制器](../packages/components/src/components/interface-font-controller.tsx)。
- [跨区域浏览器回归](../packages/components/tests/e2e/interface-typography.spec.ts)、
  [终端行为](../packages/components/tests/local-terminal-panel.test.tsx)。
- [决策与验收边界](../.agents/notes/implemented/simplification/2026-10-03-interface-typography.zh.md)。
