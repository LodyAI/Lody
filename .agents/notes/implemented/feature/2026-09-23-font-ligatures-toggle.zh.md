# 外观设置的字体连字开关

Status: implemented
Translation: current

[English](2026-09-23-font-ligatures-toggle.md)

## 摘要

外观设置现在在 Terminal 分组后单独一张卡片提供「字体连字」开关，默认开启，
各平台都显示。它写入 `--lody-font-ligatures`，让对话、代码、工具输出共用
同一偏好。没有采用 Ghostty 式 `font-feature` 字符串，也没有放进 Terminal
分组：这不是 OpenType DSL，也不是 Terminal 字体/字号设置。本地 xterm 和
Monaco 保持不变。

## 决策

产品需求是关掉对话代码里 `!=`、`=>`、`===` 的连字。现有外观偏好是本地
Jotai atom 加一条 CSS 变量，布尔值贴合这个形状。自由文本 `font-feature`
需要解析、校验和外观页没有的控件，而且 DOM CSS、Monaco、xterm 也不是同一条
OpenType 通道。

位置是 Terminal 分组后的独立卡片，而不是 Terminal 组内一行。Terminal 字体和
字号只驱动外观页预览和本地 xterm；连字作用面是对话 Markdown 和 DOM 工具输出
卡片。放进 Terminal 组会把所有者说错。Helper 为「应用于对话、代码、工具输出。」
该行不按 Electron 门控：Web 外观和移动端外观同样显示。

控制器把 `contextual` 或 `none` 写到 `--lody-font-ligatures`。原先写死
`font-variant-ligatures: contextual` 的 CSS 改为读这个 token。Monaco 的
`fontLigatures: true` 和 xterm canvas 不在范围内：前者是文件查看器，后者需要
ligatures addon。

## 验证

外观测试断言该行在非 Electron 也可见，有 Terminal 段时位于其后、默认开启、
可以关掉。控制器测试断言各平台都会更新 CSS 变量，且非布尔持久化值保持开启。
未覆盖：打包后的原生应用检查，以及某一具体字体的真实连字 shaping。
