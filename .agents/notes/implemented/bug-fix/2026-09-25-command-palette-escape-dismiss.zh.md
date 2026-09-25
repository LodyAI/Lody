# 让命令面板自行处理 Escape 关闭

Status: implemented
Translation: current

[English](2026-09-25-command-palette-escape-dismiss.md)

## 摘要

桌面 smoke 场景中按下 Escape 后命令面板仍然打开，受控状态完全依赖模态框的文档级关闭监听器。现在面板会在自身获得焦点的命令区域处理 Escape；输入法仍在组合文字时，Escape 会优先交给输入法。基于状态的组件测试覆盖了这两种结果；仍需新的 CI Electron smoke 运行确认原失败已消除。

## 证据与决定

`LODY-SHORTCUT-001` smoke 运行在 `Meta+K` 打开命令面板后失败：后续 Escape 没有关闭面板，Playwright 等待五秒后仍检测到命令面板搜索框可见。保留的 trace 和失败截图都显示捕获时面板仍打开。失败场景与 PR 中的 mention 菜单文件无关，但它暴露出该面板完全依赖 Base UI Dialog 的文档级 Escape 监听器。

现在 `CommandPaletteView` 在 cmdk 根节点处理 Escape，并通过既有受控回调关闭面板。它使用共享 IME 事件判断函数，因此输入法组合期间的 Escape 仍可取消组合输入。关闭处理留在面板内部，没有增加全局按键监听器；Dialog 继续负责焦点管理和其他关闭行为。

该行为记录在[侧边栏搜索 Spec](../../../../specs/sidebar-search.md)中。由于本次没有人工批准，Spec 仍保持 draft。回归测试断言：组合输入期间搜索框仍在，普通 Escape 后搜索框消失。

## 验证限制

- `packages/components/tests/command-palette-view.test.tsx` 覆盖普通 Escape 和 IME 组合输入行为。
- OSS Electron 应用可在本地构建，但此 Linux runner 没有 X server 或 `$DISPLAY`；Electron 无法打开窗口，因此所有 smoke 场景都在启动前失败。仍需重新运行 CI 确认原 `LODY-SHORTCUT-001` 失败已消失。
