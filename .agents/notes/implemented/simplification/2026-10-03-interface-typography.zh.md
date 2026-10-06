# 界面文字共用一个字号基准

Status: implemented
Translation: current

PR: [#1221](https://github.com/LodyAI/Lody/pull/1221)

[English](2026-10-03-interface-typography.md)

## 摘要

Appearance 原本已经改变消息正文和文档基准，但固定的 primitive token、嵌套 `em`
及取整公式使其他文字遵循不同缩放比例。现在复用 `@lody/ui` 现有文字角色，从同一
基准派生字号及行高，组件只选角色，不增设 token 家族。保留五档选择和旧偏好迁移，
终端独立保存的字号只在渲染时乘全局比例。浏览器与隔离 OSS 桌面验证覆盖修改边界，
不代表所有原生平台均已验收。

## 决策

扩展[五档交互](2026-09-19-conversation-font-size-tiers.zh.md)，替换
[消息字号比例](2026-09-14-conversation-font-size-scale.zh.md)中独立的输出公式。
当前意图见[界面文字 Spec](../../../../specs/interface-typography.zh.md)，状态为 draft，
并未标记人工批准。

`InterfaceFontController` 继续向文档发布 `--ui-font-size`；现有 StyleX `text`
token 表达 `Default 指标 × 基准 / 14`，保留默认名义值。portal 读取同一个文档比例。
未采用后代 `em` 缩放，因为紧凑工具正文、表格和嵌套代码会重复乘比例，portal 也会
脱离父级比例。

侧栏导航、项目/会话标题和输入框选 body；分组和说明选 footnote；Composer 控件、紧凑工具正文、
代码和工具输出选 subheadline；Markdown 标题使用现有标题角色及配套行高。
消息角色适配器先消去文档比例再应用请求的字号，也保留独立 Markdown 预览的显式
字号语义，不拥有第二套角色映射。

删除 settings 的 caption/title 字号别名，调用点机械改为共享 token；Chat/工具的
元信息与状态标签也选择相同角色，不再用固定 px 或 Tailwind 字号覆盖。删除未使用的
mono/compact helper 和被覆盖的输出行高。Popover 的 StyleX 类数量测试、仅检查
字号 style 对象的测试由真实浏览器指标和终端状态回归替代，保留既有交互覆盖。
没有新增 primitive、token 家族或泛化字体框架。

xterm 实际字号为 `终端保存字号 × 全局基准 / 14`。沿用原地更新字体和 refit，
保留实例、选中输出、字体和保存的基准偏好；原生设置中的终端预览使用相同计算。

## 保留的例外

不重做字体家族、品牌/landing 标题、头像字母、图标、间距或控件几何。设置段落保留比例行高，
xterm 保留 1.2 倍行高，
单行按钮保留居中指标。引用 chip 仍相对正文，但不嵌套紧凑容器。第三方图表、文档
查看器、编辑器 zoom 和独立任务正文编辑器不在普通文字迁移范围。

消息角色适配器对普通消息正文、代码、标题和终端输出使用 CSS length/length 类型
除法，并非仅独立预览。目标宿主必须实现这一现代 CSS 能力，固定 Electron 43 与
已测 Chromium 145 支持。[MDN 兼容性数据](https://github.com/mdn/browser-compat-data/blob/main/css/types/calc.json)
声明 Chrome 140+、Safari 26+，Firefox 当前不支持。按已确认的现代内核目标，不提供
旧内核回退、polyfill 或平行数值尺度。不支持此能力的内核不在目标内，而非未验收的
受支持配置。

## 验证与删除对照

合成 `InterfaceTypography` stories 使用真实 SessionList/LoroSidebar、Appearance、Composer/
OptionSelector、Markdown、工具 sheet、终端输出、xterm、Menu/Popover/Tooltip
及 Field。浏览器回归通过设置 UI 选择五档，断言实际字号与行高（含嵌套代码和
portal），搜索选项，检查键盘焦点/关闭、刷新及旧偏好。矩阵为 1280px 亮暗主题和
720px 亮色窄桌面，使用中英混排、长标题、正文及输出。另有两个用例验证导航五档，
以及 16px/13px 宿主下固定 12px 的消息预览，包含代码/标题、宿主 Composer、portal
和终端输出。

临时反向应用生产补丁回到 main `9ea2768` 后，回归失败。最大档的消息/输入/菜单/
代码在 main 为 16/14/13/14.4px，恢复后为 16/16/14.857/14.857px。
仅检查文档 CSS 变量无法证明这些边界生效。
单独恢复导航的固定 `text-sm` 也使新导航用例失败：最小档期望 12px，实际为 14px。
随后恢复共享角色实现。

通过既有 E2E harness 启动构建的隔离 OSS Electron，使用临时数据目录、独立 profile
和随机自有 CLI 端点，未操作用户现有应用。从 Settings → Appearance 逐档选择，
真实输入框及 New chat/Schedules 导航均为 12/13/14/15/16px，配套行高且高度足够。
终端预览按未改写的默认 13px 偏好乘比例，键盘焦点可用，刷新保留最大档。最终构建的
Electron 43.7.6 / Chromium 150 确认支持类型除法；浏览器自动化连接阻塞后，改用
既有 harness 重跑了完整原生流程。
未执行 provider，也未捕获私有对话。

| 命令 | 实际结果 |
| --- | --- |
| `pnpm build` | OSS CLI + 桌面生产构建通过；保留既有 bundle/import 警告 |
| `pnpm check`（Node 26.10.0） | 类型和 lint 通过；UI 298 测试通过；components 4741 通过、一个 boot-shell 失败，撤回生产修改后同样复现 |
| `pnpm check`（隔离 Node 22.14.0，整合 main 前） | 类型和 lint 通过；shared 因 WASM 加载错误中断，撤回生产修改后同样复现 |
| `NODE_ENV=test pnpm --filter @lody/components test --maxWorkers=2`（Node 22.14.0） | 整合 main `d3e249d2f` 后，4742 测试全部通过 |
| `pnpm --filter @lody/ui test` / `pnpm --filter @lody/electron test` | 298 / 199 测试通过 |
| `pnpm check:quick` | lint、i18n、导入及 platform/public 边界通过 |
| `NODE_ENV=test pnpm --filter @lody/components test tests/appearance-settings.test.tsx tests/interface-font-controller.test.tsx tests/terminal-settings.test.ts tests/local-terminal-panel.test.tsx` | 33 测试通过 |
| `LODY_STORYBOOK_URL=http://127.0.0.1:6016 pnpm --filter @lody/components test:e2e interface-typography.spec.ts --workers=1` | 六个浏览器用例通过；生产补丁和导航反向对照按预期失败 |
| `pnpm format` | 通过 |
| `pnpm run docs check` | 通过；保留既有翻译/大小警告，没有 SHA 保护主题 |

两种运行时的完整检查失败都在 main 生产源码上复现，没有豁免。整合后的首次浏览器
运行与构建触发的预览重载重叠，导航使焦点断言失败；构建完成后不修改断言重跑，
四个用例全部通过。无冲突整合 main 后重跑了生产构建、Node 26 完整检查、Node 22
组件套件及浏览器验证。Node 22 的 boot-shell
通过，Node 26 的 shared WASM 套件通过。未修复损坏的 Homebrew Node 22，改用 pnpm
缓存中的隔离 Node 22 进行第二轮验证，没有关闭任何检查。Windows/Linux
原生 UI、签名打包、真实 provider 流及其他系统字体未验收。

## 截图

全部使用合成内容。before/after 同为 1280×1600 窗口及相同内容，截图保留换行差异，
窄屏为 720×1600。before 为 main 的生产源码配相同 fixture，after 为恢复后的实现。

| 状态 | Before | After |
| --- | --- | --- |
| 默认档、亮色 | [14px](../../assets/interface-typography/before-14.png) | [14px](../../assets/interface-typography/after-14.png) |
| 最大档、亮色、菜单打开 | [16px](../../assets/interface-typography/before-16-menu.png) | [16px](../../assets/interface-typography/after-16-menu.png) |
| 最小档、亮色 | — | [12px](../../assets/interface-typography/after-12.png) |
| 最大档、暗色 | — | [16px](../../assets/interface-typography/after-16-dark.png) |
| 最大档、窄桌面（720px） | — | [16px](../../assets/interface-typography/after-16-narrow.png) |
