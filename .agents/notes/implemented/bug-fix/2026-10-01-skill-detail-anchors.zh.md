# 将技能片段导航保留在当前详情文档

Status: implemented
Translation: current

[English](2026-10-01-skill-detail-anchors.md)

## 摘要

技能详情的标题链接曾在新标签页打开宿主路由并丢失详情，因为渲染器把片段当作外链，
且没有生成标题 id。现在详情显式启用 GitHub 风格的标题 id，并在自身正文中处理片段
导航及焦点移动。其他 Markdown 调用者保留现有行为，技能源文件保持原样。降级渲染器
支持其能够渲染的标题；完整 Markdown 解析和原生移动端焦点行为仍属于独立验证边界。

## 决策

实现前核对的最新 main 为 `7d502f3d99fdcdbbdd43d032c6d903d4ed497e04`。
针对 skills、skill detail、anchor 和 B04 的已有 PR 搜索未发现有效修复；相关已合并
的弹窗宽度和设置设计 PR 未实现标题导航。
最后一次 main 核对已到 `93545f01b69cb0c98ddd3f19d46540decd95a007`；
三个相关渲染器及详情源文件没有变化，打开的 PR 中也没有本项修复。

[详情正文](../../../../packages/components/src/components/settings/skill-detail.tsx)
负责片段查询、URL 解码、滚动和聚焦。它只匹配自身正文中的标题，避免全局 id 查询，
也不将不可信片段插入 CSS 选择器。无效或不存在的目标被消费，不触发路由导航。
[渲染器](../../../../packages/components/src/components/ai-gui/markdown-renderer.tsx)
仅为详情显式启用标题生成和普通片段链接。将锁文件中已有的间接依赖 `github-slugger`
声明为直接依赖，保留 Unicode 和重复名称碰撞行为，避免引入另一套 slug 算法。
降级渲染器采用同一 slugger 和渲染后的内联文本。

浏览器原生片段导航不足以处理此场景：宿主路由拥有 URL，多个已挂载文档也可能包含
同名标题。全局启用锚点行为则会将本项扩大到会话导航。
[草案契约](../../../../specs/skill-detail-navigation.zh.md)记录用户可见行为。
本决策不涉及技能目录、扫描、调度或技能源文件编辑。

## 验证

所属回归测试执行真实详情渲染，并注入渲染失败；覆盖编码后的中文片段、重复和嵌套
标题、查询作用域、无效目标、外链行为以及关闭弹窗后的搜索词和焦点。
jsdom 不执行页面布局，因此注入滚动边界；Chromium 验证使用合成 `InternalAnchors`
Skills story。

将三个渲染器及详情源文件替换为已核对的 main 版本时，三个选中的锚点回归测试全部
失败；恢复修复后，九项测试全部通过。Chromium 确认了实际正文滚动、标题聚焦、URL
保持不变、外链打开新标签页，以及 Escape 关闭后保留搜索词和打开按钮焦点。
`pnpm check` 通过类型检查和 lint，随后停在未改动的 `boot-shell.test.tsx` 存储不可用
用例（组件测试 4,595 项通过、1 项失败）；该失败也在单独运行时复现。独立运行的
Electron 测试 199 项通过。格式化、i18n、导入/平台/公开边界检查和文档检查通过。

生产账号导航、原生移动端 sheet、Safari，以及超出现有
子集的降级 Markdown 语法不在本次验证范围内。
