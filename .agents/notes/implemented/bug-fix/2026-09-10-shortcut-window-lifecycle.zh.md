# 统一应用内快捷键的窗口生命周期

Status: implemented
Translation: pending

## 摘要

应用内快捷键已有统一 registry，但 DOM 匹配、监听生命周期、命令决策和持久化刷新混在同一个类中；认证工作区的一条云端成功路径也没有挂载命令实现，多窗口不会刷新其他 renderer 中缓存的用户绑定。现在每个 renderer 由一个 React 宿主统一接入快捷键，`@tanstack/hotkeys` 负责解析、标准化、匹配和展示，registry 只负责 Lody 的命令语义，持久化模块负责跨窗口刷新。认证成功布局同时共用同一个命令宿主。快捷键配置仍是设备级本地状态，命令只在接收按键的窗口执行；操作系统级全局快捷键继续由 Electron 主进程独立管理。

## 决策与边界

`AppInitializer` 是每个 renderer 唯一的 `CommandShortcutHost` 挂载入口。宿主根据 registry 快照用 TanStack Hotkeys 创建多键位 handler，再建立一个 capture-phase `keydown` 监听；React 清理阶段对称卸载，命令注册、注销或用户改绑后自动替换映射。没有直接使用库内置 manager，因为它只建立 bubble-phase listener，不能保证 Radix focus trap 等局部组件停止冒泡后应用级命令仍可到达。Lody 仍拥有命令 ID 栈、最近挂载优先、`when`、`KeyScope`、文本输入让渡、用户覆盖、palette/settings 和 analytics 等领域规则。

绑定采用库原生的单 chord 语法，平台主修饰键由 `Mod` 表示；运行时不再维护第二套 parser，也不再把 Lody binding 编译成第三方正则。TanStack Hotkeys 提供相同的 canonical normalization 给 registry 冲突索引和 DOM matcher，并通过 `event.code` fallback 处理 macOS Option 字形及 Shift 标点。录制入口使用库的 event/normalization API，并仅在 DOM 边界把字母、数字和库已定义的标点 code 还原成物理键，确保录制结果与 matcher 的 fallback 得到同一个 canonical binding。旧 localStorage 与 Electron global-shortcut 配置中的 `$mod` 在读取边界迁移为 `Mod`；新默认值和新写入只生成 `Mod`。

TanStack Hotkeys 0.8.0 仍为 alpha，因此依赖精确锁定，不允许 semver 自动升级。采用它是为了把 parser、平台标准化、匹配、校验和展示交给同一个库；升级必须先复跑命令域、改键和全局快捷键契约测试，并确认 capture host 仍有必要。没有直接采用 `react-hotkeys-hook`，因为它不提供可供 registry、设置页和 Electron 共享的 canonical/format API；也没有保留 tinykeys，因为那需要一层自定义语法编译器才能维持现有物理键行为。

`user-bindings.ts` 独立拥有 `storage` 订阅。宿主挂载时重新读取用户绑定，本窗口通过设置页写入后直接更新 registry，其他窗口收到事件后从经过校验的 localStorage 重建映射。没有引入额外 IPC 或广播协议，因为同一 Electron session 的浏览器原生事件已经覆盖所需通知。

认证工作区的本地、带本地令牌和普通云端成功路径共用 `AuthenticatedWorkspaceContent`。该宿主只负责长期存在的工作区命令和辅助组件；可配置的路由级命令继续通过 `useCommand` 在各自组件挂载和卸载时注册。系统级快捷键、窗口关闭菜单，以及弹层 Escape、焦点导航和编辑器键位等局部交互不迁入 renderer registry。

本修复是 Issue #288 的基础设施部分，不增加工作区切换命令或滑动手势。应用级快捷键只有 `useCommand`/registry 一个注册口；弹层 Escape、列表导航、编辑器键位和首次交互解锁等组件局部按键仍留在所有者内部。后续工作区命令复用 `useCommand`，不创建新的全局监听器。

## 验证

命令域测试覆盖 registry 决策、真实 DOM 捕获、TanStack 标准化与匹配、物理键录制、动态改绑、宿主卸载、挂载时刷新持久化状态、旧数据迁移，以及模拟另一窗口写入后旧绑定停止触发、新绑定立即触发；shared 契约测试覆盖 `Mod` 到 Electron accelerator 的转换和 `$mod` 兼容。`AppInitializer` 平台时间测试继续覆盖唯一宿主入口。桌面 P0 E2E 通过产品 `app.openWindow` IPC 打开共享同一 Electron session/localStorage 的第二个真实窗口，覆盖两个 renderer 中的默认 `Mod+K` 和物理标点 `Mod+,`、在主窗口把侧栏改绑到产生移位字符的 `Mod+Shift+9`、两个窗口中的旧绑定立即失效与新绑定生效，以及辅助 renderer 重载后用户绑定恢复。

需求：[Issue #288](https://github.com/LodyAI/Lody/issues/288)。PR：[#572](https://github.com/LodyAI/Lody/pull/572)。
