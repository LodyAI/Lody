# 在远程目录选择器中新建文件夹

Status: implemented
Translation: current

[English](2026-10-14-remote-directory-creation.md)

## 摘要

远程“添加文件夹”选择器原来只能选择已有目录，铅笔用于编辑导航路径，无法创建目录。
现在支持该能力的机器会显示单名称“新建文件夹”表单，在当前远程父目录下创建并进入结果目录。
“添加”仍是独立的项目登记操作。重名时不覆盖任何对象；连接故障后应检查父目录再重试。

## 决策与职责

```text
桌面 / 移动远程选择器 → 共享 hook 与新建表单
  → local-project/create-directory(machineId, workspaceId, parentPath, name)
  → Machine RPC / 本机 daemon → LocalProjectControlService → mkdir
  → 浏览新目录 → 既有 Add / prepare-add → 项目登记
```

新增能力 `localProjectCreateDirectory: 1`，旧 daemon 不显示入口。
共享 TS、Zod 与 CJS 校验承载请求和响应；两条路由都在创建前检查机器和工作区。
服务要求绝对且已存在的父目录，解析真实路径，只接受非空单段名称，拒绝分隔符、控制字符和首尾空白。
Windows 上还拒绝保留名和非法字符。非递归 mkdir 处理并发竞争，并拒绝已有文件、目录和符号链接。
系统权限、只读文件系统和路径错误保留结构化分类。本次沿用既有 Promise 服务边界；迁移 daemon
所有权会扩展到与目录创建无关的生命周期依赖。

hook 用同步标记阻止同时创建/登记，失败保留输入，导航、关闭或卸载后的旧响应不再改变选择。
已确认创建成功但浏览失败时只重试浏览，不自动重试 mkdir。本次不涉及原生选择器或重命名。

## 边界与验证

机器所有权沿用既有 UI 限制，并非 RPC 调用者的身份认证，不把请求中的用户标识当作可信身份。
文件系统权限以 daemon 的系统身份为准。解析父目录真实路径不提供 mkdirat 式防护，无法完全防止
其他本机进程并发替换祖先路径。

行为测试使用真实临时目录验证父目录规范化、非法名称/父路径、文件/目录/链接重名和并发创建，
通过注入系统错误验证权限失败，并覆盖协议校验、两条路由、选择器状态与 UI，包括离线、重复操作和独立登记。
路由验证明确属于 focused mock 测试：隔离已安装 Claude SDK 元数据，执行真实路由和临时文件系统，
不代表适配器/运行时集成验证通过。
Windows 名称规则通过注入平台验证；未验证真实 Windows 文件系统及在线远程机器 UI。
PR: [#1576](https://github.com/LodyAI/Lody/pull/1576)。
