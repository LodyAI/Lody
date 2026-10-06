# 撤回误入的 coding-agent 工作流页面

Status: implemented
Translation: current

PR: [#1273](https://github.com/LodyAI/Lody/pull/1273)

[English](2026-10-06-revert-coding-agent-workflow-pages.md)

## 摘要

请求方已与作者确认，提交 `7700f420440288c1fa8c4f571f851a73b59ca767` 属于误入。
撤回该提交引入的 GUI、远程控制营销页面、入口链接及配套文档变更。
保留后续锚点导航修复及原决策记录，使撤回过程可追溯。
当前嵌套检出未安装依赖，尚无法完成完整构建验证。

## 决策与范围

撤回 [#1150](https://github.com/LodyAI/Lody/pull/1150)，包括路由注册、规范 URL 处理、
共享组件与样式、页脚链接、可选语言切换及页面专用浏览器检查。
移除的 URL 沿用现有未知页面 404 行为，不新增替代重定向。
这是恢复站点原定范围，不改变 agent 运行时或远程访问能力。

保留[原记录](../feature/2026-09-30-coding-agent-workflow-pages.zh.md)作为历史；
本次决策取代其中发布这两个页面的结论。解决 README 和测试重叠冲突时，
保留后续新增的 `anchors` 浏览器阶段以及查询参数、片段导航用例。

## 验证与限制

- 运行现有 FAQ 生成器后，站点单元测试通过。
- 路由与 sitemap 测试、空白检查通过。
- 已尝试根目录 `pnpm check` 和 `pnpm format`，但缺少依赖，`tsgo`、`oxfmt` 不可用。
  仓库规则要求嵌套检出跳过安装。
- 文档检查报告指向未初始化 ACP 子模块的既有链接错误；与开始时的状态比较，
  确认本次未增加错误。当前没有注册 SHA 保护主题。
- 当前检出尚未执行生产构建与浏览器检查。
