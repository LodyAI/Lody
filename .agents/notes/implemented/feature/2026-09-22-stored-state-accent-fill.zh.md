# 存储态改用 accent 填充

Status: implemented
Translation: current

[English](2026-09-22-stored-state-accent-fill.md)

## 摘要

勾选类控件——Checkbox、Radio、Switch——现在用调色板的 accent 色填充，不再是墨色。
[choice controls note](2026-09-10-ui-choice-controls.md) 当初把存储态定为 `label`
填充上加 `background` 标记，把 `accent` 留给 focus ring 这类活态。视觉评审更倾向彩色
填充：存储值正是眼睛应该找到的状态，而墨色开关读起来像一个凸起的黑按钮而不是开态。
一个 token `field.checkedFill` 把整个家族的存储填充从 `colors.label` 换到
`colors.accent`；上面的标记仍是 `colors.background`，顶部高光仍是 ink edge。Vesper
调色板里 `accent` 是暖色，所以勾选控件在那边是橙色而非蓝色——存储态跟随调色板，
这是设计使然。

## 决策

`checkedFill` 在该组声明调色板值 token 的两处都重新声明：`field` 定义和
`fieldPaletteTheme`，保证强制调色板子树拿到 accent 而不是根调色板的值。`Toggle` 的
对比不变——按下的 toggle 仍沉入 well 而不是填充，因为它无所依凭；AGENTS 规则现在
写作 "on is the well, not the accent"。`specs/ui-primitives.md`（draft）已更新：存储值
相关段落和证据链接改为 accent 填充的表述。

## 取舍与限制

墨色与 accent 不再区分存储态和活态——accent 现在同时表示 focus ring 和存储值。标记
和 ink edge 高光不变，勾选框在 accent 填充上保留凸起观感。已在 token 看板两套调色板
下验证：Lody Light 是蓝填充，Vesper 是暖橙。没有测试断言渲染颜色。
