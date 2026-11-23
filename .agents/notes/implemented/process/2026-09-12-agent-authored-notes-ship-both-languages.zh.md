# Agent 撰写的 Note 与 Spec 必须同时交付两种语言

Status: implemented
Translation: current

[English](2026-09-12-agent-authored-notes-ship-both-languages.md)

## 摘要

Agent Note 不再是双语的，原因是 agent 读到的每一条规则都允许如此：语言政策写明翻译不阻塞合并，收尾
流程只要求 agent「暴露翻译欠债」，而 `docs check` 接受没有对应文件的 `Translation: pending`。在 `main`
的 `implemented/` 与 `proposed/` 记录中，这让 70 个词干里有 48 个只有单语。现在规则按作者拆分——人类仍
可只贡献一种语言，但有能力写两种语言的 agent 必须让 `.md` 与 `.zh.md` 一起落地——并且所有未配对的记录
都已补齐，记录现在 100% 配对。工具改动是告警而非新闸门：`docs check` 仍然只在「标为 `current` 却缺少
对应文件」时失败，因此社区贡献仍可合并。

## 这次漂移为什么是合规的

`.agents/README.md#asynchronous-bilingual-documentation` 写明 Spec 与 Note *最终*会拥有相邻的 `.md` 与
`.zh.md`，任一语言都可以先写，且翻译不阻塞合并。`scripts/docs/main.mjs` 中的 `documentStatus` 正是这样
执行的：只有在 `Translation:` 缺失或非法、或者文档声明 `current` 而对应文件不存在时才报错。标为
`pending` 且没有对应文件的记录在设计上就是合法的。随后，收尾流程第 5 步要求作者「用状态输出暴露翻译
欠债」，那是一条汇报指令而非撰写指令；CONTRIBUTING.md 则另行告诉人类：维护者会在合并之后安排另一种
语言。

近期由 agent 撰写的记录正确地遵循了这些规则，交付单语并标为 `Translation: pending`。本次改动之前
`main` 上的统计是：`implemented/` 与 `proposed/` 下的 70 个记录词干中，22 个成对、39 个仅英文、9 个仅
中文。没有任何东西坏掉；只是政策从未要求 agent 提供第二个文件，而「一次就能写出两种语言的 agent」正是
这套异步政策当初没有考虑的情形。

## 决策

规则按作者而非按文档拆分：

- `.agents/notes/AGENTS.md#history-and-language` 现在要求 Agent 在同一次改动中让两个文件一起落地：相互
  链接、`Status:` 相同、Abstract/摘要 含义一致，且两侧都标记 `Translation: current`。`pending` 保留给
  无法写另一种语言的人类。
- `.agents/README.md` 的收尾流程把这项义务单列为一步，而双语政策一节点名 agent 是例外，以免该节被孤立
  地读成许可。
- CONTRIBUTING.md 原样保留人类豁免，并新增一句把 agent 指向记录规则。把该要求扩大到人类被否决：社区
  贡献者不必懂两种语言，而这正是异步政策存在的理由。
- `AGENTS.md` 文件保持仅英文。它们在每次改动时都会被读取，多一份副本就多一处让约束规则过时的地方。

`documentStatus` 新增一条告警——而非错误——用于 `.agents/notes/` 下缺少对应文件的情形。把它做成错误被
否决，因为那会让一次合法的人类贡献失败。该告警限定在记录而非所有文档，是为了让它从零开始：本次补齐
之后每条记录都已成对，因此任何告警都是新增欠债而非背景噪声。Spec 仍有 20 个词干未配对，会把该信号淹没；
它们不在本次补齐范围内，仅保留 `docs status` 本就报告的逐文档 `missingTranslation` 字段。

## 补齐

`implemented/` 与 `proposed/` 下全部 48 个未配对词干均已成对：39 条仅英文的记录获得带 `## 摘要` 的
`.zh.md`，9 条仅中文的记录获得带 `## Abstract` 的 `.md`。每一对现在都相互链接、`Status:` 相同，并在两侧
标记 `Translation: current`。有四处从英文记录指向 `.zh.md` 的跨记录链接被改指到如今已存在的对应文件；
指向仅中文 Spec 的链接保持不变，因为那些 Spec 没有英文文件。

这些翻译是对已记录决策的忠实转述，而非重写：没有增加、删除或弱化任何结论、判定、证据、限制或 PR 引用，
也没有改动任何记录的生命周期路径或 `Status:`。最大的一条记录——goal control 的审查与消融——带有 355 行的
机械消融矩阵；其叙述部分由人工翻译，矩阵行则通过固定短语表翻译，因为结果列只有三种模板、结论列约四十种，
用表格能让全部 427 行的呈现保持一致，而逐行散文做不到这一点。

## 验证与限制

- `pnpm run docs check` 通过：0 个错误、0 条记录缺少对应文件、无记录相关告警。在初始化 submodule 之前
  看到的 20 条断链错误，是既有的「ACP submodule 未初始化」基线，被新增对应文件中相同的链接翻倍；一旦
  checkout 了 `packages/acp-extension-*` 它们就会消失。
- `node --test scripts/docs/main.test.mjs` 通过 21 个测试，其中新增用例断言：缺少对应文件会告警、仅凭该
  告警 `check` 仍退出 0，以及对应文件出现后告警消失。
- 每一对都以程序化方式验证了对应文件存在、跨语言链接存在以及 `Translation: current`；`implemented/` 与
  `proposed/` 报告 0 个未配对词干。
- 翻译准确性无法机器校验，工具也明确不评估它。这些翻译由单个 agent 写成，未经第二语言的人类评审，这正是
  新规则的主要残留风险：它把一个可见的缺口（「没有对应文件」）换成了一个不可见的缺口（「对应文件质量
  未经评审」）。
- `implemented/testing/2026-09-07-ci-affected-tests` 虽已成对，两侧仍为 `Translation: pending`。它本就
  成对，因此不在本次补齐范围内；把它改成 `current` 等于对一份本次并未完成的翻译作出质量判断。
