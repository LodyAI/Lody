# 交接桌面端会话前先确认账号

Status: implemented
Translation: current

[English](2026-09-15-electron-browser-signin-account-choice.md)

## 摘要

在桌面端退出登录不会影响系统浏览器里的旧账号会话，而桌面端随后打开的浏览器页面
（`/login?client_id=electron&state=…&code_challenge=…`）会自行使用这份残留会话：它为
用户正想离开的那个账号签发授权码，并且只渲染一个转圈，既没有账号选择、没有重试，
自动跳转一旦没有生效也没有其他途径到达 `lody://auth/callback` 交接。现在页面会明确
显示当前登录的账号，在用户选择“以此账号继续”或“换个账号登录”之前不交接任何东西；
换账号时保留本次的 `state`/`code_challenge`，丢弃切换之后才返回的交接结果，并在自动
跳转旁渲染一个真实可点击的交接链接。本次改动源于“换账号后浏览器不拉起桌面应用”的
用户反馈：它消除了该反馈会陷入的死路，但并未确认那台机器上浏览器不拉起应用的原因，
也没有在此测量任何浏览器对自动跳转的处理方式。

## 原先的流程与现在的行为

桌面端 `requestAuth` 会带着 PKCE 的 `state` 和 `code_challenge` 打开系统浏览器的网页
`/login`。桌面端退出登录只清理桌面侧状态
（[`signOutWithoutRedirect`](../../../../packages/components/src/lib/auth.ts) 与主进程
的 auth service），浏览器自身的会话按设计不受影响。

此前，[`login-page.tsx`](../../../../packages/components/src/components/login-page.tsx)
只要检测到浏览器有可用会话，就在 effect 里调用 `electron.transferUser`，并把地址替换为
`lody://auth/callback#token=…`。服务端是按浏览器当前持有的会话签发授权码的，因此换账号
之后唯一可达的结果就是旧账号。这段过程中页面只渲染“正在跳转到桌面应用”的占位，provider
按钮不可达，用户既不能换账号也不能重试。

现在页面在常规登录卡片内渲染交接面板：

- 明确显示当前登录的账号，没有“以此账号继续”的明确操作就不会发起交接。
- “换个账号登录”会退出当前浏览器账号——这是把另一个账号交给桌面端的唯一途径——并且
  只在这一明确选择时执行。页面不跳转，URL 因此保留本次的 `state`/`code_challenge`；
  桌面端待处理的 code verifier 仍能与下一次登录匹配，其 OAuth 回调本就通过
  `buildElectronWebLoginCallbackUrl` 携带同一组查询参数。
- 换账号按钮不受页面加载态限制：交接正为错误账号进行中，恰恰是最需要这个出口的时刻。
  切换会递增一个代次计数，使之后才返回的交接结果丢弃其授权码而不生成交接链接；每次
  交接前后都会清除短时效的 `better-auth.electron` cookie，避免把陈旧授权码读成本次结果。
- 只有**确认成功**的退出才会放行交接。`signOutWithoutRedirect` 此前会吞掉两种失败形态
  —— Better Auth 传输失败靠抛出、API 失败写在 `response.error` —— 于是退出失败与成功
  无法区分，而此时浏览器的会话 cookie（正是交接会交出去的东西）仍然认证着上一个账号。
  现在它返回 `SignOutOutcome`；换账号失败会明确提示，并在重试成功之前阻止交接。
- 授权码就绪后，`lody://auth/callback#token=…` 只构造一次，自动跳转与可见链接共用同一个
  URL。自动跳转移入 effect，确保链接先绘制：浏览器拒绝自定义协议跳转时不会有任何回调，
  链接必须此前就已存在。
- 错误信息留在该面板并复用既有的提示状态，因此“继续”同时就是重试入口；既有的
  `expired=1` 提示保持不变。

## 取舍与本次改动的边界

保留自动交接、只补一个兜底链接的方案被否决：那样账号选择仍然不可达，而这正是反馈中的
死路。代价是顺利路径上多一次点击，包括刚完成 OAuth 往返之后。

“把授权码手动粘贴到桌面端”的兜底经过评估但未实现：它需要把 `identifier` + `state` 的
完整载荷送入桌面端既有的 PKCE 交换与回调事务，而不是接受 session token；在可见链接已经
存在的前提下，这个改动面大于需要。

本次没有触碰 macOS 协议注册、LaunchServices 或浏览器设置；OSS 的 `lody-oss` scheme 与云
构建的 `lody` scheme 是既定的构建差异，不属于本缺陷。

## 验证与限制

- [`tests/electron-browser-login-handoff.test.tsx`](../../../../packages/components/tests/electron-browser-login-handoff.test.tsx)
  在 jsdom 中渲染真实的 `LoginPage`，配合桩 auth client，覆盖：未选择前不发起交接；链接
  解码出的 `identifier`/`state` 与页面跳转的 URL 一致；切换账号后才返回的交接既不生成
  链接也不触发跳转；`state`/`code_challenge` 跨越切换进入下一次 provider 登录；交接失败
  后重试入口仍然可用。
- 该测试发现交接进行中时换账号按钮被禁用，而这正是该出口存在的场景，随后移除了这一限制。
- 退出失败的两种形态（请求被拒、返回 `error`）各有用例，断言交接被阻止，并在重试成功后
  恢复。把 `signOutWithoutRedirect` 改回原先吞掉失败的写法，恰好使这三个用例失败，说明
  该防护是有效的而非摆设。
- jsdom 无法跳转自定义协议，`window.location.replace` 又不可改写，因此测试只替换这一个
  跳转原语，并断言传给它的 URL 与渲染出的链接 `href` 相同。
- 任一具体浏览器是否会执行自动的 `lody://` 跳转，本次改动与测试都无法判定；用户机器上
  的原始反馈成因仍未确认。
- Storybook 只覆盖账号选择面板：story 不应向读者发起协议交接，交接后的状态由测试覆盖。
- 未构建或运行打包后的桌面应用；交换流程的桌面端未改动。
