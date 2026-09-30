# 跨来源排序已输入的斜杠命令

Status: implemented
Translation: current
PR: [#1136](https://github.com/LodyAI/Lody/pull/1136)

[English](2026-09-29-slash-command-relevance.md)

## 摘要

输入 `/video` 时，`/create-intro-video` 排在 `/videoer` 前：Prompt Shortcuts
用包含关系筛选，再将非完全匹配的 slug 按字母排序。Agent 命令另行排序，整个分组位于
快捷方式之后。现在，输入查询后会把两个来源的可用候选按严格的匹配档位合并排序，
每行标明来源；只输入触发符仍保留分组。评估使用合成的相关度判断，不能代表真实
用户的搜索质量。

## 决策

[命令触发 Spec](../../../../specs/command-mention-triggers.zh.md)拥有可见行为契约。
共享排序器依次比较完全匹配、开头匹配、词首匹配、中间包含、非连续匹配和描述匹配。
使用元组保证档位严格：较长的开头匹配不会因长度惩罚落在较短的中间包含之后。
同档中标准 token 优于显示名称，再按位置、间隔、长度和字母顺序打破平局。
快捷方式仍先经过可用性筛选；保留下来的不可用完全匹配项排在可选项后。

每个来源先排序再截取前 50 项，避免按字母顺序提前丢掉相关命令。斜杠菜单合并两边
的有限候选后再取前 50 项。`@` 分类搜索和裸 `/` 保留原有呈现与来源激活流程。
混排的行标明来源，同时保留快捷方式的可见范围和不可用原因。

旧 Agent 命令评分只在本来源内生效，加法分数的档位也可能交叉。仓库内的 VS Code
评分器在查询 `video` 时，对 `video` 和 `videoer` 都给出 75 分，单独使用不能保证
完全匹配置顶。`match-sorter` 具有类似档位，但仍需针对连字符 token、描述、
可用性及跨来源呈现编写产品规则。使用小型共享比较器可直接表达这些决定，无需新依赖。

## 验证与限制

[合成排序评估](../../../../packages/components/benchmarks/slash-search/eval.mjs)包含十个
明确的意图样本。旧分组与字母排序有 2/10 个样本把目标排在第一，新排序为 10/10；
平均 NDCG@5 分别为 0.683 和 1.000。在 Node 22.23.2 下，对 1000 条合成候选运行
100 次，重复测量中纯筛选与排序的中位耗时为 0.45 毫秒，p95 为 0.95 毫秒。
这只是本地观测，不代表 UI 延迟或线上流量。

[注册表测试](../../../../packages/components/tests/mention-registry.test.ts)覆盖两个触发符、
跨来源顺序、裸触发符分组，以及真实 Prompt Shortcut 的可见性与可用性限制。
[菜单测试](../../../../packages/components/tests/mention-two-level-menu.test.tsx)覆盖渲染后的
来源标识、顺序和选择行为。在初始化必需 ACP 子模块、使用 Node 22 的独立克隆中，
这两组测试 66/66 通过，components 全套测试 4542/4542 通过，包类型检查也通过。
根目录 `pnpm check` 的类型检查与 lint 阶段已通过，但测试阶段因未修改的 CLI
`workspace-git-service.test.ts` GitHub remote 元数据断言失败；单独运行该测试也能复现。
