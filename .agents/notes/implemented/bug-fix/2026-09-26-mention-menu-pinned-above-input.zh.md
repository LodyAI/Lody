# Composer 的 mention 菜单固定在输入框上方

Status: implemented
Translation: current

[English](2026-09-26-mention-menu-pinned-above-input.md)

## 摘要

`positionAnchor="composer"` 已经让 `@`/`$`/`/` 菜单锚定到 composer 的
`[data-mention-frame]`，并在每次打开时选一次方向——除非下方空间比上方大，
否则开在上方——但产品要求菜单永远在 composer 上方。现在 `MentionContent` 把
显式传入的 `side` 当作钉住的方向、跳过按空间选边，`MentionTwoLevelMenu` 传入
`side="top"`：菜单再也不可能开到 composer 下方，切换层级仍只在原地改变大小。
代价是刻意为之的：composer 贴着所在层顶部时，菜单被裁剪到上方仅剩的空间，
而不是借用下方的空间。

## 改动

- `MentionContent` 把 composer 锚点菜单上显式传入的 `side` 当作钉值：
  `placedSide` 优先取它而不是测量出的 `lockedSide`，按空间选边的逻辑对该
  菜单不再运行。frame 锚点、`--mention-input-width` 宽度上限、不翻转的锁定
  以及 `maxHeight` 空间上限都不变——被钉住的菜单仍会收缩到那一侧的空间内。
- `MentionTwoLevelMenu` 传入 `side="top"`。此前，当 composer frame 上方的
  空间不足 `COMPOSER_MENU_ROOM_PX`（360px）且下方更大时，菜单会开到
  composer 下方——正是报上来的缺陷。现在每次打开都落在 frame 上方，间距 8px。
- 没有显式 `side` 的 composer 锚点菜单仍按空间选边；默认的 `caret` 锚点
  完全不受影响（目前只有 `file-at-mention` 使用）。

## 考虑过但未采用

- **保留按空间选边。** 只要 `above < 360px` 且 `below > above` 就会开到下方
  ——靠近所在层顶部的 composer 正是被报上来的情况。产品要求的是钉住。
- **在 composer 锚点内部写死 `top`。** 对当前唯一的调用方效果相同，但会
  去掉以后需要下方优先的界面的余地，也把产品决策藏进 primitive 里。调用
  处显式传 prop 更能说明意图。
- **调大 `COMPOSER_MENU_ROOM_PX`。** 移动阈值只能改变哪些局促的 composer
  会开到下方，任何阈值都表达不了“永远”。

## 验证

- `tests/mention-two-level-menu.test.tsx` 的 `composer placement` 新增用例：
  frame 上方 24px、下方 612px——以前会开到下方的布局——在 `side="top"` 下
  菜单保持在上方，上限为 16px（`maxHeight` = 空间 − 间距）。原有的按空间
  选边与锁定方向的用例不变、仍通过。
- `packages/components` mention 相关 vitest 套件、
  `pnpm --filter @lody/components typecheck`、oxlint、oxfmt 干净；
  `pnpm run docs check` 通过。
- 同一修复在此前 `input-top` 实现上用过 Playwright 前后对比截图；rebase 到
  `positionAnchor="composer"` 之后，行为证据是上面这些 jsdom 上限断言。未在
  打包后的 Electron 中验证；移动端停靠条不受影响（它本来就停靠在 composer
  上方）。

## 链接

- 扩展了
  [composer mention menu v2](../feature/2026-09-25-composer-mention-menu-v2.zh.md)
  （“Design review round 2”）中的定位修复：那里引入了 `positionAnchor="composer"`
  和每次打开按空间选边；本改动把 `@` 菜单的方向钉住。
