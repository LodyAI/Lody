# CI 按受影响范围跑测试，并跳过纯文档 PR

Status: implemented
Translation: pending
PR: https://github.com/LodyAI/Lody/pull/499

[English](2026-09-07-ci-affected-tests.md) | 中文

## 摘要

当前 `CI` 对每个 PR 都跑完整 typecheck、`check:quick` 和 `pnpm test:ci`。这对 `main` 和枢纽包改动是对的，但文档 PR 和叶子包 PR 会浪费大量时间。本方案已落地：可单测的选择器 `.github/scripts/select-ci-scope.mjs`，把 PR 分成 `skip-tests`、`affected`、`full`。纯文档/notes/specs 跳过 Tests（含该 job 的 `pnpm install`）以及 Static 里的 typecheck/`check:quick`；其余 PR 只跑改动包及其传递 dependents。`main` 与 `workflow_dispatch` 仍全量。必填 check 名保持 `Static checks` 和 `Tests`。跳过必须保守：YAML 只在输出字面量 `false` 且 allowlist 未强制全量时才跳过；选择器算不清就全量。完整实现细节以英文稿为准，中文翻译尚未补齐。

## 问题

`.github/workflows/ci.yml` 无路径门控。测试量大约是 components 451、CLI 264、shared 94。`@lody/shared` 改动几乎全量；CLI 不直接依赖 components，但 components 经 `@lody/code-review-helper` 仍会带上 CLI。E2E 已有路径门控；主 CI 没有。GitHub 在 required workflow 上使用 `paths-ignore` 或 `[skip ci]` 会让 check 一直 Pending。

## 关键决定

1. 三种模式、一个脚本：`skip-tests` | `affected` | `full`。YAML 可以强制全量，但不能在缺少输出时跳过。
2. 选择器内联进两个必填 job，不要单独的 selector job。`needs` 失败会把 Tests 跳成 Success。
3. 不用 pnpm `[since]`（two-dot diff / 浅克隆问题）。在选择器内 fetch `base.sha`，自己做 `git diff`。
4. 传递 dependents 用 pnpm `...pkg`（包 + 依赖它的包），不是 `pkg...`。`components → helper → lody` 必须保留。
5. `mode=full` 调用现有 `pnpm typecheck` / `pnpm test:ci` / `pnpm check:quick`，零行为漂移。
6. 未知路径 fail-open 到 `full`。YAML bash allowlist 在 `.github/scripts/**`、`.github/workflows/**`、lockfile、workspace yaml、根 `package.json` 变更时忽略 PR 头上的分类器。
7. 逃生舱：打 `ci-full` 标签后再 push。不要加 `labeled` 触发，否则 `scope:*` 每次都会重跑。
8. 先合选择器测试（不改 `ci.yml`），再一次接线。不要把 Layer 1/2 拆成两次 `ci.yml` 修改。
9. 保留 electron 最后跑，以及 claude/codex 排除。
10. `check:quick` 不做包级 affected，只在 `skip-tests` 时整段跳过。
11. Tests/typecheck 真正跑时，始终先 `prepare:acp-adapters`。

## PR 计划

### PR 1 — `test: add CI affected-scope selector and runners`

只加脚本和 fixtures，以及本 note（`proposed`）。不改 `ci.yml`。现有 Static checks 的 `node --test .github/scripts/*.test.mjs` 会跑新测试。

按维护者要求，选择器与 `ci.yml` 接线放在同一个 PR。跳过条件必须是：仅当 `force_full != 'true' && run_* == 'false'`。回滚 = revert 该 PR。

## 未决（不阻塞实现）

- `check:quick` 以后是否按路径切 oxlint。
- CLI 是否应停止依赖 code-review-helper 的 React/components 图（那是产品图，不是 CI 作弊）。
- 用 `pulls.listFiles` 做交叉日志（不当门闩）。

实现合同、YAML 片段、glob 列表、37 条 fixtures 见 [英文稿](2026-09-07-ci-affected-tests.md)。
