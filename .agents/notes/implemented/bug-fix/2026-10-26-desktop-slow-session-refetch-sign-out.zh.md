# 会话重新获取较慢时不再登出桌面端

Status: implemented
Translation: current

[English](2026-10-26-desktop-slow-session-refetch-sign-out.md)

## 摘要

在 macOS 上开着代理更新或重启后，桌面端会退出登录，必须重新走浏览器登录。
原因是启动时的会话检查超时，而重试耗时又超过了重试退避和启动缓冲期。
Electron 会话 store 在重新获取期间会清空 `error`，稳定会话 hook 把这个中间状态
当成"服务器确认没有用户"，于是确认登出，并吊销了持久 cookie。现在 hook 把
"尚未拿到用户的重新获取"视为 pending，只有服务器明确答复才会登出。主进程也会保留超时之后
才到达的会话结果，并在会话验证不可达时用已保存的 cookie 去请求组织和 Convex 接口。
这样启动较慢时也能自行恢复，而不会退出登录。

## 原因

`useStableSessionInternal` 只读取了 `authClient.useSession()` 的 `isPending`，
没有读取 `isRefetching`。出问题的过程如下：

- 启动时的 `getSession` 触发主进程 5 秒网络超时，而此时主进程还没有缓存的会话。
- 重试把 `retryCount` 推到上限时，还有一次重新获取没有返回。
- 此时 `shouldConfirmUnauthenticated` 看到的是：有本地 token、没有用户、没有进行中的检查、
  没有重试、也没有错误。2 秒启动缓冲期一过（没有快照时则立即），根组件的失效处理就调用了登出。

主进程的 `signOut` 会吊销 Better Auth cookie，所以只能重新走浏览器登录，
而不是等网络恢复就好。

## 决策

hook 把 `isRefetching && !user` 视为 pending；已有用户时的重新获取行为不变。
另一种方案是让 Electron 查询 store 在重新获取期间保留 `error`，但这会改变所有
`useSession` 使用方在重新获取时看到的状态，而问题只出在其中一个解读方，因此没有采用。
Better Auth 网页版的 `useSession` 也提供同一个字段。

## 主进程恢复

- **迟到的结果。** `withSessionNetworkTimeout` 限制的是调用方等多久，请求本身还会继续。
  超时后才返回、并且确认了会话的结果，现在会写入缓存的会话，前提是认证代次没变
  （期间没有登出或重新登录），并且请求发出之后没有提交过任何结果。第二个条件用
  "会话结果版本号"来判断，不能靠"缓存是否为空"：服务器明确拒绝也会清空缓存，却不改变
  认证代次。如果只看缓存，一个过时的成功结果就会把服务器刚拒绝的身份恢复回来。renderer 下一次重试就能直接从缓存拿到，
  不会再超时一次。迟到的拒绝结果会被忽略，由下一次真实检查决定。
- **token 回退。** 以前 `getSessionToken` 的验证一超时，`listOrganizations`、
  `getActiveOrganization` 和 `convexToken` 都会跟着失败。网络失败说明不了凭证是否有效，
  所以现在直接返回持久 cookie 的 token（没有就用传入的 bearer），不再发第二次网络检查。
  服务器仍会校验每次调用；token 过期只会让那次调用返回普通的 401，不会导致登出。

## 验证与限制

`tests/use-stable-session.test.tsx` 重放了"首次检查超时，随后一次很长的重新获取"的过程。
`tests/electron-auth-session-recovery.test.ts` 覆盖三种情况：迟到的结果会被保留；
登出或服务器明确拒绝之后才到的结果会被丢弃；获取 token 时回退到 cookie。新增测试在修改前的代码上都会失败。
代理环境下网络本身的延迟没有处理，也没有在真实的 macOS 代理环境下验证。
