# 收缩组件测试的模块图

Status: implemented
Translation: current

[English](2026-09-10-components-test-module-graph.md)

## 摘要

组件套件反复转换模块、求值导入图的成本高于断言本身。测试统一使用工作区 catalog 中的
Vitest 5.0.2、持久化 `fsModuleCache`，并通过 projects 复用安全的 Node/jsdom 模块图；
使用模块 mock 或持有长期进程、浏览器资源的文件继续隔离。减少意外导入仍有价值，尤其对隔离文件。
共享 worker 需要明确清理状态；转换缓存预热和测试通过都不代表产品性能验收。

## 决策

Vitest 的 `collect` 阶段——导入测试文件并求值其传递图——主导了本套件的耗时。隔离文件仍按文件重复求值，允许复用的项目则在每个 worker 内共享模块图。
图本身的大小对两条路径都构成独立成本。通过对 `DEBUG=vite-node:*`
的请求排序，找到了四处彼此独立的来源：

- `src/ui/index.ts` 再导出了 `src/ui/calendar.tsx`，其 `react-day-picker` 依赖会拉入 `date-fns`、
  `date-fns-jalali` 与 `@date-fns/tz`。`Calendar` 组件在整个仓库中没有任何调用方。已删除，并一并
  删除 `react-day-picker` 依赖；这还为产品 bundle 减少了 3.6 MB。
- 有八个模块从 `date-fns/locale` barrel 导入 `{ enUS, zhCN }`，而该 barrel 原生会加载全部 96 个
  locale。它们现在深层导入 `date-fns/locale/en-US` 与 `date-fns/locale/zh-CN`，两者都是已声明的
  导出。
- `new URL(\`./files/${name}.svg\`, import.meta.url)` 会让 Vite 急切地把整个图标目录（324 个 SVG
  模块）glob 进 `FileIcon` 的每一个消费者。对 bundle 而言这是正确的（它本来就要产出这些资源），
  因此把这两处调用移到 `file-icons/asset-url.ts`，测试配置只为该模块设置 alias 到桩实现。把整个
  `file-icons` 入口替换为桩被否决，因为 `file-tree-virtual-rows.test.tsx` 会真实地验证其组件缓存。
- 测试配置移除了 `vite-plugin-top-level-await`（Node 与 Vitest 原生支持顶层 await；loro WASM 套件
  在没有它的情况下也通过），并用显式 alias 取代 `vite-tsconfig-paths`，因为 `tsconfig` 的通配映射
  `"*": ["./*"]` 会让该插件为每个模块中的每个裸 specifier 探测文件系统。`vite.config.ts` 保留两者：
  生产 bundle 确实需要顶层 await 降级，其目标平台也不是这个文件要操心的事。

根 catalog 为公共工作区统一固定 Vitest 5.0.2。组件配置按文件声明的测试环境划分项目。
使用模块 mock API（`vi.mock`、`doMock`、`unmock`、`doUnmock`、`resetModules`、`hoisted`）的文件，
以及明确列出的长期浏览器、进程资源持有者继续隔离，其余文件使用 `isolate: false`。
共享 setup 恢复 spy、定时器、环境变量、全局属性描述符、存储和 DOM 状态。测试仍负责自己的
React root、监听器和异步工作；文件专用的 worker 与 native-share mock 保持局部作用域。

`test.fsModuleCache: true` 将模块转换结果保存在磁盘，供后续进程复用。这不同于在 worker 内复用
已求值的模块图，也不能代替状态清理。CLI 和本地 rest 聚合启用相同的磁盘缓存选项，同时保留各包的
alias、WASM 插件和工作目录。

此前在 Vitest 3.2.4 上关闭隔离的实验曾报告 worker 终止，增加到 8 GiB 堆也没有解决。
这个观察不足以证明普遍性的泄漏原因，也不能据此禁止当前 runner 复用模块图。仍然不能对全部文件
关闭隔离：模块 mock 注册表和长期资源持有者需要独立上下文。

## 证据与限制

模块数量是确定性的，取自对 `tests/session-header-menu.test.tsx` 运行 `DEBUG=vite-node:*`：改动前
991 个请求，改动后 667 个，其中 `date-fns` 模块降至 3 个、`react-day-picker` 降至 0 个。原先 991 个
中只有 11 个来自 `node_modules`，这印证了 externalize 本就在生效，重量来自一方代码。jsdom 被排除
为原因：单个文件在 `environment` 上约花费 1.2 秒。

此前只缩减模块图的耗时证据没有定论：同一主机上的相同 112 文件分片曾测得冷运行 97 秒、
热运行 128 秒。这些数字不能说明当前 runner、隔离划分或缓存改动的效果。当前测量必须区分冷模块
缓存与已预热运行，并说明 worker 数量；本地 check 两分钟目标不是产品性能保证。

保持 `NODE_ENV=test`，生产 React 构建不导出 `act`。共享运行通过不构成将模块 mock 文件或长期
浏览器资源持有者移出隔离项目的依据。源文件变化会使磁盘转换结果失效；出现新的资源归属风险时，
需要重新核对项目划分和文件自己的清理。
