# 图片附件组改为换行排列，不再固定两列

Status: implemented
Translation: current

[English](2026-09-15-image-attachment-row-wraps.md)

## 摘要

一个携带大量图片的 turn 此前用固定的 `grid-cols-2` 渲染附件，而缩略图本身是固定尺寸的正方形，于是整组图片变成一座两列高塔：Agent 上传 13 张截图时，在 46rem 宽的会话栏里挤出约 200px 宽、七行高的一列，把它自己的回答顶到一屏半以外。现在改为一行会自动换行的 flex 行，按会话栏的实际宽度铺开，同样 13 张只占三行，正文仍在视野内。缩略图尺寸、cover 裁剪和预览图廊都未改变，改变的只是每行能放几张。

## 决策

- `IMAGE_ATTACHMENT_ROW_CLASS`（`flex w-full flex-wrap gap-2`）是图片附件组唯一的布局，`ImageGroupBubble`（Agent 与用户两侧）以及用户消息里成组的 `image` item 都使用它。不要再引入固定列数：瓦片是固定的，容器不是。
- 对齐方式仍跟随说话者——Agent 左轨用 `justify-start`，用户附件用 `justify-end`——因此少量图片仍读作该说话者的附件，长队列也只有最后一行是参差的。
- 缩略图外框带 `shrink-0`。flex item 会先压缩再换行，缺少它时溢出的那张会被压成非正方形而不是换到下一行。
- 原来的 `max-w-[26rem]` / `max-w-[32rem]` 直接删除而非放宽：网格本就收缩到两个固定瓦片的宽度，这个上限从未生效，却看起来像是刻意设定的尺度。

## 证据

- 问题来自桌面端一次包含 13 张 Agent 上传截图的 turn：该区块只占会话栏约四分之一宽度，却要滚动数屏。
- 在 46rem 会话栏宽度下用 13 张图片渲染该组件（临时 Vite 页面 + Playwright，明暗两套主题）：Agent 的 compact 缩略图每行 6 张，用户的 large 缩略图每行 4 张，而此前都是 2 张。

## 验证

- `pnpm --filter @lody/components typecheck` 通过（需先执行 `pnpm --filter lody prepare:acp-adapters` 以生成 ACP 子模块类型）。
- `pnpm lint:fast` 无 error；两个改动文件均已跑过 Prettier。
- `ImageGroupBubble.stories.tsx` 新增了 13 张图的 Agent 与用户用例。其 fetch mock 也一并修好：原正则匹配 `/api/session-images/…`，而 `getSessionImageDownloadApiPath` 生成的是 `/api/workspaces/<id>/session-images/…`，因此此前每个 story 图片都显示 "Failed to fetch"。
- 未加自动化测试：该布局纯 CSS，jsdom 不计算样式，Vitest 里断言换行只能重新读一遍 class 字符串。
