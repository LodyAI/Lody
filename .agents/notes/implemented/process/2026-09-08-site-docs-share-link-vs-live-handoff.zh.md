# Site-docs：分享链接 vs 现场交接

Status: implemented
Translation: current

[English](2026-09-08-site-docs-share-link-vs-live-handoff.md) | 中文

## 摘要

搜索和销售对话常把「分享会话」当成一件事，于是截图、对话记录或分享链接很容易被误当成同事加入了现场编程 Agent 会话。操作步骤已经写在 `/docs/session-handoff`；这次新增仅给爬虫看的对比页 `/docs/compare/share-link-vs-live-handoff`，专门钉定义，步骤和 ACL 链回交接页，并输出 FAQ / `llms.txt` 答案。标题用类别，不用竞品名。这一页不进文档侧边栏，Features 仍留给产品指南。

## 问题

`session-handoff.mdx` 的对比表已经提到 Lore 和 SpecStory。那一页是权限和操作的 SSOT。再往上堆定义会把步骤埋掉；用竞品当 URL 标题又会在对方改名或日后提供真正现场加入时失效。GEO 问题（「分享链接算不算交接？」）仍需要能链到当前英文文档路径的答案块。

## 决定

- 新增 `content/docs/{en,zh}/compare/share-link-vs-live-handoff.mdx`。不要把 `compare` 写进根或 Features `meta.json`，这样侧边栏看不到它，sitemap / 搜索 / `llms.txt` 仍会发出 `/docs/compare/share-link-vs-live-handoff`。
- 访问规则与 `session-handoff.mdx` 完全一致：工作空间成员、机器共享、本地项目共享，以及「复制 URL ≠ Share with team…」。不发明公开分享链接 ACL。
- Lore 和 SpecStory 只作为「分享链接 / 归档」类别的一行例子。H1 和文档标题不用竞品名。不加评测，也不声称替代。
- 从交接、团队、并行、复制对话和既有交接 blog 链到对比页。在 `llms-answers.mjs` 增加专问，并在原有交接答案里加上链接。

未采用：放进 Features 侧边栏；用 `lody-vs-lore` 当标题或 slug；只放 blog；在对比页重写完整四步操作。

## 限制

分享链接产品的细节仅限于 Lody 现有文档已经写过的内容，加上它们公开的分享 / 文档 URL。若某个具名例子日后提供真正的现场会话加入，应修订表格那一行，而不是硬撑。同批对比 PR 会共享 `generate-llms.mjs` 的 extras 列举和 `llms-answers.mjs`，合并顺序需要对这两处 rebase。
