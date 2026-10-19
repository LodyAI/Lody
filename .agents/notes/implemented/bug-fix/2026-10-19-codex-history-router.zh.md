# 恢复 Codex 历史导入路由

Status: implemented
Translation: current

Adapter PR: https://github.com/LodyAI/acp-extension-codex/pull/73

[English](2026-10-19-codex-history-router.md)

## 摘要

Codex 适配器声明支持只读历史，却未在生产路由注册方法，导致 Lody 在读取历史前导入失败。修复在两条 ACP 协议链注册已有的 Core 历史读取和额度查询处理器。回归测试改为生产路由，验证响应、重放和错误行为。适配器检查已通过；当前检出环境尚未完成桌面实际导入验证。

## 原因与修复

适配器 `1404ebae347868b5a49dc0ddefdba833c7a3c63e` 的 `src/index.ts` 使用
`createAcpAgentRouter`，但 v1/v2 链均遗漏 `_lody/session/history/read` 与
`_lody/rate_limits/get`。入口切换（第一父提交链的合并 `51a07ee`）后，能力声明及旧入口
`createCodexAcpApp` 中的注册仍保留。原历史传输测试仅检查旧入口，因此生产缺陷未被发现。

修复为两条生产协议链注册已有处理器及参数校验。宿主导入器和原生历史读取器保持原行为：不回退到
`loadSession`，不恢复会话或写入源历史。相关约定见[只读导入决策](../feature/2026-10-09-dsh-core-capabilities.zh.md)。
根仓库通过子模块指针引入修复，以供内置适配器构建使用。清理旧入口及剩余的目标控制测试不在本次修复范围内。

## 证据与限制

- 生产路由测试覆盖 ACP v1/v2、响应前历史重放、额度查询、非法参数和读取错误传播。
- 临时移除两项注册后，四项新传输测试全部失败；恢复后通过。相关历史读取、初始化和 v2 重放套件共
  17 项通过；已有原生读取测试验证不会获取活跃会话。
- 适配器 `npm run typecheck` 和 `npm run build` 通过。
- 适配器全量 `npm test` 出现远端 401 和无关的 session-index 规范路径测试失败后停止，未通过。
- 根仓库 `pnpm check`、`pnpm format` 已尝试，但缺失根依赖 `tsgo` / `oxfmt`；未在嵌套检出中安装。
  `pnpm run docs check` 报告其他未初始化适配器子模块的链接错误，本记录未报告错误。
  `git diff --check` 通过。
- 未导入或修改真实用户历史。桌面重建和实际导入仍需端到端确认；单元测试不代表已发布。
