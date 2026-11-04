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
根仓库子模块指针使用 PR #73 合并后的适配器提交 `df464ab`。清理旧入口及剩余的目标控制测试不在本次修复范围内。

## 证据与限制

- 生产路由测试覆盖 ACP v1/v2、响应前历史重放、额度查询、非法参数和读取错误传播。
- 临时移除两项注册后，四项新传输测试全部失败；恢复后通过。相关历史读取、初始化和 v2 重放套件共
  17 项通过；已有原生读取测试验证不会获取活跃会话。
- 适配器 `npm run typecheck` 和 `npm run build` 通过。
- 适配器全量 `npm test` 出现远端 401 和无关的 session-index 规范路径测试失败后停止，未通过。
- 未导入或修改真实用户历史。桌面重建和实际导入仍需端到端确认；单元测试不代表已发布。

## CI 测试时钟修正

CLI 重连回归测试首次打开 Operation Store 时注入 2026-10-12 的固定时钟，重开却使用
`Date.now`。七天后，打开时的保留期清理正确删除已消费的 Operation 及 unknown 批次，导致断言依赖运行日期。
测试夹具现在暴露并复用同一时钟；生产清理逻辑及禁止重放的断言均保留。仅撤回重开时钟注入即可复现 CI
失败，恢复后针对性测试通过。

此 worktree 没有归属的父级 pnpm workspace；之前认为不能安装依赖的判断不正确。
这里已成功完成锁定依赖安装及 ACP 适配器构建。根仓库验证结果记录在 PR 中。
