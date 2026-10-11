# 钉住代理配置下拉的方向并加搜索

Status: implemented
Translation: current

[English](2026-10-02-agent-config-selector-popup-pin.md)

## 摘要

代理配置弹窗里，选项列表比弹窗本身还高的 Select 会整个翻到上方盖住表单：
Devin provider 发布约一百个模型，约 3000px 的列表对着 trigger 上方约
330px、下方约 250px 的空间，Floating UI 的 `bestFit` 翻转于是选了较大的
一侧。现在 `agent-config-dialog.tsx` 的标题生成选择器
（`TitleGenerationFields`）改用 `OptionSelector` 渲染：选项不少于 6 个时
带搜索框，所有弹层钉在 trigger 下方（`side="bottom"`、
`avoidCollisions={false}`），列表高度上限
`min(60vh, 320px, --available-height)`。有意接受的代价：禁掉翻转后，贴
底的 trigger 只会得到一段较矮的可滚动弹层，而不是去占上方的空间——有了
搜索，这样是可用的。

## 证据与决策

在运行中的桌面上用 accessibility 树实测：Model trigger 位于
y=716–748，翻转后的弹层渲染在 y=390–708（318px，即弹窗滚动区全部的
`--available-height`），catalog 共 108 项——远比截图里露出的十来行多。
两侧都装不下这份列表；翻转只是选了较高的一侧，代价是盖住发起它的区域，
并让选中行离指针约 300px 远。

选择 `OptionSelector` 而非 `Menu` + `MenuOptionSearchList` 的组合：它是
settings 各页面已在用的字段形态可搜索控件，会 portal 进最近的
`[data-lody-dialog-content]`（dialog 内菜单的硬性要求），且超过 60 项时
虚拟滚动。搜索阈值复用 `shouldOfferOptionSearch`（≥6），Thinking 这类
短列表的外观与之前完全一致。这与
[composer 模型搜索的决策](2026-09-30-model-search-trigger-anchor.md)同
源：provider 可能发布几十个模型，滚动不是找到它们的办法。

被否掉的替代方案：保留 `Select` 只给 `maxHeight` 加上限，上方更高时依然
会翻上去；Base UI 的 `alignItemWithTrigger`（让选中行落在指针下的原生弹
层形态）按视口 fixed 坐标计算，会被 translate 居中的 dialog 容器重新解
释——这正是本包关掉它的原因；只用 Select 自带的 typeahead 又不可发现。

## 验证与限制

`tsgo --noEmit`、`oxlint`、`oxfmt --check`、`check-i18n` 及
`tests/agent-config-dialog.test.tsx` 的 44 个测试全部通过。
[before](2026-10-02-agent-config-selector-popup-pin.before.png) 与
[after](2026-10-02-agent-config-selector-popup-pin.after.png) 截图由
Playwright 驱动 `EditLongOptionLists` story 产出——before 是把组件改动
stash 后对同一 fixture 拍摄的，因此只有控件不同。未验证：打包应用的实机
观感。`agent-role-form.tsx` 的 `ValueSelect` 用裸 `Select`
渲染同样的 catalog，存在相同的未修复行为——若其观感同样变差，套用同一
修法即可。`@lody/ui` 的 `Select` 仍假设弹层永远从下方升起
（未使用 `hiddenSurfaceForSide`），所以其它被翻转的 `Select` 入场动画方
向仍是反的——本次未动。
