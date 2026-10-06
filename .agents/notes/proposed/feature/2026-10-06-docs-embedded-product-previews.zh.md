# 文档内嵌真实产品预览

Status: proposed
Translation: current
Language: [English](2026-10-06-docs-embedded-product-previews.md)

## 摘要

文档截图比它描述的产品界面老化得更快：会话页仍在用旧版多行会话列表截图，GitHub
页仍在用旧版主页输入框截图，而这两个界面早已改版。本变更在
`components/docs-replica/` 下新增站点自有、仅用于展示的预览组件，用合成 mock 数据在
两种语言和明暗主题下渲染，在文档 MDX 组件中注册 `SessionListPreview` 和
`GithubRepoPickerPreview`，并替换过期截图；归档和删除截图仍然相符，因此保留。副本是
拷贝的产品 markup，而不是直接引用产品组件，所以仍可能漂移，产品外观明显变化时需要
重新拷贝。

## 问题

- 文档图片是静态的，容易过期。会话列表截图已经不正确：它展示多行行内分支和
  diff，而产品现在渲染单行，并把这些信息移到会话详情悬停卡中。
- GitHub 页还在使用旧版主页输入框截图，和当前仓库/分支选择器不一致。
- 截图无法跟随读者的明暗主题，深色图片可能出现在浅色文档页里。
- 每次界面变化都需要重新截图、提交位图资源，漏掉一次就会静默发布错误界面。
- 站点不能直接引用产品组件：独立副本规则和 `scripts/app-boundary.mjs` 会把
  产品专用模块、provider 和包挡在公开构建之外。

## 决策

- 新增 `components/docs-replica/session-list-preview.tsx` 和
  `components/docs-replica/github-repo-picker-preview.tsx`，分别从产品当前的会话
  列表和输入框选择器 markup 拷贝，做成仅展示的副本。二者都只接受 `locale`，自行
  构造合成内容，不引用任何产品代码。
- 用现有的 `.lody-app-preview` token 作用域渲染，使其跟随站点明暗主题。
- 在 `components/mdx.tsx` 中注册为 `SessionListPreview` 和
  `GithubRepoPickerPreview`，替换中英文会话页和 GitHub 页里的 `<img>`，并删除两个
  不再使用的资源。
- 只按静态页面能呈现的状态建模：当前单行会话行加旁边的会话详情卡，以及当前仓库和
  分支选择器加一个输入框盒子。会话卡包含仓库、工作树分支、机器、PR 状态、CI 结论
  和 ±行数；输入框预览包含仓库、分支、占位文案、运行配置和权限范围。
- 保留归档与删除截图；它们仍然相符，不在本次范围内。

## 考虑过的替代方案

1. 保留截图并重新截取。否决：下一次界面变化会再次带来同样的漂移和主题不一致。
2. 像早前落地页那样，通过 shim 引用真实产品组件。否决：这正是独立副本记录要
   移除的耦合；`scripts/app-boundary.mjs` 会因此让构建失败，产品 hook 或
   provider 也会让文档页面空白。
3. 做成带真实悬停行为和展开菜单的交互副本。暂不采用：静态图示让预渲染 HTML 保持
   确定性，无障碍面也更小。后续文档页确有需要时再加交互。
4. 在出现第二个用例前先做通用预览框架。否决：第二个预览复用了同一套 token 作用域
   和 landing-replica 原语，没有引入新机制；等第三个界面出现时再抽公共脚手架。

## 验证与边界

- `pnpm --filter @lody/site-docs generate`、`typecheck` 和 `test` 通过，其中包含
  `scripts/app-boundary.mjs`。
- 生产构建预渲染所有已发布页面。中英文会话页和 GitHub 页的预渲染 HTML 中存在预览
  markup，两个被删除的截图资源已不存在。
- 两个预览都已在中英文、明暗主题、桌面和移动宽度下做过目视检查。
- 全量静态浏览器套件报告 307 个通过用例（删除两个 VS Code 主题页面前为 309 个），以及
  变更前后相同的两个移动端 `no-js navigation` 基线超时。
- 副本拷贝的是某一时刻的 markup，不会自动跟随产品变化。对应界面明显变化时需要重新
  拷贝，并同步更新周边文档正文。
- 本次转换了两个界面。其他文档截图（归档、删除、Agent 配置、diff 等）仍在，可以按
  界面逐个转换。
