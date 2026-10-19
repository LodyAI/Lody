# 有上限的认证恢复

Status: draft
Translation: current

[English](auth-recovery.md)

## 行为

云客户端丢失认证后，先尝试恢复，保留已挂载页面和本地数据。
自动恢复最多六次，延迟逐步增加；每次最多等待 15 秒，覆盖 session 刷新和
Convex 认证确认。离线或进入后台时暂停调度，不清零次数。

耗尽后继续阻止受保护请求，并显示持续可见的错误对话框，不再无限加载。
“重试连接”开始新一轮有限重试；“重新登录”复用正常退出及登录跳转，不清除
本地工作区数据。耗尽本身不能证明 session 无效；已有的 session 失效确认
流程仍负责自动退出。

新 session 使用新预算。其他情况下，只有连续 30 秒保持认证成功且没有新的
恢复请求才清零。中间的加载状态或短暂认证成功不能让反复查询失败变成无限
循环。超时或已失效的恢复尝试不能在晚返回时重新启动认证。

此约定不改变 GitHub 仓库授权，不重放 mutation，也不在纯本地客户端启用云认证。

## 依据

实现：`packages/components/src/providers/authenticated-convex-provider.tsx`。
行为测试：`packages/components/tests/authenticated-convex-provider.test.tsx`。
界面：`packages/components/src/components/auth-recovery-error.tsx`。
