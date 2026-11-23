# 原生界面按已提交的主题打开

Status: implemented
Translation: current

[English](2026-09-29-committed-startup-theme.md)

## 摘要

用户在系统浅色、Lody 选深色时打开桌面窗口，原生窗口框、底色和 Windows 标题栏按钮都是白的，包着深色页面：主题存在渲染进程的 `localStorage` 里，主进程读不到，只能按系统外观选色。现在渲染进程把用户已提交的主题（不含悬停预览）同步到主进程的设置文件，在窗口创建前写入 `nativeTheme.themeSource`，并通过一个桥把同一个值交给原生移动壳实现。打开这个文件绝不能让应用无法启动，所以所有启动期的 `conf` 存储在文件损坏时都会退回内存默认值。页面内的首帧不在本决定范围内：[boot shell](2026-09-26-boot-shell-first-paint.zh.md) 已经按存储的主题画出它。

## 决定与证据

- **已提交，而非预览。** `ThemeProvider` 写入的 `storedTheme` 即 `useNextTheme().theme`。next-themes 0.4.6 的 `forcedTheme` 只作用于文档 class，不影响返回的 `theme`，所以设置页的预览不会进入持久化。渲染进程用 `app.setNativeTheme` 驱动实时窗口外观（跟随预览），用 `app.setStartupThemeSource` 记录下次启动；两者都在 IPC 边界校验来源值。
- **在窗口之前，而非之后。** `getInitialMainWindowThemeSource` 对产品窗口返回存储的主题，引导窗口仍固定为浅色。尚未提交过主题时返回 `system`，即原有行为。
- **移动壳。** `LodyStartupThemeBridge`（`window.__LODY_STARTUP_THEME__`）的类型定义在这里，由私有仓的壳实现，用它自己的存储给 splash 和 WebView 着色。
- **坏文件不能阻止启动。** `conf` 15.1.0 在构造函数里读取并校验文件，`clearInvalidConfig` 默认为 `false`；截断的文件抛 `SyntaxError`，枚举外的值抛 `Config schema violation:`，均用真实文件测得。所有存储都在导入或启动时构建，这个异常会让启动中止。现在主题、开机自启、引导状态、窗口状态和全局快捷键五个存储都经过 `createSettingsStoreWithFallback`；`auth.ts` 有自己的备份路径，应用图标偏好本就惰性地清除无效文件。选择内存默认值而不是 `clearInvalidConfig: true`，是为了让损坏文件留在磁盘上便于恢复，并且也能覆盖不可读路径。因此 `onboarding-state.json` 损坏时会重新显示引导，而不是无法启动。
- **登录页预热。** 登录页在空闲回调里调用 `preloadMainLayout()`，而不是裸 `import()`。它会记录模块，使 `PreloadedMainLayout` 直接挂载，不会为一次提交挂起到 boot shell。失败的预热不会被缓存，真正挂载时会重试。在 Web 和移动端，这是 `/login` 以前没有的请求，从不登录的访客也要付出；之所以不等到点击登录才做，是因为社交登录会立即跳走。

## 放弃的方案

- 由 preload 脚本根据启动参数加 `.dark`。boot shell 经 CSP hash 允许的头部脚本直接读 `localStorage`，而且不会在窗口生命周期内固定不变。
- 从主进程读取渲染进程的存储。Chromium profile 的 leveldb 不是受支持的接口。

## 验证与局限

`node --test` 覆盖主题来源解析、IPC 边界校验，以及用真实损坏文件测试的降级；去掉降级后两个损坏用例都会失败。Vitest 覆盖已提交与预览的区分，以及预热失败后的重试。Windows 标题栏在首帧的颜色没有在 Windows 真机上观察，依据是 `applyResolvedWindowTheme` 在主题变化时已驱动它。原生侧写死的颜色尚未与主题的 `--background` 绑定：浅色窗口底色是 `#FFFFFF`，页面是 `#F9F9F9`。

PR：[#320](https://github.com/LodyAI/Lody/pull/320)
