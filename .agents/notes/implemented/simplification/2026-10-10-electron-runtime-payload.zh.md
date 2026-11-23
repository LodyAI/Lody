# 裁剪 Electron 运行时打包输入

Status: implemented
Translation: current

[English](2026-10-10-electron-runtime-payload.md)

## 摘要

内嵌 CLI 原先复制 Loro 的五套发行文件，但其 worker 只使用 Node 入口。
现在仅保留 `nodejs/`、包元数据和许可证，包括 Node 入口相邻的 WASM。
Electron 打包同时排除 Sparkle 构建归档，保留 native addon 和单独复制的框架。
本机 Loro 1.16.3 暂存内容从 20,033,458 字节降至 3,753,709 字节；
这不是完整安装包的测量结果。

## 决策与边界

`scripts/cli-native-deps.mjs` 负责 CLI 运行时文件。清空暂存目录后，显式选择
Node 发行目录，不再复制 browser、bundler、web 和 base64 版本。
保持包元数据不变，使 Node 条件导出和 `require.resolve` 继续正常工作。
renderer 单独构建浏览器 WASM，不能对其依赖应用这项裁剪。

`electron-builder.yml` 排除 `native/sparkle-chain.tar.xz` 构建输入；
`native/build/Release/*.node` 和 `Sparkle.framework` 仍属于运行时输入。
删除全部应用依赖会破坏动态加载，因此本次只裁剪已确认用途的打包输入。

## 验证

暂存测试将实际安装的 Loro 包放入隔离的临时 node_modules，验证 CommonJS
根入口和 Node 子路径解析，再与通过 ESM 导入 Loro 的 worker 交换快照并编辑文档。
这同时覆盖暂存 WASM 和 JavaScript 解析。现有 Roost 测试覆盖跨架构二进制选择
与本机执行。四项暂存测试也在 Electron 的 `ELECTRON_RUN_AS_NODE=1` 模式下通过。
实际 electron-builder 文件过滤器排除了 1,588,780 字节的 Sparkle 归档，并保留
native addon；文档检查通过。完整签名安装包和其他平台的执行仍需发布验证；暂存字节节省量不能
直接代表压缩下载体积的变化。
