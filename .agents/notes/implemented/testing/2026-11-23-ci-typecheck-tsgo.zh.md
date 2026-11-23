# 以并发 2 全部改用 tsgo 做类型检查；components 仍由各个使用方各自检查

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/3226

[English](2026-11-23-ci-typecheck-tsgo.md) | 中文

## 摘要

`Static checks` 的类型检查要花 150–220 秒，最后结束的是 `apps/mobile-capacitor`：它是唯一还在用单线程 `tsc` 的程序。它和 `apps/electron` 的渲染进程程序一样，通过源码路径别名引用整个 `packages/components`，因此 48 万行的 components 源码会被检查三遍。现在 mobile 和 `e2e` 套件都改用 `tsgo`，同一个 mobile 程序的检查结果不变，耗时从 94 秒降到 13 秒。由于三个大型 tsgo 程序随后会同时运行，类型检查的工作区并发从 4 降到 2：并发为 4 时峰值内存达到 18 GB，导致 16 GB 的 CI runner 被杀掉。改为让使用方只检查 components 的类型声明、不再重复检查源码的方案经过实测后被否决：每个使用方只省约 30 CPU 秒，需要先修复声明生成错误，还会丢掉只有使用方自己的编译选项和路径覆盖才能做出的检查。

## 证据

CI 运行 `45154663628`（4 vCPU runner）：其他包都在 10:19:57 前结束；mobile-capacitor 的 `tsc` 一直跑到 10:20:58，单独约 150 秒。

本地测量，2026-11-23，Linux arm64，16 核，tsgo 7.0.0-dev.20251217.1，每个程序单独运行：

| 程序 | 文件数 | 墙钟时间 | CPU | 内存 |
| --- | --- | --- | --- | --- |
| `packages/components` | 6953 | 14.4 秒 | 74 秒 | 4.6 GB |
| `apps/electron` `tsconfig.web.json` | 6341 | 12.9 秒 | 68 秒 | 4.3 GB |
| `apps/mobile-capacitor` `tsconfig.app.json`，tsgo | 6450 | 12.7 秒 | 68 秒 | 4.3 GB |
| `apps/mobile-capacitor` `tsconfig.app.json`，`tsc` | 6445 | 94 秒 | 117 秒 | 3.5 GB |
| 全部 14 个 tsgo 程序 | — | 66 秒 | 347 秒 | — |

整个根目录类型检查，每 0.5 秒采样一次所有进程的常驻内存之和：

| 核数 | 并发 | 墙钟时间 | 峰值内存 |
| --- | --- | --- | --- |
| 4（`taskset -c 0-3`） | 4 | 82 秒 | 18.1 GB |
| 4（`taskset -c 0-3`） | 2 | 79 秒 | 12.0 GB |
| 16 | 4 | 24 秒 | — |
| 16 | 2 | 35 秒 | — |

第一次以并发 4 使用 tsgo 的 CI 运行（`45169803765`）失去了 `Static checks` 的 runner：类型检查步骤在 94 秒后被取消，job 一直没有报告完成，与 16 GB runner 内存耗尽被杀的表现一致。

## 决定

所有 Lody 自有的类型检查脚本都运行 `tsgo --noEmit`，和其他包一样从根目录的 `@typescript/native-preview` 开发依赖解析。ACP adapter 子模块保留各自的 `tsc` 构建：它们要产出构建产物，并且独立维护。根目录 `typecheck` 脚本、`.github/scripts/run-ci-typecheck.mjs` 和 `scripts/run-local-check.mjs` 都以 `--workspace-concurrency=2` 运行类型检查，使 CI runner 和 16 GB 开发机的峰值内存保持在 16 GB 以下。16 核机器为此多花约 11 秒。

## 被否决的方案

- **使用方检查 components 的类型声明而不是源码。** 为 components 生成声明需要 20 秒，并报告 13 个错误：stories、`src/ui/drawer.tsx` 以及 components 引用的 electron 主进程模块中存在无法命名的推断类型。把 mobile 原型程序指向这些声明后，CPU 从 68 秒降到 37 秒，但出现 207 个错误，来源是生成失败导致类型退化，以及仍然解析到源码的模块。在 4 vCPU runner 上大约只省 15 秒墙钟时间。代价是引入构建顺序（使用方要等声明生成完）并丢失覆盖：mobile 对 `@/components/settings/account-setting` 的覆盖，以及各使用方更严格的选项（`noUnusedLocals`、lib 和 JSX 设置），之所以能在 components 的调用处得到检查，正是因为使用方检查了这些源码。只有当 components 不再引用 electron 主进程模块、并且使用方不再覆盖 components 模块时，才值得重新评估。

## 验证

- 使用 tsgo 时，mobile 的 app 与 e2ee 程序以及 e2e 程序都没有错误；在每个程序中注入的类型错误都能被报告。e2e 程序在 tsgo 和 `tsc` 下列出的文件同为 81 个。
- CI 运行 `45172325099`（强制全量，并发 2）：`Typecheck (forced full)` 用时 88 秒，此前为 160–220 秒；`Static checks` 用时 191 秒。仅一次运行，未评估 runner 的波动。
