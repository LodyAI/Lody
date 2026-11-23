# `Dialog.Content` 增加 `width` prop;单独的 `max-w-*` 无法加宽面板

Status: implemented
Translation: current

[English](2026-09-25-dialog-content-width-prop.md)

## 摘要

`@lody/ui` 迁移把对话框面板从「流式宽度 + `max-w-lg` 封顶」改成了固定的
`width: 512px` StyleX 声明。所有只靠 `max-w-{xl,2xl,3xl,4xl}` 类、没有写
`width` 的对话框都被静默钳回 512px —— `max-width` 只能收窄固定宽度,不能抬高
它。`@lody/ui` 的 `ModalContentProps`(`Dialog.Content` 与
`AlertDialog.Content` 共用的 props 类型)现在暴露 `width`,落到 inline
`style` 上;所有需要非默认宽度的面板统一走它。产品层 adapter 原样透传。
cmdk 面板的 512px 是重构后的有意设计,保持不变。

## 坑在哪

`@lody/ui` 的 `modal.popup` 声明了 `width: dialog.width`(512px)和
`maxWidth: calc(100vw - 32px)`。三种覆盖写法效果不同:

- 单独 `max-w-2xl`:`max-width` 只能封顶,面板停在 512px —— 本次回归。
- `w-[…]` 类:今天能生效只是因为 `tailwind/index.css` 声明了
  `@layer …, stylex, …, utilities`,把 utilities 排在组件样式表之后。可靠但
  隐晦,而且覆盖 `max-w-*` 会把 rung 自带的 `100vw - 32px` 视口封顶一起换掉。
- 第二个 StyleX `width` 类:与面板自身声明同层,谁赢由样式表顺序决定 ——
  `settings/surface.ts` 里已有同样结论的注释。

`width` → inline `style` 绕开这三条:inline style 永远生效,且不触碰面板的
`max-width`,窄视口下视口封顶依旧生效。`desktop-settings-modal` 的 `style`
对象(除宽度外还设了 height/padding/gap)保留在 `style`;prop 只管宽度这一个
旋钮。

## 改动

- `packages/ui`:`ModalContentProps` 增加 `width`;`dialog/parts.tsx` 的
  `mergePanelWidth` 把它合进 popup 的 `style`,调用方传对象或状态回调两种
  形式都兼容(Base UI 两种都允许)。`components/src/ui/dialog.tsx` 的产品
  adapter 原样透传;`Drawer` 保留自己的 props 类型 —— drawer 的横向尺寸是
  `drawerSize`,是另一个旋钮。`test/dialog.test.tsx` 钉住了 inline-style
  契约。
- 恢复宽度:composer 粘贴预览 48rem、用量分享图 56rem、文件快速打开 42rem、
  机器配对 36rem、operation 回复 42rem。
- 现存混用写法统一收口到 prop:`chat-failed-detail`、`session-file-preview`
  (`w-[calc(100vw-2rem)] max-w-*` → `width="42rem"`/`"48rem"`)、
  `chat-share-image`、`update-changelog`(`style={{width}}` → prop)、
  `open-source-attributions`(`style` 常量 → `width="1024px"`)、
  `skill-detail`(`width`+`maxWidth` 组合 → `width="768px"`)。
- `SETTINGS_EDITOR_DIALOG_LAYOUT` 拆分:`SETTINGS_EDITOR_DIALOG_WIDTH`
  (`620px`)走 prop,类只保留高度上限。
- 「单独的 `max-w-*` 只能收窄、不能放宽」这条防线写在 adapter 的 docblock
  里,不在 `components/src/ui/AGENTS.md`:该文件已达 8168 字节,紧贴 8192
  上限,一个字都加不进去。

## 证据与边界

层叠事实均从源码核实:`tailwind/index.css` 的层顺序、`settings/surface.ts`
里 `w-[620px]` 的先例注释、`modal.popup` 的固定 `width` token。桌面端行为宽度
与迁移前 `max-w-*` 值一致,窄视口行为反而更稳(rung 自带封顶替代手写的
`100vw - 2rem`)。尚未执行:`tsgo`/`oxlint`(此 nested checkout 未装依赖)与
各对话框的实机视觉确认。
