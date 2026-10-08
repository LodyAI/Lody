# 文档内嵌真实产品预览

Status: proposed
Translation: current
Language: [English](2026-10-06-docs-embedded-product-previews.md)

## 摘要

文档截图比它描述的产品界面老化得更快。本变更先在 `components/docs-replica/` 下为会话页
和 GitHub 页新增站点自有、仅用于展示的预览组件，随后把中英文 Feature List / reference
文档中的每一张截图都替换为已注册预览。预览使用合成 mock 数据，跟随读者语言与明暗主题，
并注册在 `components/mdx.tsx`。其 `.lody-app-preview` token 作用域对齐产品当前运行时的
Lody Light 与 Vesper deep-sea 调色板（含 VS Code alias 与 `@lody/ui` 产品映射），因此
静态副本不再停留在旧 Tailwind 默认值。浏览器和 iOS 通知属于外部界面，以站点自有的视觉
副本呈现，而不是 Lody 组件。副本拷贝产品 markup，而不是直接引用产品组件，所以仍可能
漂移，产品外观明显变化时需要重新拷贝。

## 问题

- 文档图片是静态的，容易过期。会话列表截图已经不正确：它展示多行行内分支和
  diff，而产品现在渲染单行，并把这些信息移到会话详情悬停卡中。
- GitHub 页还在使用旧版主页输入框截图，和当前仓库/分支选择器不一致。
- 截图无法跟随读者的明暗主题，深色图片可能出现在浅色文档页里。
- 每次界面变化都需要重新截图、提交位图资源，漏掉一次就会静默发布错误界面。
- Feature List / reference 文档在每种语言中重复了 19 处图片引用：对话 diff 与文件、
  mention 与斜杠命令、图像输入/输出、Browser 预览、Agent 配置与 CLI 运行时、
  Fast/Goal/Ask 卡片、配额与 token 用量，以及浏览器和移动端通知界面。
- 站点不能直接引用产品组件：独立副本规则和 `scripts/app-boundary.mjs` 会把
  产品专用模块、provider 和包挡在公开构建之外。

## 决策

- 新增 `components/docs-replica/session-list-preview.tsx` 和
  `components/docs-replica/github-repo-picker-preview.tsx`，分别从产品当前的会话
  列表和输入框选择器 markup 拷贝，做成仅展示的副本。二者都只接受 `locale`，自行
  构造合成内容，不引用任何产品代码。
- 用现有的 `.lody-app-preview` token 作用域渲染，使其跟随站点明暗主题。该作用域保持
  与产品运行时输出一致：浅色值来自解析后的 `lody-light` 调色板，深色值来自解析后的
  `vesper` deep-sea 调色板，并包含 VS Code alias 与 `@lody/ui` 产品调色板映射。
- 在 `components/mdx.tsx` 中注册为 `SessionListPreview` 和
  `GithubRepoPickerPreview`，替换中英文会话页和 GitHub 页里的 `<img>`，并删除两个
  不再使用的资源。
- 只按静态页面能呈现的状态建模：当前单行会话行加旁边的会话详情卡，以及当前仓库和
  分支选择器加一个输入框盒子。会话卡包含仓库、工作树分支、机器、PR 状态、CI 结论
  和 ±行数；输入框预览包含仓库、分支、占位文案、运行配置和权限范围。
- 将同一模式扩展到 Feature List / reference 的全部截图：新增
  `components/docs-replica/conversation-reference-previews.tsx`、
  `command-reference-previews.tsx`、`runtime-reference-previews.tsx` 和
  `settings-reference-previews.tsx`，每个界面都以当前产品组件和对应 Storybook
  story 作为拷贝来源。
- 已有 landing replica 与当前组件一致时直接复用（`ReplicaDiffViewer`、
  `ReplicaChangesList`、composer controls、`ReplicaBrowserToolbar`）；只补文件树、
  mention/斜杠弹层、图片气泡、Agent 配置、配额和用量等缺失的展示 markup。
- 替换中英文 `(reference)` 树里的全部 `_docs-assets` 图片引用。浏览器权限和 iOS
  通知预览明确是站点自有的外部界面模拟，不引用产品组件。
- 保留归档与删除截图；它们仍然相符，不在 Feature List 范围内。

## 考虑过的替代方案

1. 保留截图并重新截取。否决：下一次界面变化会再次带来同样的漂移和主题不一致。
2. 像早前落地页那样，通过 shim 引用真实产品组件。否决：这正是独立副本记录要
   移除的耦合；`scripts/app-boundary.mjs` 会因此让构建失败，产品 hook 或
   provider 也会让文档页面空白。
3. 做成带真实悬停行为和展开菜单的交互副本。暂不采用：静态图示让预渲染 HTML 保持
   确定性，无障碍面也更小。后续文档页确有需要时再加交互。
4. 在出现第二个用例前先做通用预览框架。否决：第二个预览复用了同一套 token 作用域
   和 landing-replica 原语，没有引入新机制；等第三个界面出现时再抽公共脚手架。
5. 通过 Storybook/Playwright 截取真实产品组件，或嵌入静态 Storybook 构建。否决：
   截取结果仍是会漂移的位图；Storybook 服务需要完整的产品 provider 与工具链；
   iframe 或静态 Storybook 会让文档内容依赖 JavaScript，而不是保留在预渲染 HTML 中。

## 验证与边界

- `pnpm --filter @lody/site-docs generate`、`typecheck` 和 `test` 通过；测试包含
  `scripts/app-boundary.test.mjs` 的 3 个子测试。`node scripts/docs/main.mjs check`
  报告 0 errors 和原有的 64 个 warnings。
- 生产构建预渲染 257 个 HTML 文件。中英文 Feature List 页面包含预览 markup，
  `(reference)` 树中不再引用任何 `_docs-assets` 图片。
- 新预览已在静态渲染页面中按中英文、明暗主题、桌面和移动宽度做过目视检查；
  `.lody-app-preview` 调色板也已刷新到当前 Lody Light/Vesper 运行时颜色并再次
  检查两种主题。
- 全量静态浏览器套件报告 309 个通过用例，以及变更前后相同的两个移动端
  `no-js navigation` 基线超时。
- 副本拷贝的是某一时刻的 markup，不会自动跟随产品变化。对应界面明显变化时需要重新
  拷贝，并同步更新周边文档正文。
- Feature List 界面已全部转换，但浏览器与 iOS 通知预览只能模拟外部界面，并非 Lody
  组件。`(reference)` 之外的文档截图（changelog、guides、core concepts）仍在，可以按
  界面逐个转换。
