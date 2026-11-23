# 修补 Electron、undici 和 Storybook 的安全边界

Status: implemented
Translation: current

[English](2026-10-26-runtime-dependency-security.md)

## 摘要

Electron 缺少泄露证书拦截、npm undici 遗留未监听错误的响应流、Storybook
开发服务受攻击，三者需要分别修复。固定 Electron 44.9.3，将 undici 6.x
下限提高到 6.29.1，并按受影响范围分别更新各主版本。两个 Storybook 工作区
统一使用 10.6.2，默认仅监听本机。源码升级不会替换已部署应用，也不能解决
Electron 另一个数字主机名 TLS 校验问题。

## 决策与边界

- [Electron 公告](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9)：
  44.9.1 为 Chromium 和 Node TLS 网络层增加 eMudhra 拦截；采用既有 44.x
  系列的稳定补丁 44.9.3，并保持精确的发布时间例外。
- [undici 公告](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c)：
  CLI HTTP 和 preview 显式使用 npm undici，与系统 Node 内置 fetch 分开。
  6.x/7.x/8.x 分别修补到 6.29.1/7.30.1/8.12.2，不跨主版本替换工具依赖。
- [Storybook 公告](https://github.com/storybookjs/storybook/security/advisories/GHSA-px85-f4q5-jh77)：
  components 和 review-helper 协调 core、React、Vite 集成版本。
  开发服务默认监听 127.0.0.1；静态输出属于另一边界。

## 复现与验证限制

`node --test scripts/security-undici-probe.test.mjs` 观察隔离客户端 catch 拒绝后的
自然退出，并验证正常响应。用 `node scripts/security-undici-probe.mjs <已解析模块>`
可比较旧安装，无固定运行时或依赖绝对路径。服务仅生成本机合成响应，客户端不
安装未捕获错误监听器，也不强制成功退出。超时只限制挂起，不控制响应时序。
同一 Node 22.23.4 下，6.26.0 catch 后以
`UND_ERR_RES_CONTENT_LENGTH_MISMATCH` 退出 1；6.29.1 catch 后退出 0。

Electron 44.9.3 实测 Node 24.22.0、Node-API 10、Chromium 152.0.7977.167。
离线 `tls.checkServerIdentity` 仍接受全角、特殊点号和数字别名对应
`DNS:127.0.0.1`。保留独立的
[主机名 TLS 待办](2026-10-22-node-security-runtime-floor.md)，本次 eMudhra
升级不能关闭该问题。版本下限和合成传输测试不证明真实泄露证书被拒绝，亦不证明
托管登录成功。其他平台、签名公证安装包和生产交付仍需独立证据；本机 macOS
arm64 构建和 smoke 的实际命令与结果记录在对应精确提交的 PR 中。

最初的 Session smoke 卡在原生 `SecItemCopyMatching` /
`SecKeychainItemCopyContent`，主线程采样确认了该等待。同一构建使用旧 Electron
可以通过；在 harness 的一次性 profile 中启用已有的开发明文认证存储开关后，
44.9.3 也通过同一场景。此设置仅进入未打包的测试启动环境，`app.isPackaged`
仍会拒绝它。这项对照解决已观察到的自动化阻塞，不证明同步缺陷；测试有意绕过
原生钥匙串，因此不验证钥匙串访问。无需修改同步或产品认证代码。
