# 不完整的组织成员响应

Status: implemented
Translation: current

[English](2026-10-05-incomplete-organization-members.md)

## 摘要

非空的活动组织对象缺少 `members` 时，云端 provider 在推导当前用户角色时崩溃。
将这种不完整响应视为尚不可用，通过既有刷新路径暴露错误，并且不授予管理权限。
分享入口同样将缺失成员信息视为未知。响应缺失的上游原因尚未确认；Better Auth
1.6.33 的正常完整组织响应仍会返回成员数组。

## 行为与证据

此修复补充 [1.6 升级基线](2026-09-30-better-auth-1-6.zh.md)。
不将缺失成员替换为空数组，否则会误认为响应完整，混淆成员未知与单人工作区。
不反复激活同一个数据不完整的组织。显式导航到不同组织时仍应激活新目标，旧目标
的数据错误不得归因于新目标。

Hook 测试覆盖 owner 响应之后成员缺失或为 null、权限关闭、刷新恢复、离开数据
不完整的组织，以及成员信息到达前后的分享入口。合成回归用例可以复现客户端
崩溃，但不能证明原始网络响应的具体内容。

## 消融证据

四个测试文件在基线和最终简化版本中均通过 32 项测试。逐项删除保护得到以下
结果，每次实验后恢复原始代码再进行下一项删除：

| 删除的保护 | 结果 |
| --- | --- |
| 已解析组织的完整成员校验 | 2 项失败：undefined/null 导致 `members.find` 崩溃 |
| 成员错误的目标范围限制 | 1 项失败：旧组织错误传递到新目标 |
| 同目标激活保护 | 2 项失败：再次激活数据不完整的组织 |
| 分享入口的成员数组校验 | 2 项失败：undefined/null 导致 `members.length` 崩溃 |

保留这些保护。错误范围判断复用既有的目标匹配布尔值，空值或不同 ID 的条件
合并为可选链比较：目标来自组织列表项，其 ID 为必填字符串。这些修改删除重复
表达式，保留行为边界。复现命令为 `NODE_ENV=test pnpm --filter @lody/components
exec vitest run tests/useOrganization.test.tsx tests/use-session-sharing.test.tsx
tests/cloud-platform-provider.test.tsx tests/workspace-route-guard.test.ts`。
本次实验不评估依赖补丁或原生登录。
