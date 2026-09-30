# Storybook 开发环境与 React Refresh

Status: implemented
Translation: current

[English](2026-09-26-storybook-dev-node-env.md)

## 摘要

当前工作区的 shell 导出了 `NODE_ENV=production`，开发者启动 Storybook 开发服务器时也会继承它。Vite 因此把 serve 配置判为生产模式并跳过 React Refresh 的运行时包装，同时 JSX 转换仍生成刷新签名调用。现在仅在运行 `storybook dev` 时，Storybook 配置会重置这个继承值；静态 Storybook 构建仍使用生产模式。

## 问题

Storybook iframe 执行 `packages/ui/src/theme/theme.tsx` 时失败，报 `$RefreshSig$ is not defined`。浏览器拿到的模块包含签名调用，却没有对应辅助函数。React 插件把服务判成生产模式后输出了空预览初始化模块，尽管 Vite 仍在开发模式下提供模块。

## 决定

当 Storybook CLI 参数包含 `dev` 时，`.storybook/main.ts` 会在 Vite 加载 components 包配置前，把继承来的生产环境变量改成 `development`。这样 React Refresh 运行时会与 serve 转换匹配。`storybook build` 不走这条路径，继续使用生产语义。

这是对 [Storybook 10 迁移记录](../process/2026-09-12-storybook-10-migration.md) 的后续补充：原记录说明了 Vite 集成，但没有记录继承环境变量的影响。

## 验证

在 shell 仍导出 `NODE_ENV=production` 时，Storybook 开发服务器返回的 `theme.tsx` 同时包含 `$RefreshSig$` 调用和函数定义；Chromium 中的 `Sessions/SessionInfoCard / Team scope (with Author row)` story 正常渲染。截图已上传到当前 Lody 对话。
