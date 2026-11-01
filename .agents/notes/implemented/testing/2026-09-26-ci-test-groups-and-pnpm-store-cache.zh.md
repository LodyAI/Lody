# CI 测试按组分到独立 runner，pnpm store 缓存只由 main 写入

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/992

[English](2026-09-26-ci-test-groups-and-pnpm-store-cache.md) | 中文

## 摘要

`Tests` job 要跑 6–11 分钟。其中大部分时间是在同一台 4 vCPU runner 上先跑 `@lody/components`（约 351 秒），再跑 `apps/cli`（约 158 秒）。在同一个 job 里让两者重叠（`pnpm -r --no-sort`）没有效果：runner 的 CPU 已经跑满，重叠后两套测试分别变成 509 秒和 252 秒。现在 `Tests` 改成了矩阵：components 分成三个 Vitest 分片，cli 一组，其余的包一组，每组各占一台 runner，再由一个聚合 job 保留必需检查名 `Tests`。另外，`setup-node` 的 pnpm 缓存只匹配精确的 lockfile key，而且每个 PR 都会各自写一份约 800 MB 的缓存。现在改由一个复合 action 恢复 store，精确 key 不命中时按前缀回退，并且只有 `main` 会写入缓存。预热安装在 prune 前使用硬链接导入，让 macOS 保留已安装的包。

## 改动前的证据

数据来自 main 上的运行 `36207090914` 和 2026-09-26 各 PR 运行的步骤耗时：

| 项                    | 观察                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Tests` › `Run tests` | 354–591 秒，是 `CI` 的关键路径；`Static checks` 约 3 分钟。                                                                               |
| `@lody/components`    | 351 秒，500 个测试文件。collect 占 377 秒 CPU、environment 占 97 秒，测试本体只有 91 秒。                                                 |
| `apps/cli`            | 158 秒。它在 01:11:37 才开始，正好紧跟 components 在 01:11:32 结束之后。                                                                  |
| 依赖链                | `apps/cli → @lody/code-review-helper → @lody/components`，pnpm 默认的拓扑顺序因此把两者串行了。                                           |
| Linux pnpm 缓存       | lockfile 变化后每次都是 `pnpm cache is not found`，因为 `setup-node` 没有前缀回退。                                                       |
| macOS pnpm 缓存       | Desktop E2E 只在 `pull_request` 上触发，`main` 上从来没有 macOS 缓存。每个 PR 首次运行都会 miss：安装 102 秒，之后再花 74 秒保存 786 MB。 |
| 缓存配额              | 共 12 份、每份约 800 MB（约 9.6 GB，上限 10 GB）。其他 PR 读不到的 PR 级缓存把 `main` 的缓存挤掉了。                                      |

## 更正：在同一个 job 里重叠两套测试没有用

第一版方案只保留一个 job，加上了 `--no-sort`。在 18 核机器上，递归测试从 198 秒降到 120 秒。到了 CI 上（PR #992，运行 `36211393445`），两套测试确实重叠了，但 components 变成 509 秒，cli 变成 252 秒，`Run tests` 步骤共 537 秒，和原来的耗时范围差不多。真正的瓶颈是 runner 的 4 个 vCPU，而不是执行顺序。`--no-sort` 仍保留在根目录的 `test:ci` 和 `rest` 组里：它对多核机器有帮助，也没有代价。但缩短 CI 靠的不是它。

## 决定

1. **把 `Tests` 按 runner 拆成几组**（`.github/scripts/run-ci-tests.mjs` 的 `--group`）：
   - `components`：分成三个分片，执行 `vitest --shard=k/3 --maxWorkers=4`。
   - `cli`：`--maxWorkers=4`。
   - `rest`：先跑 `test:scripts`，再跑其余所有包，最后跑 electron。

   每组根据受影响范围自己规划要执行的命令，名单里没有本组的包时就连安装都跳过。scope 输出缺失或无效时，仍然回退为全量。CI 定义文件有改动时，YAML 覆盖逻辑会传入 `--full`。最后的 `Tests` job `needs` 整个矩阵，只有矩阵全部成功它才成功，因此必需检查名保持不变。

2. **新增 `.github/actions/setup-workspace`**，替换 `ci.yml` 和各 Desktop E2E workflow 里的 `pnpm/action-setup` 加 `setup-node` `cache: pnpm`。它用 `actions/cache/restore` 恢复缓存，key 为 `pnpm-store-v2-<os>-<arch>-<lockfile hash>`，先按 `pnpm-store-v2-<os>-<arch>-` 前缀回退，再按 v1 前缀回退。即使恢复到的是旧 store，pnpm 也只需下载缺少的包。
3. **`.github/workflows/pnpm-store-cache.yml` 是唯一的写入者。** 它在 `main` 上 lockfile 或缓存定义有变动的 push 时运行，也可以手动触发。它覆盖 Linux、macOS 和 Windows，通过 `--package-import-method=hardlink` 安装，保存前会先 prune。它不是必需检查，所以它的 `paths` 过滤和 `ci.yml` 不用 `paths` 的规则并不冲突。

## 缓存预热约束

pnpm 10.20.0 的 `store prune` 会删除硬链接计数为一的文件。macOS 克隆导入的文件即使仍被
已安装的包使用，也保持这个计数。
[macOS 预热 job](https://github.com/LodyAI/Lody/actions/runs/40985276235/job/123834729676)
下载了 2184 个包，prune 又全部删掉，最终保存的缓存只有 18626 字节。
后续消费者虽然报告精确命中，实际却没有复用任何包。

硬链接导入让 prune 继续按引用关系保留文件，无需把回退 store 中所有过期包都留下。
v2 key 绕开旧 key 的精确命中保护，让 `main` 重新填充已有的空缓存；v1 仅保留为回退来源，
让健康的旧 store 在过渡期间继续贡献依赖。缓存复用仍受操作系统、架构、lockfile 和分支访问范围约束。

使用同版 pnpm 的隔离离线 fixture 中，硬链接安装后 prune 会保留两个 store 文件，
克隆安装则会丢失两个文件。将保留的 store 打包并恢复到另一目录，后续离线安装能够复用该包。
这验证了缓存机制，不代表已经测得 CI 提速。

## 取舍与其他方案

- 测试 runner 从 1 台变成 5 台。每台都要花约 70 秒做 checkout、缓存恢复、安装和 adapter 准备，所以 runner 总分钟数会上升。本仓库是公开仓库，标准 runner 不收费。不受影响的组会跳过安装。
- **降低 components 每个文件的固定开销**（`isolate: false`、精简 setup）。这仍是最大的 CPU 开销，还没有处理，而且有测试文件之间共享状态的风险。参见 [components test module graph](2026-09-10-components-test-module-graph.zh.md)。
- **缓存 `node_modules`。** 没有做：store 热的时候安装只要 16–40 秒。

## 验证

- 本地逐组用 `--full` 运行，全部通过。三个分片各覆盖 168 个文件；`rest` 跑的正好是原来的包集合去掉 components 和 cli。
- 拆分和缓存恢复在 CI 上的耗时记录在 PR #992 中。

## 限制

- 更新后的预热 workflow 在 `main` 运行后才会生成 v2 store。在此之前，PR 仍可恢复 v1，包括已有的 macOS 空缓存；精确命中标志本身不能证明依赖得到复用。
- Vitest 分片按文件数切分而不是按耗时，测试增长后各分片的耗时可能逐渐拉开。
