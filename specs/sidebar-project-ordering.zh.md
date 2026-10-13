# Sidebar 项目排序

Status: draft
Translation: current

[English](sidebar-project-ordering.md)

当一个工作区包含多个 GitHub 仓库或本地项目文件夹时，桌面端 sidebar 允许用户拖动
行末的手柄，调整同一分区内项目的顺序。本地项目仍按所属设备分组；拖动不会把项目移到
其他设备分区。

桌面端确认本机身份后，本机分组在 CLI 断连和重启期间保持置顶。随后是用户的其他设备，
最后是队友设备，各自按名称排序，同名时按 machine id 排序。点击会话或清除未读状态
不会移动设备分组。保留排序位置不代表运行实例不可用时仍可执行本地操作；
关闭本地 Agent 会清除本机优先排序。

排序结果按工作区分别持久化。本地项目的存储标识同时包含 machine id 与 project id。
设备重连期间暂时消失的项目会保留原来的位置；新发现的项目排在已有保存顺序的项目之后。

移动端保持现有的非拖拽布局。

## 实现证据

- [Sidebar 状态](../packages/components/src/atoms/sidebar-state.ts)
- [Sidebar 渲染](../packages/components/src/components/loro-app-sidebar.tsx)
- [工作区隔离测试](../packages/components/tests/sidebar-local-project-order.test.ts)
