# Project stack 的测试前置条件

Status: implemented
Translation: current

[Translation](2026-10-24-project-stack-test-prerequisites.md)

## 摘要

Project stack 的每一层都应独立通过检查。原本只存在于顶部的测试修复下移到引入相应依赖的运行时层，保留生产行为和原有断言。

机器注册断言补齐 `multiRepoProject`；Session 文档 fixture 提供 `getMetaState`。重新打开的 Inbox store 使用同一个注入时钟，避免启动过期清理删除测试批次。Electron 测试复用 stack 顶部已有的相对 TypeScript 导入解析器，裸模块和已指定扩展名的导入仍由 Node 解析。

各分支由 CI 独立验证；未安装依赖的临时检出不构成本地运行验证。
