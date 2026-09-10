# 统一应用内快捷键的窗口生命周期

Status: implemented
Translation: pending

## 摘要

应用内快捷键已有统一 registry，但认证工作区的一条云端成功路径没有挂载命令实现，多窗口也不会刷新其他 renderer 中缓存的用户绑定。认证成功布局现在共用同一个命令宿主，registry 同时管理按键与 localStorage 变更监听。快捷键配置仍是设备级本地状态，修改会传播到所有已打开窗口，而命令只在接收按键的窗口执行。操作系统级全局快捷键继续由 Electron 主进程独立管理。

## 决策与边界

`AppInitializer` 仍是每个 renderer 的唯一 registry 挂载入口，并在 React 清理阶段对称 detach。registry 在 attach 时重新读取用户绑定，并监听同源窗口的 `storage` 事件；本窗口通过设置页写入后直接更新内存，其他窗口收到事件后从经过校验的持久化数据重建映射。没有引入额外 IPC 或广播协议，因为用户绑定已经由同一 Electron session 的 localStorage 持有，而浏览器原生事件覆盖所需的跨窗口通知。

认证工作区的本地、带本地令牌和普通云端成功路径共用 `AuthenticatedWorkspaceContent`。该宿主只负责长期存在的工作区命令和辅助组件；可配置的路由级命令继续通过 `useCommand` 在各自组件挂载和卸载时注册。系统级快捷键、窗口关闭菜单，以及弹层 Escape、焦点导航和编辑器键位等局部交互不迁入 renderer registry。

本修复是 Issue #288 的基础设施部分，不增加工作区切换命令或滑动手势。后续命令可以复用现有 `useCommand` 注册口，不需要再创建全局监听器。

## 验证

命令域的 6 个测试文件共 72 个测试通过，覆盖 detach 后旧 target 停止同步、重新 attach 时刷新持久化状态，以及模拟另一窗口写入后旧绑定停止触发、新绑定立即触发；改动文件的 lint 和格式检查通过，TypeScript 输出中没有改动文件的诊断。完整 `pnpm check` 在执行检查前因隔离 worktree 的系统缺少 `corepack` 而停止，components 全量类型检查也受未安装的 Electron 和 workspace 依赖阻断。文档检查只报告分支开始时已存在的 12 个失效链接；没有启动桌面应用做双窗口手工验证。

需求：[Issue #288](https://github.com/LodyAI/Lody/issues/288)。PR：[#572](https://github.com/LodyAI/Lody/pull/572)。
