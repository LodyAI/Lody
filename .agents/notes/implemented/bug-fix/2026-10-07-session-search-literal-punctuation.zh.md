# 保留会话搜索中的字面标点

Status: implemented
Translation: current

[English](2026-10-07-session-search-literal-punctuation.md)

## 摘要

会话搜索删除了助手正文及代码中的字面下划线，使回复中可见的标识符无法命中，
而不存在的无下划线标识符却产生没有高亮的匹配数量。搜索现在使用与渲染器同系的
CommonMark/GFM 解析器提取文本，保留代码和字面标点，仅移除解析出的格式分隔符。
非空搜索期间，流式回复渲染完整的当前正文，使索引与高亮同步更新；清空查询后
恢复文字揭示动画。合成 DOM 与 Chromium 回归覆盖了这些行为。用户报告的线上
构建与该源码的映射，以及原生打包应用的渲染仍未验证。

## 根因与决策

源码基线为 `72b118b584133edb66d2b4bbec1173c1a7d4a2a0`。
`getSearchableMarkdownText` 无条件删除整个助手字符串中的星号、下划线和波浪线，
包括已提取的代码。用户文本不经过此转换，而 `MarkdownRenderer` 独立匹配 DOM
文本，因此产生分歧。合成用户正文 `QA_RESUMED_OK` 与助手正文 `QA_RESUMED_OK —`
复现了报告中的三种计数，刷新后也一致。About `0.103.0 / 092d1413` 是报告者提供的
证据，不能据此确认部署映射。

将锁文件中已有的 `unified`、`remark-parse` 版本声明为直接依赖，配合现有
`remark-gfm` 提取语法树中的正文及代码值。行内强调保持文本连续，块容器之间用
换行分隔。同时正确处理转义标点、实体、不同长度的行内代码分隔符、波浪线围栏
与未闭合围栏。分隔符正则无法可靠区分词内下划线、强调与代码；修改用户查询会
保留伪命中并改变字面搜索语义。

真实流式渲染测试还暴露了时序问题：延迟揭示的正文可能错过父组件效果安装的
高亮。非空搜索改用静态 Markdown 渲染当前全文；清空查询后，流式渲染器通过
现有 `animateOnMount={false}` 恢复。这会在搜索期间暂停淡入动画，避免在动画
揭示时增加观察器或反复修改 DOM。高亮仍保留 React 持有的文本节点，遵循
[已有 DOM 所有权决策](2026-09-27-search-marks-keep-react-text.md)。

正文索引边界没有改变：工具标题及载荷、终端日志、差异和结构化状态仍不进入索引。
提纲仍在解析前截取 960 字符窗口，并按消息或索引行对象缓存摘要；搜索仍保留
逐轮缓存、帧级合并和仅在搜索开启时持有的全文水合租约。这是现有搜索行为的修复，
没有新增产品意图。数学、图表、图片状态及其他渲染器组件的文本仍是近似表示，
本次不承诺任意 DOM 与索引完全等价。

## 验证与验收

现有搜索测试覆盖用户与助手匹配顺序和数量、普通标识符、行内代码、反引号与
波浪线围栏、未闭合代码、强调、删除线、转义与实体，以及真实 DOM 高亮（含跨
强调节点的匹配）、活动结果切换、查询切换、清空/关闭、流式更新与渲染交接。
提纲及 ConversationView 测试检查摘要刷新、有界预览、未变消息块身份保持及
搜索关闭后重新开启。原有工具排除与文件链接激活覆盖也在相关运行中。

浏览器测试使用三个合成 Storybook 场景中的真实搜索栏和消息行。全新 Chromium
上下文阻断非本机网络请求，验证计数、高亮、导航、清空、关闭、刷新及页面无异常。
[Markdown/代码截图](2026-10-07-session-search-evidence/after-markdown-cases.png) 显示了全部八处匹配。
没有读取或保存真实用户会话。原生 Electron、线上应用、移动端和其他浏览器完整
测试集未运行。

| 查询 | 修复前 | 修复后 | 截图 |
| --- | --- | --- | --- |
| `QA_RESUMED_OK` | 1 / 1，仅用户命中 | 1 / 2；下一项选中助手 2 / 2 | [之前](2026-10-07-session-search-evidence/before-literal.png)、[之后](2026-10-07-session-search-evidence/after-literal.png)、[助手活动项](2026-10-07-session-search-evidence/after-assistant-active.png) |
| `QA_RESUMED_OK —` | 0 / 0 | 1 / 1，助手正文高亮 | [之前](2026-10-07-session-search-evidence/before-assistant-only.png)、[之后](2026-10-07-session-search-evidence/after-assistant-only.png) |
| `QARESUMEDOK` | 1 / 1，无高亮 | 0 / 0，无高亮 | [之前](2026-10-07-session-search-evidence/before-phantom.png)、[之后](2026-10-07-session-search-evidence/after-phantom.png) |
| 空查询 | — | 0 / 0，无高亮，原文保留 | [清空后](2026-10-07-session-search-evidence/after-clear.png) |

本地复现命令：

```sh
NODE_ENV=development pnpm --filter @lody/components exec storybook dev -p 6107 --no-open --ci
LODY_STORYBOOK_URL=http://127.0.0.1:6107 pnpm --filter @lody/components exec playwright test tests/e2e/session-chat-search.spec.ts
NODE_ENV=test pnpm --filter @lody/components test tests/session-chat-search.test.ts tests/conversation-outline.test.ts tests/conversation-view-hooks.test.tsx tests/markdown-agent-file-link-menu.test.tsx tests/markdown-streaming-reparse.test.ts
```

打开 `/iframe.html?id=sessions-sessionchatsearch--literal-underscores&viewMode=story`。
截图通过 `agent-browser --session lody-search-ca screenshot <path>` 在 1280 × 633
视口捕获，分别对应修改提取实现前与修复后；没有编辑图片内容。

隔离工作树使用 Node `26.10.0`、pnpm `10.20.0`。固定版本的子模块均已初始化，
没有修改 gitlink；Kimi/Pi 仍在根工作区之外，仅为解析文档链接读取其文件。
仓库没有已注册的受 SHA 保护主题，没有改变任何审核记录。

| 命令或范围 | 实际结果 |
| --- | --- |
| 将最终搜索测试文件复制到分离 HEAD 的 `72b118b58` 源码工作树；`NODE_ENV=test pnpm --dir /tmp/lody-search-baseline-caad69d5 --filter @lody/components test tests/session-chat-search.test.ts` | 20 失败、6 通过；复用同一锁定依赖安装 |
| 上述五文件相关测试命令 | 119 通过 |
| 上述浏览器命令 | 3 通过，无页面异常 |
| 最终实现上的 `pnpm check` | 退出 1：类型、lint、脚本检查通过；components 4833 通过、1 失败（`boot-shell` 存储不可用场景）。其后串联的边界检查及 Electron 测试未在此命令内运行 |
| `NODE_ENV=test pnpm --filter @lody/components test tests/boot-shell.test.tsx`，以及加上 `--dir /tmp/lody-search-baseline-caad69d5` 的同一命令 | 两者均为 18 通过、1 失败；同样是 light 主题/280px 与 null 期望不符 |
| `pnpm --filter @lody/components typecheck`、`pnpm lint` | 通过；lint 为 0 错误，保留已有警告 |
| `pnpm --filter @lody/electron test` | 199 通过 |
| `pnpm lint:i18n`、`pnpm check:code-collab-imports`、`pnpm check:platform-boundaries`、`pnpm check:public-boundary`（聚合失败后单独运行） | 全部通过 |
| `pnpm format`、对改动测试/清单显式运行 `pnpm exec oxfmt` | 通过，未保留无关改动 |
| 开始时 `pnpm run docs status` | 未初始化子模块导致 64 条断链 |
| 初始化后 `pnpm run docs check --base 72b118b584133edb66d2b4bbec1173c1a7d4a2a0` | 通过：0 错误、64 条已有警告 |

根构建和打包命令未运行。聚合检查并非全绿；独立复现的基线失败不属于本次修复。
