# UI 迁移合并残留

Status: implemented
Translation: current

[English](2026-09-21-ui-merge-residue.md)

## 摘要

UI 迁移分支在八个组件文件中保留了冲突标记，较新的调用方也仍引用该分支已删除的基础组件。
本次修复根据当前业务代码解决冲突，把所有剩余调用方迁移到现有 `@lody/ui` 契约，并删除已无
调用方的 Select 和 Toggle 模块。修复保留业务流程和既有 token 选择；同步五个过期的 ACP
子模块指针后，整个仓库的类型检查恢复通过，构建使用的 Codex 托管运行时版本也重新一致。

## 解决方式

遵循 [Button 迁移决策](../architecture/2026-09-08-ui-button-migration-takeover.md)：保留当前业务
行为，使用新组件契约，不增加旧 API 适配层。保留项目删除 hooks 和对话框、EmojiField 与
FormMessage、共享图片导出器、原生 Slider 和移动端 Spinner；丢弃旧的 Emoji picker、图片
导出器及 Tasks 开关导入。

共享 UI 入口直接导出现有 v2 基础组件，不再引用已删除的本地文件。其余 Button、字段、反馈、
Avatar、折叠、Select、Checkbox 和 Drawer 调用方直接使用 v2 契约。Select root 声明自身的
items，并显式拒绝不可能出现的 `null` 选择，不再用类型断言掩盖它。Radix Select 和 Toggle
的调用方归零后，删除对应的孤立实现。

CLI 已经使用当前 `main` 中存在的 ACP capability，但该分支仍固定在较旧的 ACP adapter
revision。其中 `acp-extension-codex` 依赖 Codex 0.153.4，而锁文件和托管运行时清单要求
0.154.0；`acp-extension-claude` 依赖 0.3.258 SDK，而运行时清单要求 0.3.274。将 Claude、
Codex、core、DSH 和 Grok 五个 gitlink 与 `origin/main` 对齐后，CLI 所需声明与单版本运行时
契约恢复，无需修改 CLI 本身。

现有 package manifest 已声明 v2 UI workspace 依赖和 StyleX 构建插件，但锁文件早于这些声明。
重新生成锁文件后，冻结安装恢复。components 的 Vitest 配置也接入与应用构建相同的 StyleX
transform，因此导入 v2 基础组件的测试不再需要临时配置。Storybook 的 preview 管线同样通过
`@stylexjs/unplugin` 应用该包的 `stylex-options.ts`；缺少它时 preview 入口会原样执行
`@lody/ui` 的 `.stylex.ts` 源码，`stylex.defineVars` 在模块求值阶段抛错，所有 story 渲染为
空白根节点且不显示任何错误。

通过指针打开 Base UI Select 时，DOM focus 留在 trigger 上，但选中行已进入 highlighted 状态。
因此 trigger 会把每次方向键都当作首次进入列表，Home/End 也无法到达列表导航。v2 trigger
现在会在方向键导航前把 focus 交给已 highlighted 的行，并在 Home/End 时直接聚焦首个或末个
可用行。

Node 26 在未配置 storage file 时会暴露不可用的存储 getter，而 jsdom 不提供 `PointerEvent`。
测试环境现在会按需提供确定性的浏览器边界；存储失败测试直接监听当前 storage 对象，不再假设
其 prototype。已随产品开关删除过期的 Tasks beta-gate 测试，分享复选框断言也改为遵循 v2
组件的 `aria-checked="mixed"` 契约。大文件分页标签已补入中英文语言目录。

## 验证

- 组件源码中不再存在冲突标记或已删除 UI 模块的导入。
- `pnpm --filter @lody/ui typecheck` 通过。
- `pnpm --filter @lody/components typecheck` 通过，剩余错误为零。
- 更新 ACP gitlink 后，根工作区 `pnpm typecheck` 通过。
- `pnpm build` 完成 CLI 和 Electron 生产构建。
- `@lody/ui` 的 274 项测试全部通过，包括 Select 从指针切换到键盘的导航。
- 现有消息选择套件使用仓库内 components Vitest 配置通过四项行为测试。
- components 套件的 479 个文件、3,775 项测试全部通过；code-review-helper 的 34 项测试和
  Electron 的 150 项测试全部通过。
- 国际化、Code Collab 导入、平台边界和公共仓库边界检查全部通过。

无需修改 package manifest：Radix 错误来自孤立的源码模块，依赖图缺失来自陈旧锁文件，ACP
不匹配来自过期 gitlink。现有
[UI 基础组件 Spec](../../../../specs/ui-primitives.md) 不变，因为本次恢复预期导入和契约，
不改变设计意图。
