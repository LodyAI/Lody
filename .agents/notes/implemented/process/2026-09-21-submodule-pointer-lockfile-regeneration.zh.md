# 子模块指针更新后必须重新生成 lockfile

Status: implemented
Translation: current
PR: [#2191](https://github.com/LodyAI/Lody/pull/2191)

[English](2026-09-21-submodule-pointer-lockfile-regeneration.md)

## 摘要

CI 在冻结安装前会递归检出子模块，因此 workspace 内适配器的 manifest 也属于
根 lockfile 的依赖图。只更新指针而没有匹配的解析结果，会让无关检查也在测试前
被阻断。lockfile 保持与这些 manifest 一致，只为仍在七天隔离期内的已选定版本
提供精确例外。各平台包的依赖图保持完整，后续版本仍受隔离策略约束。

## 决策

- 凡是改动 workspace 内子模块指针的提交,都必须在同一提交里执行
  `pnpm install --no-frozen-lockfile` 重新生成 `pnpm-lock.yaml`。该故障是全局
  性的:`--frozen-lockfile` 会直接中断安装,于是 Static checks、Tests 与
  Desktop E2E 都在第一步失败,永远执行不到真正的断言。
- 子模块新要求的版本可能仍在七天的 `minimumReleaseAge` 窗口内。用精确的
  `name@version` 条目加入 `minimumReleaseAgeExclude` 做一次性豁免——该列表本就
  为此存在。回退子模块指针、或把该子模块移出 workspace,均已否决:指针更新承载
  着上游产品改动,而 `apps/cli` 的 `workspace:*` 依赖要求它必须在图内可解析。
- pnpm 10.20 对每个包采用第一条匹配的例外规则。因此扩展已有的精确版本规则，
  并覆盖所有可选平台包，而不是增加会被忽略的后续规则。
  [Codex 修复记录](../bug-fix/2026-10-27-codex-root-lockfile.zh.md)解释了同一约束。

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
(2026-09-20)把 `packages/acp-extension-claude` 指到 `56b94c6c`；该指针
在当时的 `main` 上完全相同，因此该不匹配先于受影响的分支存在。

十个版本中有七个发布已超过七天。三个根包及 `@vitest/*` 同一发布序列尚未满足,
它们也是 `minimumReleaseAgeExclude` 唯一的新增项:

- `@anthropic-ai/sdk@0.126.0`
- `prettier@3.9.7`
- `vitest@5.0.1` 及其 `@vitest/{expect,mocker,pretty-format,runner,snapshot,spy,utils}@5.0.1`

`@agentclientprotocol/sdk@1.4.0` 最初被加入,核对发布日期后又移除——它已远超该
窗口,必须继续走正常策略解析。

[11 月 1 日的 PR 合并检查](https://github.com/LodyAI/Lody/actions/runs/41306898438/job/124849039169)
再次暴露同一边界：合并后的 Claude 子模块要求 Agent SDK `0.3.316`，根 importer
却仍选择 `0.3.293`，所有测试组都在安装依赖时中止。修复保留其他已锁定解析结果，
并复制已选 SDK 完整的八个平台依赖图。

## 验证

冻结安装验证递归固定的子模块 manifest 与根 lockfile 一致。先审查依赖图差异及
可选平台条目，再做格式、类型、静态和行为检查。仍持有旧子模块源码的本地检出，
无法证明合并后的版本能够安装；推送后的合并检查仍是集成边界。
