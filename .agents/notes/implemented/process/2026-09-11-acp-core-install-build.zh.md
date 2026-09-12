# 在安装时构建 `acp-extension-core`，而不是在每个消费者中构建

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/596

Upstream change: https://github.com/LodyAI/acp-extension-core/pull/8

[English](2026-09-11-acp-core-install-build.md)

## 摘要

`acp-extension-core` 同时发布原始 TypeScript 与编译产物 `dist/`，其运行时 `exports.import` 指向
`dist/index.js`。而只有 `build` 与 `prepublishOnly` 会产出该目录，因此 pnpm 工作区安装只是链接了
该包却没有编译它：任何打包该运行时导出的消费者，除非先自行运行
`pnpm --filter acp-extension-core build`，否则都会以
`Failed to resolve entry for package "acp-extension-core"` 失败。`loro-dev/lody` 与本仓库中累积了
五处这样的绕行做法，而每个新消费者都会重新踩一遍。该包现在声明 `prepare`——pnpm 在安装以及
pack/publish 时都会运行它——因此工作区消费者只要普通安装就能得到 `dist/`，而发布的 tarball 保持
不变；`prepare:acp-adapters` 不再编译 Core。遗留限制：若某次安装的 filter 范围不包含该包，它仍然
不会被构建，因此正确性现在取决于依赖图，而不是逐 job 的自觉。

## 问题

- `main` 与 `exports.import` 都是 `./dist/index.js`；`dist/` 被 gitignore，在干净 checkout 中不存在。
- `types` 是 `./src/index.ts`，所以 `pnpm typecheck` 总是通过，只有打包器（Vite、esbuild、Wrangler）
  会失败——而且是在发布流水线中很晚才失败。
- pnpm 的 `workspace:*` 只链接该包，不会运行它的构建。
- `packages/shared` 从 Core 导入运行时值（`createPlanModeConfigOption`、`LODY_PLAN_MODE_CONFIG_ID`），
  因此 Core 的运行时入口会进入浏览器 bundle、Convex bundle、Worker、Pages、CLI 与移动端。

## 决策

在 `packages/acp-extension-core/package.json` 中声明 `prepare: npm run build`，取代
`prepublishOnly`——对 pack/publish 路径而言 `prepare` 本就覆盖了它。生产方在安装时构建自己的运行时
入口；消费者不再为一个依赖背负构建步骤。

被否决的替代方案：

- **让每个消费者固定到已发布的 registry 版本。** 这会把本地 checkout 移出构建输入。
  `acp-extension-codex` 把 Core 内联进其打包的 `dist/`，CLI 则内联 Core 与全部四个 adapter，因此
  产品最终会带上 npm 最后发布的版本而非固定的 submodule；而这些 adapter 本就声明了三个不同的 Core
  版本（0.1.0/0.1.1/0.1.4），根级的 `overrides: acp-extension-core: workspace:*` 正是刻意把它们
  折叠成一份。
- **把 `exports.import` 指向 `src/index.ts`。** 这会改变 Node 消费者的运行时语义，并需要一个
  `publishConfig` 覆盖以及两个解析条件。
- **保留逐 job 的构建步骤。** 它们是正确的，但处在错误的层级：每个新消费者都要重新发现这个失败，
  而本地开发根本没有这样的 job。

## 证据

pnpm 10.20.0 工作区，先在临时工作区验证、再在 `loro-dev/lody` 验证：

- `pnpm install` 与 `pnpm install --frozen-lockfile` 都会运行工作区项目的 `prepare`。
- 通过依赖闭包触及该包的过滤安装（`--filter '@lody/web...'`，即 Cloudflare Pages 的安装）也会运行它；
  不带 `...` 的 `--filter pkg` 不会，因为该包不在那次安装范围内。
- `onlyBuiltDependencies` / `ignoredBuiltDependencies` 管的是外部依赖的构建脚本，不管工作区项目的
  生命周期脚本。
- 改动之后，普通的根级安装即可产出 `acp-extension-core/dist/index.js`，此前在解析阶段失败的移动端
  生产 bundle 也能完成。

## 后果

`loro-dev/lody` 可以去掉四处逐消费者的 Core 构建（Convex 部署步骤、site-docs 发布步骤、Pages 输入、
移动端发布 job），本仓库可以从 `prepare:acp-adapters` 中去掉 Core 阶段。代价是每次工作区安装都会
多跑一次 `tsc`，包括那些从不打包 Core 的安装。
