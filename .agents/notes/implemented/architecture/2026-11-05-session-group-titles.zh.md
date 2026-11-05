# 将对话组的侧边栏标题与第一个 tab 解耦

Status: implemented
Translation: current

[English](2026-11-05-session-group-titles.md)

## 摘要

过去根 Session 的 `title` 同时充当侧边栏行和第一个 tab 的名字，改其中一个就会连带改另一个。现在根 meta 增加独立的 `groupTitle`/`groupTitleSource` 作为侧边栏标题，每个 tab（包括根 tab）保留各自的 `title`。根 tab 第一次生成的标题只会复制到组标题一次，此后两者只通过各自的改名变化。没有 `groupTitle` 的 Session 继续显示根标题，因此无需迁移，只写 `title` 的旧客户端也能正常显示。

## 决策

- `SessionMeta.groupTitle` 只存在于根 Session。代表整个对话组的读取方（侧边栏行、命令面板、Home、移动端列表、窗口标题）使用 `getSessionGroupTitle`，缺省回退到根 `title`。tab 栏、提及和单个对话的界面继续读 `title`。
- 生成的标题经由 `SessionDocument.setTitleIfSourceIn` 与 `resolveGeneratedGroupTitleUpdate` 进入组标题：组标题是草稿时复制；或组没有标题且根 tab 接受了这次生成写入时复制。两个字段在同一次 meta upsert 中写入。已是 `generated` 或 `user` 的组标题不会被自动替换，因此之后 agent 推送的标题只改 tab。
- 用户给尚无组标题的根 tab 改名时，先把组标题冻结为根当前的标题和来源（`buildSessionTabRenamePatch`）。没有这一步，回退逻辑会让已有 Session 的侧边栏再次跟随 tab。
- 侧边栏改名只写 `groupTitle`（`buildSessionGroupRenamePatch`）。MCP `lody_session_rename{,_many}` 与 `lody session rename` 默认改 tab，用 `scope: 'group'` / `--group` 改侧边栏；子 Session 拒绝 group 范围。

## 备选方案

- 随着新增 tab 重新生成组标题：owner 否决，组名一旦确定应保持稳定。
- 一次性迁移，为所有现有根 Session 写入 `groupTitle`：未采用。它会打开或改写每个历史 Session 的 meta，而读取回退加首次改名时冻结已能得到相同的可见结果。

## 影响

- 早于此字段的旧桌面端或 daemon 只改 `title`。对没有组标题的根 Session，这仍会通过回退改到侧边栏行，与旧行为一致。
- 如果用户在第一次标题生成完成前就给根 tab 改名，组标题会以 `draft` 来源冻结为草稿标题，之后生成的标题仍会替换它一次。

## 验证

- `apps/cli/src/lib/loro/doc-title.test.ts`：只复制一次、提前改名后的草稿组标题、旧的用户标题、子 Session。
- `packages/components/tests/use-session-actions.test.ts`：在真实 Loro repo 上 tab 与组改名互不影响。
- `apps/cli/src/mcp/lody-mcp-server.test.ts`：MCP 的 tab/group 范围及子 Session 拒绝。
- 未验证：运行中桌面应用的 UI，以及混合版本副本。
