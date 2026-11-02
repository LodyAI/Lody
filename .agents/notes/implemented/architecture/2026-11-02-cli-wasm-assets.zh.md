# CLI WASM 资源

Status: implemented
Type: architecture
Translation: current

[English](2026-11-02-cli-wasm-assets.md)

## 摘要

之前的 CLI WASM 加载器把 Loro、Flock 二进制内嵌为 base64 JavaScript 常量。
常驻 Node 进程初始化后仍持有较大的源码字符串和常量。CLI 构建现在把字节不变的
二进制输出为包内资源，并通过相对于模块的文件 URL 加载。模块继续使用原生 ESM 绑定，
消费者通过顶层 await 等待实例化完成。

## 决策

原插件在 SSR 加载器中直接构造 base64 URL，Vite 的资源内嵌大小设置不会改变这条路径。
构建时读取 WebAssembly 的导入、导出信息，生成 Node ESM 绑定。Rollup 为资源分配
带哈希的文件名，并计算相对于各输出 chunk 的路径。运行时用 `node:fs/promises`
读取二进制，再传入原来的导入项进行实例化。任意导出名称通过带引号的 ESM 导出保留。

npm 包的 `dist/` 收录规则和桌面递归复制 CLI 产物的流程会携带这些资源。Electron
现有的 `resources/**` 解包规则让资源位于内嵌 CLI 旁，打包钩子在各目标平台比较
暂存资源与安装包中的字节。现有的 `zstd.wasm` 加载器继续使用相对于入口的文件。

实验中，官方 Node Loro 入口同样避免了内嵌字符串，但其 WASM 二进制与 bundler
入口不同。输出当前二进制可以保留原来的字节，无需切换引擎构建。

本次处理的持有分配与之前的[消息 schema 复用](2026-10-30-desktop-schema-initialization.zh.md)、
[内部 MCP 入口](2026-10-30-internal-mcp-command-loading.zh.md)优化不同。

## 常驻内存

一组 macOS arm64 OSS 桌面对照使用 Electron 44.9.3 / Node 24.22.0，
基线为 `e705a48356ebff10ffc8644253553a5d63df45ff`，与本次改动比较。两个隔离配置
均完成引导并重新启动一个可见的空窗口。表格取空闲第 2、3 分钟的系统 footprint
中位数，位于诊断 GC 之前。

| Footprint，MiB | 基线 | 独立 WASM 资源 | 减少 |
| --- | ---: | ---: | ---: |
| Daemon | 171.14 | 149.96 | 21.18 |
| MCP 宿主 | 111.99 | 93.25 | 18.74 |
| 桌面进程组 | 670.02 | 627.84 | 42.17 |

进程组合计使用系统的进程组计量。RSS 合计包含共享映射，且在采样间发生波动；
上述 footprint 数据不代表 RSS 的下降量。另行初始化并完成工具请求的 MCP 宿主
少持有约 6.85 MiB JS 堆和 12.91 MiB 源码字符串。两种受支持的 MCP 协议下，
完整工具定义、参数校验和鉴权响应均一致。

## 验证

[CLI 构建集成测试](../../../../apps/cli/tests/vite-config.test.ts)移动产物、删除源码后，
在独立 Node 进程中执行生成的模块，检查二进制一致性、导入函数、内存、带引号的
导出和缺少资源时的初始化结果。[桌面暂存测试](../../../../apps/electron/scripts/cli-native-deps.test.mjs)
覆盖完整、缺失和字节改变的安装包资源。
