# Daemon 内存占用

Status: implemented
Type: architecture
Translation: current

[English](2026-11-21-daemon-memory-footprint.md)

## 摘要

一台按内存计费的主机报告，daemon 的三个常驻进程（看门狗、Worker、HTTP MCP host）
合计常驻约 1.4 GB。heap snapshot 显示每个进程 JS 堆的三分之一来自 Zod 4.3 classic
schema：每个实例自带约 58 个方法闭包；而且因为 bundle 既无法 tree-shake 这些 schema，
也无法把它们挡在公共 chunk 之外，每个进程几乎都执行了全部 shared schema。现在 Zod
升级到方法定义在原型上的 4.6；工作区包的 `sideEffects` 声明能传到 Rollup；看门狗不再
组装 Workspace presence；Loro 和 Flock 的 wasm 从资源文件加载；daemon 子进程限制 glibc
arena 数量。在空闲的本地 daemon 上，三个进程的 RSS 合计从约 797 MiB 降到 407 MiB。
繁忙负载和其他平台的数据尚未测量。

## 发现

- Zod 4.3 的 `ZodType` 会把 `parse`、`optional`、`pipe` 等链式方法逐个挂到实例上。
  空闲 Worker 持有约 12,400 个 schema、72.5 万个这样的闭包（40.6 MB），以及大小相近的
  字典模式属性表。Zod 4.6 把同样的方法定义在原型上；实例数不变，但每个进程的闭包降到
  约 1.2 万个。
- Vite 只对裸模块名的解析结果附上包的 `sideEffects`。`@lody/shared` 通过相对路径引用的
  模块因此被当作有副作用，CLI 入口仅为副作用就 import 了 267 个模块。
  `apps/cli/scripts/workspace-module-side-effects.mjs` 按每个工作区包自己的声明处理。
- shared barrel 自己定义的绑定（stream id、room id）只能继续从 barrel 导入，barrel 的
  re-export 边随后就会触达它 re-export 的每个模块。这些工具函数已移到
  `packages/shared/src/loro-streams-routing.ts`。
- `apps/cli/src/index.ts` 为每个命令都组装 Workspace presence，所以连看门狗也会实例化 Loro 和 Flock
  的 wasm。看门狗无论静态还是动态都到不了 `apps/cli/src/lib/loro/doc.ts`；现在它只组装 login-shell
  缓存。MCP host 保留 presence，因为它的工具会经过 `command-runtime` 打开文档。
- vite-plugin-wasm 在 SSR 构建里把 wasm 内联成 base64，而 V8 会保留模块源码，因此每个
  加载 Loro 的进程都在已编译实例之外多留了约 9 MB 的 base64。两个 vendor chunk 从 5.1 MB
  和 3.5 MB 降到 0.31 MB 和 0.11 MB。

## 决策

- `zod` 的 catalog 和 override 从 4.3.6 升到 4.6.7。仓库里没有 `.map(schema.parse)`
  这类把方法单独拆出来调用的写法；方法移到原型后，这种写法会失效。
- `apps/cli/vite.config.ts` 把 `workspaceModuleSideEffects` 作为 Rollup 的
  `treeshake.moduleSideEffects`。没有声明的包仍视为有副作用；第三方依赖保持 Rollup 默认。
- `apps/cli/scripts/external-wasm.mjs` 把每个内联 wasm 模块输出为 `dist/assets/*.wasm`，并修改插件
  的加载函数，使其从磁盘读取 `file:` URL；插件输出格式变化时构建直接失败。所有发行方式都
  拷贝除 sourcemap 外的整个 `dist/`，与 `zstd.wasm` 依赖的约定相同。加载函数仍只实例化一次，
  所以 `wasm-runtime-health` 读到的是同一个 memory 导出。
- 在 Linux 上，Worker 和 MCP host 启动时带 `MALLOC_ARENA_MAX=2`，调用方已设置时除外。
  `apps/cli/src/utils/malloc-arena.ts` 在进程启动时（glibc 已读取之后）删除注入的值，因此 Agent、终端和
  用户命令保持调用方原有的分配器设置。
- 看门狗环境里的 `LODY_WORKER_MAX_OLD_SPACE_MB` 可以覆盖按机器内存计算的 Worker 堆上限；
  无法使用的值会记日志并忽略。默认值仍为内存的 20%，介于 768 到 4096 MiB。

## 备选方案

- `zod/mini` 或懒构造 schema 也能去掉这些闭包，但要改动每个 schema 模块；升级版本无需改
  源码就达到了同样效果。
- 在发现 4.6 已经把方法放到原型上之前，考虑过给 Zod 4.3 打补丁、改成原型上的惰性 getter。
- `treeshake.manualPureFunctions: ['z']` 没有任何效果：schema 被保留是因为模块被当作副作用
  导入，而不是因为调用看起来不纯。
- 给工作区包按模块设置 `manualChunks` 后，看门狗反而加载了 261 个文件，因为 Rollup 会保留
  指向手动 chunk 的副作用导入。
- 一个把 `@lody/shared` 导入改写到声明模块的 Vite 插件，测得结果与「barrel 拆分 + `sideEffects`」
  相同，因此没有保留。
- 把 MCP host 并入 Worker 能省掉一个 Node 实例，但会把同步 SQLite 和工具工作放到 daemon
  事件循环上（[internal MCP loading](2026-10-30-internal-mcp-command-loading.zh.md) 保留了这条边界）。
- 固定一个更低的 Worker 堆默认值可能让现有的重负载失败，所以只加了覆盖开关。空闲时重启
  Worker 需要先做 failure-containment 评审，不在本次改动范围内。

## 测量

Linux x86_64，Node 26.13.1，基线 `bbed0d88b` 的生产 `cli-runtime` bundle，隔离的
`HOME`/`LODY_DATA_DIR`，local 平台，未登录，没有 Agent 和会话。每个进程在 daemon 就绪约
40 秒后、通过 inspector 强制 GC 之后采样。RSS 为 `process.memoryUsage().rss`；堆为
`heapUsed`；Zod 统计 heap snapshot 中名为 `Zod*` 的对象。RSS 会在每个进程里重复计入共享页。

| 步骤 | 看门狗 RSS / 堆 | Worker RSS / 堆 | MCP host RSS / 堆 |
| --- | ---: | ---: | ---: |
| 基线 | 211 / 105 MB | 326 / 181 MB | 260 / 146 MB |
| `sideEffects`、barrel 拆分、看门狗不组装 presence | 151 / 79 MB | 317 / 178 MB | 241 / 141 MB |
| wasm 外置 | 151 / 79 MB | 292 / 171 MB | 219 / 133 MB |
| Zod 4.6.7 | 96 / 29 MB | 182 / 69 MB | 129 / 48 MB |

三个进程的 Zod 实例数仍约为 6,000 / 12,000 / 10,000；挂在实例上的闭包从 34.8 万 / 69.9 万 /
59.2 万降到约 6,500 / 12,200 / 10,600。external 内存在 Worker 中从 18.9 MB 降到 9.2 MB，
在 MCP host 中从 14.7 MB 降到 4.9 MB。arena 上限不影响空闲时的采样；它限制的是峰值之后的
碎片，报告主机曾观察到一次 1.4 GB 峰值后 RSS 一直停在 1.13 GB。

## 验证与局限

- `packages/cli-supervisor/src/process-resources.test.ts` 固定了堆上限覆盖及其拒绝的取值；
  `apps/cli/src/commands/daemon-shared.test.ts` 固定了 daemon 子进程会拿到 arena 上限且不会
  继续向下传递。
- 发布 bundle 冒烟检查（`apps/cli/scripts/check-published-bundle-imports.js`）会加载构建出的
  入口和 worker。
- 繁忙负载、macOS/Windows、Electron 内嵌 CLI 以及报告问题的 arm64 主机都没有测量。看门狗
  仍会通过 `cli-supervisor` 对本地 IPC 的健康检查执行 `message-schemas.ts`；拆分该模块留待以后。
