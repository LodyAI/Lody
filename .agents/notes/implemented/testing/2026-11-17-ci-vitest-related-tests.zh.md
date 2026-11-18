# PR 的 Vitest 套件收窄到相关测试

Status: implemented
Translation: current

[English](2026-11-17-ci-vitest-related-tests.md) | 中文

此前：[CI 受影响测试](2026-09-07-ci-affected-tests.zh.md) 按包选择，并把 Vitest `--changed` 作为备选方案 5 否决。本笔记重新评估该方案。

## 摘要

包级受影响选择仍会运行每个依赖包的全部测试：`packages/shared` 改一个文件，`components` 和 `cli` 整套重跑。现在，当 affected PR 范围里的每个改动文件都是 `src/`、`test/` 或 `tests/` 目录下仍存在的模块时，`components`、`cli` 和单次启动的 rest Vitest 运行改用 `vitest related`，只运行导入图能到达改动文件的测试文件。Vitest 无法追踪的改动保持整套运行，`main` 推送仍是完整运行，漏掉的依赖会在合并后暴露，而不会无人测试。

## 决策

- `.github/scripts/related-test-files.mjs` 返回改动文件列表或 null。只收窄 `affected` 范围；忽略 Markdown；配置、setup、`__mocks__`、fixtures、非模块文件、`apps/` 与 `packages/` 之外的文件、ACP 子模块和已删除文件都返回 null。
- `run-ci-tests.mjs`（CI）与 `scripts/run-local-tests.mjs`（本地 `check:affected`）共用该函数。独立套件运行 `pnpm --filter <pkg> exec vitest related --run --passWithNoTests`，路径相对包目录；rest 组用 `test:rest:related`，保留同样的 `--project` 过滤。分片保留，空分片视为通过。
- Electron、site-docs、仓库脚本等非 Vitest 套件保持包级选择。

## 方案 5 为何不再落选

2026-09-07 的否决理由是多种 runner 混用和看不到 monorepo 依赖图。收窄只作用于 Vitest 套件，其他 runner 不受影响。依赖图也并非不可见：workspace 包解析到源码，从 `packages/components` 运行 `vitest related` 能为 `packages/shared/src` 的改动选出测试。

2026-11-17 实测（Linux，8 核）：

| 改动文件 | 套件 | 相关 / 全部测试文件 |
| --- | --- | --- |
| `packages/components/src/components/AppInitializer.tsx` | components | 1 / 446 |
| `apps/cli/src/lib/acp-agent-attachments.ts` | cli | 40 / 332 |
| `packages/shared/src/acp-model-capabilities.ts` | shared（rest） | 32 / 84 |
| `packages/shared/src/acp-model-capabilities.ts` | components | 360 / 446 |

被广泛导入的模块仍会选中大部分套件，因此叶子文件改动收益最大。

## 影响

- PR 上会漏掉静态导入之外的影响：计算出的动态导入、从磁盘读取的文件、模块注册表技巧。`main` 和 `ci-full` 标签仍运行整套。
- 改动过的 setup 或配置文件若被改名到 setup/config 模式之外，需要同步修改该函数。
