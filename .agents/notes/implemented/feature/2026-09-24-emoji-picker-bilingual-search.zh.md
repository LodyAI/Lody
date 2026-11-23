# Emoji 选择器支持双语搜索

Status: implemented
Translation: current

[English](2026-09-24-emoji-picker-bilingual-search.md)

## 摘要

Agent Role 的 emoji 选择器只加载一个跟随产品语言的 emojibase 数据集，而
frimousse 只在该数据集的 `label` 和 `tags` 里搜索——所以中文界面输
"magnifying" 搜不到 🔍，英文界面输 "放大镜" 也搜不到。现在负责分发内嵌
数据集的 Vite 插件会把其余每个打包语言的 `label` 和 `tags` 按 `hexcode`
合并进每个 emoji 的 `tags`，一次查询用任一种产品语言都能命中，而显示名
称和分类标题仍保持界面语言。一个真实限制：frimousse 对整个查询串做一次
`includes`，所以一句话里混两种语言（"放 glass"）仍然搜不到——"任一语言"
可行，"双语混搜"不行。

## 决策

- `vite-emojibase-assets.ts` 不再原样拷贝 `data.json`：对每个打包语言，
  读取全部打包语言的数据，把其他语言的 `label` + `tags`（去重后）按
  `hexcode` 追加进每个 emoji 的 `tags`。`label` 和 `messages.json` 不动，
  界面语言保持原样。
- 其他语言的 `label` 是显式并入的，不只是 `tags`：emojibase 的 tags 不
  一定包含 label 的词（英文 tag "magnify" 并不包含查询词 "magnifying"）。
- 资产契约从 `{ fileName, sourcePath }` 改为 `{ fileName, read() }`，让
  生成的 JSON 和原样文件（`messages.json`）在 `emitFile` 和 dev
  middleware 里走同一条路径；合并结果做了 memoize，dev 请求和构建共用
  一次生成。
- 排序影响可接受甚至更符合预期：外语命中按 tag 计 +1，本语言 `label`
  命中 +10，本语言结果仍然排在前面。

## 考虑过但未采用的方案

- 运行时加载两套 locale：frimousse 0.3.0 只接受单个 `locale` 且自行
  fetch 两个 JSON，没有注入数据或自定义搜索的钩子，运行时合并只能 fork。
- 等待上游支持多语言数据集：上游没有该能力，连独立的 shortcodes 数据集
  都没加载（liveblocks/frimousse#2、#9），短期不会出现。
- 保持原样拷贝、另维护一份查询别名表：否决——手写词表会和 emojibase
  漂移，而合并复用的是已经随包发布的数据。

## 验证

- `tests/emojibase-assets.test.ts` 现在按 frimousse 的真实匹配方式（对
  `label` 和 `tags` 做小写 `includes`）断言生成结果：zh 数据集能命中
  "magnifying"，en 数据集能命中 "放大镜"，且 `1F50D` 在 zh 里 `label`
  仍是中文、在 en 里仍是英文——证明只有 `tags` 被合并。
- `NODE_ENV=test vitest run tests/emojibase-assets.test.ts`：5 个测试通过；
  `tsgo --noEmit`、`oxfmt --check`、`oxlint` 在改动文件上均无告警。
- 开销有界：每个语言的合并只在构建/dev 服务时跑一次；实测输出 zh 843 KB、
  en 860 KB（原样约 750 KB），搜索仍是每次按键对每个 emoji 做若干短串
  `includes`。

## 局限

- 整条查询一次 `includes`，单句混合双语的查询（"放 glass"）匹配不到；
  支持它需要 frimousse 不具备的按词匹配。
- 只有打包的语言（`en`、`zh`）参与；映射到 `en` 的其他产品语言仍无法用
  该语言搜索。
