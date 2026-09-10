# 统一应用内快捷键的窗口生命周期

Status: implemented
Translation: pending

## 摘要

应用内快捷键已有统一 registry，但 DOM 匹配、监听生命周期、命令决策和持久化刷新混在同一个类中；认证工作区的一条云端成功路径也没有挂载命令实现，多窗口不会刷新其他 renderer 中缓存的用户绑定。现在每个 renderer 由一个 React 宿主统一接入快捷键，稳定版 `tinykeys` 负责 DOM 匹配，registry 只负责 Lody 的命令语义，持久化模块负责跨窗口刷新。认证成功布局同时共用同一个命令宿主。快捷键配置仍是设备级本地状态，命令只在接收按键的窗口执行；操作系统级全局快捷键继续由 Electron 主进程独立管理。

## 决策与边界

`AppInitializer` 是每个 renderer 唯一的 `CommandShortcutHost` 挂载入口。宿主根据 registry 快照为 tinykeys 建立一个 capture-phase `keydown` 监听，并在 React 清理阶段使用库提供的 unsubscribe 对称卸载；命令注册、注销或用户改绑后，宿主自动替换映射。Lody 仍拥有命令 ID 栈、最近挂载优先、`when`、`KeyScope`、文本输入让渡、用户覆盖、palette/settings 和 analytics 等领域规则，第三方库不进入这些契约。

没有采用仍为 alpha 的 TanStack Hotkeys：它当前不支持 capture listener，而且冲突替换模型不能表达 Lody “临时实现卸载后恢复 placeholder”的命令栈。`react-hotkeys-hook` 可支持 capture，但每个 hook 自带监听生命周期，也不提供命令目录；本改动选择约 1 KB、稳定且提供 unsubscribe/capture/event.code 的 tinykeys 作为低层引擎。公开绑定语法继续由 `key-matcher.ts` 适配，因此库替换不会改变用户配置；字母、数字、括号和逗号/句号仍按 `event.code` 匹配，保留 macOS Option 字形和 Shift 标点下的既有行为。

`user-bindings.ts` 独立拥有 `storage` 订阅。宿主挂载时重新读取用户绑定，本窗口通过设置页写入后直接更新 registry，其他窗口收到事件后从经过校验的 localStorage 重建映射。没有引入额外 IPC 或广播协议，因为同一 Electron session 的浏览器原生事件已经覆盖所需通知。

认证工作区的本地、带本地令牌和普通云端成功路径共用 `AuthenticatedWorkspaceContent`。该宿主只负责长期存在的工作区命令和辅助组件；可配置的路由级命令继续通过 `useCommand` 在各自组件挂载和卸载时注册。系统级快捷键、窗口关闭菜单，以及弹层 Escape、焦点导航和编辑器键位等局部交互不迁入 renderer registry。

本修复是 Issue #288 的基础设施部分，不增加工作区切换命令或滑动手势。应用级快捷键只有 `useCommand`/registry 一个注册口；弹层 Escape、列表导航、编辑器键位和首次交互解锁等组件局部按键仍留在所有者内部。后续工作区命令复用 `useCommand`，不创建新的全局监听器。

## 验证

命令域的 7 个测试文件共 79 个测试通过，覆盖 registry 决策、tinykeys 的真实 DOM 捕获、物理键适配、动态改绑、宿主卸载、挂载时刷新持久化状态，以及模拟另一窗口写入后旧绑定停止触发、新绑定立即触发；`AppInitializer` 的 2 个平台时间测试也通过。改动文件 lint、格式和文档检查通过。components 全量类型检查受隔离 worktree 未链接的 Electron 与其他 workspace 依赖阻断，输出中没有本次改动文件的诊断；未做双窗口桌面手工验证。

需求：[Issue #288](https://github.com/LodyAI/Lody/issues/288)。PR：[#572](https://github.com/LodyAI/Lody/pull/572)。
