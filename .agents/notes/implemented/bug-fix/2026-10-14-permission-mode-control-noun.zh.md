# 让 composer 控件报出它解析到的真名，让共享行报出开关的动作

Status: implemented
Translation: current

[English](2026-10-14-permission-mode-control-noun.md)

## 摘要

两处相邻标签描述的是 Lody 的内部抽象，而不是控件本身或其动作。composer 的权限按钮把一切解析结果都叫 "Permission"，于是 Grok 风格的模式列表在 Agent/Plan/Ask 上显示 "Permission: Agent"；设置 > 机器里文件夹共享行把状态词 "Private" 放在一个关闭的开关旁边，读起来像 "Private: off"，与机器行的动作式标签 "Share machine" 不一致。共享的 face 解析器现在会报告控件到底是真 `_permission` 选项还是模式选择器，各界面因此命名为 "Mode"（或 provider 自己的标签）；可编辑的共享行改用与机器行一致的常量动作标签。验证受限于这个嵌套 checkout 的过期依赖，所属 vitest 套件在此无法运行。

## 问题与证据

用户对线上 UI 的反馈提出两个标签语法问题：

- **"Permission: Agent" tooltip。** `DesktopPermissionModeButton` 把
  `chat.runConfig.permissionLabel` 名词硬编码进 `aria-label`/`title`
  （`desktop-run-config-menu.tsx`）。`resolvePermissionModeFace`
  （`lib/permission-mode-face.ts`）刻意把三种来源解析成同一个控件 —— 显式
  `_permission`/`permission_mode` 配置项、旧版 ACP `modeOptions`、或顶替的
  `category: 'mode'` selector —— 但只有第一种是真正的权限旋钮。把 Agent/Plan/Ask
  这类会话模式暴露出来的 registry/custom agent 会走模式来源到达该按钮，名词因此错误。
  Grok 自己的 `interaction_mode` selector 永远到不了这个控件（它在 run-config 菜单里
  渲染为单独一行），builtin Grok 也暴露真的 `permission_mode`，所以误标主要影响
  非 builtin 或探测到的 agent。
- **机器页开关语法。** `machine-detail-pane.tsx` 把开关标为 "Share machine"（动作），
  而 `my-machine-connected-resources.tsx` 在开关旁打印状态词 "Shared"/"Private"，开关的
  checked 同样是 `sharedWithTeam`。极性其实一致；不一致的是一个标签说动作、另一个说
  当前状态，"Private" + 关闭读起来有歧义。

## 修复

- `PermissionModeFace` 新增 `semantics: 'permission' | 'mode'`
  （`Boolean(explicitPermissionSelector)`）和 `selectorLabel`（config selector 自己的
  名字）。`source.kind === 'configOption'` 单独无法区分真 permission selector 和顶包
  mode selector，所以解析器把它已经算出的判别值返回出来。
- `permissionModeControlLabel(face, t)` 是唯一的名词规则：permission 语义用
  `Permission`，否则用 provider 的 `selectorLabel` 或经新增
  `chat.runConfig.modeLabel` key 的 `Mode`（en "Mode" / zh "模式"）。
- 消费方：桌面按钮的 aria-label/title、移动端 run-config 表单的行标签、Agent Role
  详情面板行、以及仅 story 使用的 `AcpBottomBarModeSelector` 的 aria/title。移动
  表单里重复的 permission 解析逻辑整体换成 `resolvePermissionModeFace` —— lib 的
  契约本来就要求这些界面对"哪个旋钮承载权限"不漂移，而它已漂移出第四份拷贝。
- 机器页文件夹行：可编辑行显示常量 `workspace.projects.shareToggle`
  （"Share project with team"，已有译文，与移动端项目设置行一致）+ 开关；
  `Shared`/`Private` 状态词只留在不提供控件的 `readOnly` 渲染里。机器行本来就是
  动作式标签，未改。

## 备选与取舍

- 两行都用状态语法（机器行也 "Private"/"Shared" + 开关）被否：它把同样的"状态词 +
  关闭开关"歧义对称地保留下来，还丢掉了机器行更清楚的动作提示。
- 两处都换 `Private | Shared` 分段控件能彻底消除开关歧义，但放弃 `Switch` 原语、
  行更宽；若动作标签仍读不清，留作备选。
- permission 语义也用 `selectorLabel` 作名词（"Permission Mode: Always Approve"）
  被否，保留既定的短名词。

## 验证

`pnpm lint:i18n` 通过新 key。`pnpm format` 已应用。受影响的测试文件已扩展：模式
来源断言 "Mode: Agent"（此前为 "Permission: Agent"），新增用例把 "Permission" 锁定
为仅显式 `_permission` selector 使用，并让 mode-category 顶包 selector 以 provider
标签命名。

验证限制：此嵌套 checkout 的 workspace 依赖早于 Effect v4 迁移（`packages/shared`
仍链接 `effect@3.18.4`），vitest 套件在此无法运行 —— 所有 import `@lody/shared` 的
测试文件都在 `Context.Service` 处失败。限定范围的 `pnpm install` 同样受阻：
`acp-extension-devin` 子模块未检出，而 `--no-frozen-lockfile` 会触发仓库
`minimumReleaseAge` 对较新 lockfile 版本的限制，该限制不得放宽。
`pnpm --filter @lody/components typecheck` 仅在 `../shared` 陈旧依赖文件处失败，
改动文件无错误。`pnpm run docs check` 报告指向未检出子模块路径的既有断链，与本次
改动无关。因此行为验证依赖代码审查与更新后的测试源码；合并前请在独立 checkout 中
运行所属测试套件。
