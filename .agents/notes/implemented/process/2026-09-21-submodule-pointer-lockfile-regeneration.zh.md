# 子模块指针更新后必须重新生成 lockfile

Status: implemented
Translation: current

[English](2026-09-21-submodule-pointer-lockfile-regeneration.md)

## 摘要

CI 会递归检出所有子模块并执行 `pnpm install --frozen-lockfile`,而
`packages/acp-extension-claude` 处于根 pnpm workspace 内(`packages/*`,且
`apps/cli` 通过 `workspace:*` 依赖它),因此它的 `package.json` 属于 lockfile
必须匹配的依赖图。提交 `ac8b2c3a` 把该指针推到上游更新的提交,其依赖版本已被
提升,却没有重新生成 `pnpm-lock.yaml`。自此以后 `main` 一直在安装这一步失败,
根本走不到 Typecheck、Lint 或测试。修复方式是重新生成 lockfile,并对仍处于
`minimumReleaseAge` 窗口内的版本做一次精确豁免——这正是该列表里既有条目的用途。

## 决策

- 凡是改动 workspace 内子模块指针的提交,都必须在同一提交里执行
  `pnpm install --no-frozen-lockfile` 重新生成 `pnpm-lock.yaml`。该故障是全局
  性的:`--frozen-lockfile` 会直接中断安装,于是 Static checks、Tests 与
  Desktop E2E 都在第一步失败,永远执行不到真正的断言。
- 子模块新要求的版本可能仍在七天的 `minimumReleaseAge` 窗口内。用精确的
  `name@version` 条目加入 `minimumReleaseAgeExclude` 做一次性豁免——该列表本就
  为此存在。回退子模块指针、或把该子模块移出 workspace,均已否决:指针更新承载
  着上游产品改动,而 `apps/cli` 的 `workspace:*` 依赖要求它必须在图内可解析。

## 证据

`main` 在 `fe12e901` 上 `pnpm install --frozen-lockfile` 的报错:

```text
ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because
pnpm-lock.yaml is not up to date with packages/acp-extension-claude/package.json
  10 dependencies are mismatched
  - @agentclientprotocol/sdk (lockfile: 1.3.0, manifest: 1.4.0)
  - @anthropic-ai/sdk         (lockfile: 0.117.1, manifest: 0.126.0)
  - @tsconfig/node22          (lockfile: 22.0.5, manifest: 22.0.6)
  - @types/node               (lockfile: 26.2.0, manifest: 26.5.1)
  - @typescript-eslint/eslint-plugin (lockfile: 8.67.0, manifest: 8.70.0)
  - @typescript-eslint/parser (lockfile: 8.67.0, manifest: 8.70.0)
  - eslint                    (lockfile: 10.8.1, manifest: 10.10.0)
  - globals                   (lockfile: 17.11.0, manifest: 17.12.0)
  - prettier                  (lockfile: 3.9.6, manifest: 3.9.7)
  - vitest                    (lockfile: 4.1.10, manifest: 5.0.1)
```

时间线:`a870b1b1`(2026-09-17)最后一次重新生成 lockfile;`ac8b2c3a`
(2026-09-20)把 `packages/acp-extension-claude` 指到 `56b94c6c`;该指针在 `main`
上完全相同,因此没有任何分支引入这个不匹配。

十个版本中有七个发布已超过七天。三个根包及 `@vitest/*` 同一发布序列尚未满足,
它们也是 `minimumReleaseAgeExclude` 唯一的新增项:

- `@anthropic-ai/sdk@0.126.0`
- `prettier@3.9.7`
- `vitest@5.0.1` 及其 `@vitest/{expect,mocker,pretty-format,runner,snapshot,spy,utils}@5.0.1`

`@agentclientprotocol/sdk@1.4.0` 最初被加入,核对发布日期后又移除——它已远超该
窗口,必须继续走正常策略解析。

## 验证

`pnpm install --frozen-lockfile` 现已通过。使用重新生成的 lockfile:
`pnpm format:check`、`pnpm typecheck`、`pnpm check:quick` 均通过;
`@lody/components` 报告 478 个文件、3761 个用例通过。lockfile 的改动仅限这些
开发工具链及其传递边(eslint 10.10.0、globals 17.12.0、prettier 3.9.7、
vitest 4.1.11/5.0.1 以及新的 `cacheable`/`file-entry-cache`/`flat-cache` 依赖树),
运行期依赖没有变化。
