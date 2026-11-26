# 产品设计系统收敛

Status: implemented
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875)

[English](2026-11-07-design-system-convergence.md)

## 摘要

Tailwind 迁移保留了原来生效的样式，其中包括不符合产品设计系统的透明度和表面覆盖。本轮在真实 owner 中采用已有 control、field、popup、card 规范，不再保留这些旧覆盖。禁用透明度收敛到单一默认 owner，同时为此前缺少定义的图像叠层建立成对的媒体对比角色。外观变化属于有意的设计系统收敛，Before／After 仍展示实际差异，不据此把历史迁移差异改判为通过。

## 所有权

| 关注点               | Owner 与合同                                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 禁用控件             | `control.disabledOpacity`，默认 45%。Button、popup 直接读取，field／disclosure／toggle 保留公开家族别名。包括装饰输入文字在内只淡化一次，不叠乘父节点、图标与控件的透明度。                                                |
| 输入                 | 一个 well、一个焦点边缘；bare 输入继承父级拥有的表面。值、placeholder、图标采用已有家族角色。控件采用 13／18 字阶，消息正文采用 body 字阶并保留对话字号偏好。                                                              |
| Composer／消息编辑器 | Card 材质，不画外围 border。Owner 绘制 focus／drop ring，bare 输入在获得焦点时也明确不绘制第二条边，避免叠加应用全局焦点样式。                                                                                             |
| Popup／命令面板      | 外围 Dialog／Popover 拥有层级材质；搜索使用 well，选项及 metadata 使用 popup 角色，不再套第二层表面或自行挑 alpha。                                                                                                        |
| 图像叠层             | 独立的 `media.scrim`／`media.label`：黑色 60% 衬白字，不随主题改变，仅供外部图像上的非交互 caption、进度文字及 scrim。白图上对比度约 5.74:1；普通控件继续使用自身材质。                                                    |
| Mention 覆字         | 原生双背景叠加：实色底，再叠 well 的透明填充。这样能复现实际 well，并完整遮住原字，不对原字再盖一层半透明色。Card owner 清除 overlay，快捷提示表单声明实际 dialog 底色；不再用近似的 5% mix，也不为每个 alpha 新造 token。 |

浏览器工具栏的 URL 与固有宽度连接状态通过 Input 的 trailing 槽共享一个 well 与焦点 owner；ref、原生事件和输入 style callback 仍在真实 input。标注模式采用 pressed Toggle 材料与 accent 标记。草稿、thread 和 peek 使用 popup 角色与标准控件，编辑文字保留 field well。作者色相和共享 review-marker 颜色标识领域数据；pin 位置、视口夹取、anchor 解析、提交与 URL 恢复保持原样。

上下文选择使用现有 Tabs 的轨道与指示器。不可选上下文的帮助／连接入口仍是可用的 ghost Button，不是假装禁用而淡化的 tab；原 tooltip、连接操作与受控选择行为保留。真正禁用的历史记录行读取共享 45% 角色。保留的 `tone` 参数不会在真实主题 owner 之上再建立一套局部 palette。

家族别名在声明位置解析。共享禁用默认值不承诺对子树任意覆写 `control` 就能重新绑定所有家族；既有家族主题 API 保留。产品 palette 发布在 document root，强制 palette 使用既有主题 owner 重新声明依赖的家族 token。

范围包括共享 UI primitive、旧 Sidebar／Command／Emoji／mention owner、Composer 及真实富文本调用方、PR 合并控件，以及已审计的原生禁用控件。保留 refs、handlers、键盘、IME、选择、响应数据的状态及响应式布局。用材质替代装饰 border、采用标准控件字阶或分组按钮 seam 可能改变几何；记录变化，不用 padding 补丁伪装相同。
