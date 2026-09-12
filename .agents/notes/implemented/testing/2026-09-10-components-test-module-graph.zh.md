# 收缩组件测试的模块图

Status: implemented
Translation: current

[English](2026-09-10-components-test-module-graph.md)

## 摘要

`@lody/components` 套件耗时约十分钟，因为 Vitest 会隔离其 446 个文件中的每一个，并重新求值每个
文件的整张导入图；断言本身占用的挂钟时间远不到五分之一。追踪 `vite-node` 显示，仅一个菜单测试就
拉入了 991 个模块，且几乎没有一个来自 `node_modules`，于是移除了四处偶然的图重量来源：一个拖入
`react-day-picker` 的未使用 `Calendar` 再导出、`date-fns/locale` 的 barrel 导入、一个被急切 glob
的含 324 个图标 SVG 的目录，以及两个 Vite 插件加上一条只有生产构建才需要的通配 `tsconfig` 路径
映射。该测试现在加载 667 个模块。挂钟时间的效果**未被证实**：测量主机上的多次运行方差超过了被测
效果本身，而「20 秒套件」的目标在不关闭隔离的前提下无法达到，而关闭隔离目前会因待完成的异步工作
而崩溃。

## 决策

Vitest 的 `collect` 阶段——导入测试文件并求值其传递图——主导了本套件的耗时。隔离意味着这项工作按
文件重复，因此在不触碰隔离的前提下，唯一可用的杠杆就是图本身的大小。通过对 `DEBUG=vite-node:*`
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

关闭隔离是唯一能达到 20 秒套件的改动，因为它把 446 次图求值变成每个 worker 一次。该方案已被测量
并暂时否决：在 `isolate: false` 下，一次运行最多能成功跑完六个文件，到第七个就失败——无论第七个是
哪个文件——tinypool 报告 `Unhandled Rejection: Terminating worker thread`。把 worker 堆提升到 8 GB
也没有帮助，因此这是隔离目前所遏制的、泄漏出来的待完成异步工作，而非内存压力。446 个文件中还有 89
个使用 `vi.mock`，其注册表在关闭隔离后会被共享。两者都是按文件逐个清理的项目。

## 证据与限制

模块数量是确定性的，取自对 `tests/session-header-menu.test.tsx` 运行 `DEBUG=vite-node:*`：改动前
991 个请求，改动后 667 个，其中 `date-fns` 模块降至 3 个、`react-day-picker` 降至 0 个。原先 991 个
中只有 11 个来自 `node_modules`，这印证了 externalize 本就在生效，重量来自一方代码。jsdom 被排除
为原因：单个文件在 `environment` 上约花费 1.2 秒。

**挂钟时间的改进未经验证。** 测量主机上的计时在所需分辨率上不可复现——同一基线配置在一个相同的
112 文件分片上冷跑测得 97 秒、热跑测得 128 秒，其离散度宽于此处所声称的任何效果。本工作中更早的
单文件数据是跨越会使 Vite 缓存失效的配置改动取得的，不应作为证据。可信的数字需要在安静主机上重复
运行。

本工作期间完整套件从未跑完；三次尝试都被环境的后台任务限额终止。正确性通过一次 `--shard=1/4` 运行
（112 个文件、912 个测试，全部通过）以及触及被改模块的测试进行检查，`typecheck` 与 `lint` 在仓库
范围内通过。该套件还需要 `NODE_ENV=test`：在 `NODE_ENV=production` 下 React 会解析到不导出 `act`
的构建，仅此一项就会让 154 个文件失败。

此处固定的是 Vitest 3.2.4；与本问题相关的 `fsModuleCache` 与 `vitest doctor` 要到 Vitest 4 才有，
而工作区的部分包已在使用 Vitest 4。
