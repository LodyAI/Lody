# CI 测试顺序与仅由 main 写入的 pnpm store 缓存

Status: implemented
Translation: current
PR: pending

[English](2026-09-26-ci-test-order-and-pnpm-store-cache.md) | 中文

## 摘要

`Tests` job 要 6–11 分钟，主要原因是 `apps/cli` 的测试（约 158 秒）要等 `@lody/components`（约 351 秒）跑完才开始。pnpm 递归执行脚本时按依赖顺序排队，而 `apps/cli` 经由 `@lody/code-review-helper` 间接依赖 components。递归测试改用 `--no-sort` 后，这两套测试可以并行。另一个问题在缓存：`setup-node` 的 pnpm 缓存只匹配精确的 lockfile key，而且每个 PR 都会各自写一份约 800 MB 的缓存。结果是 lockfile 一有变化就要冷装依赖，macOS 上的 Desktop E2E 从来没有命中过缓存。现在改由一个复合 action 负责恢复 store，精确 key 不命中时按前缀回退，并且只有 `main` 会写入缓存。实测效果见[验证](#验证)。

## 改动前的证据

数据来自 main 上的运行 `36207090914` 和 2026-09-26 各 PR 运行的步骤耗时：

| 项 | 观察 |
| --- | --- |
| `Tests` › `Run tests` | 354–591 秒，是 `CI` 的关键路径；`Static checks` 约 3 分钟。 |
| `@lody/components` | 351 秒，500 个测试文件。collect 占 377 秒 CPU、environment 占 97 秒，测试本体只有 91 秒。 |
| `apps/cli` | 158 秒。它在 01:11:37 才开始，正好紧跟 components 在 01:11:32 结束之后。 |
| 依赖链 | `apps/cli → @lody/code-review-helper → @lody/components`，默认的拓扑顺序因此把两者串行了。 |
| Linux pnpm 缓存 | lockfile 变化后每次都是 `pnpm cache is not found`，因为 `setup-node` 没有前缀回退。 |
| macOS pnpm 缓存 | Desktop E2E 只在 `pull_request` 上触发，`main` 上从来没有 macOS 缓存。每个 PR 首次运行都会 miss：安装 102 秒，之后再花 74 秒保存 786 MB。 |
| 缓存配额 | 共 12 份、每份约 800 MB（约 9.6 GB，上限 10 GB）。其他 PR 读不到的 PR 级缓存把 `main` 的缓存挤掉了。 |

## 决定

1. **递归测试加上 `--no-sort`**，涉及 `test:ci` 和 `.github/scripts/run-ci-tests.mjs`。测试不需要按构建顺序执行，因为每次 Vitest 运行都会自己转换 workspace 源码。并发数和 `--maxWorkers` 都没变，这只是调度上的改动。
2. **新增 `.github/actions/setup-workspace`**，替换 `ci.yml` 和各 Desktop E2E workflow 里的 `pnpm/action-setup` 加 `setup-node` `cache: pnpm`。它用 `actions/cache/restore` 恢复缓存，key 为 `pnpm-store-v1-<os>-<arch>-<lockfile hash>`，回退前缀为 `pnpm-store-v1-<os>-<arch>-`。即使恢复到的是旧 store，pnpm 也只需下载缺少的包。
3. **`.github/workflows/pnpm-store-cache.yml` 是唯一的写入者。** 它在 `main` 上 `pnpm-lock.yaml`（或缓存定义）有变动的 push 时运行，也可以手动触发。它覆盖 Linux、macOS 和 Windows，保存前会先 prune，避免前缀回退让 store 无限增长。这个 workflow 不是必需检查，所以它的 `paths` 过滤和 `ci.yml` 不用 `paths` 的规则并不冲突。

## 暂不采用的方案

- **把 `Tests` 拆成矩阵（components 分片、cli、其余包）。** 这样能进一步缩短关键路径，预计到约 4 分钟。但它需要受影响范围选择器能把包映射到分片，还要一个聚合 job 来保留必需检查名 `Tests`。留给单独的改动。
- **降低 components 每个文件的固定开销**（`isolate: false`、精简 setup）。这是目前剩下的最大开销，但有测试文件之间共享状态的风险。参见 [components test module graph](2026-09-10-components-test-module-graph.zh.md)。
- **缓存 `node_modules`。** store 热的时候安装只要 16–40 秒。考虑到子模块 workspace 带来的失效风险，不值得做。

## 验证

本地（18 核，同样使用 `--workspace-concurrency=2 --maxWorkers=2`）：递归测试按拓扑顺序跑耗时 198 秒，加 `--no-sort` 后 120 秒，全部通过。CI 上改动前后的耗时记录在 PR 中。

## 限制

- 在 `pnpm-store-cache.yml` 第一次在 `main` 上运行之前，还不存在任何 `pnpm-store-v1-*` 缓存，PR 会冷装依赖。旧的 `node-cache-*` 缓存在 7 天没有访问后会自动过期。
- `e2e-scout.yml` 签出的是默认分支，因此要等这次改动合并后才会用上这个复合 action。
