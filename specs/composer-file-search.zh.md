# Composer 文件搜索响应性

Status: draft
Translation: current

[English](composer-file-search.md)

用户在大型项目中输入 `@` 文件关键词时，计算建议期间 composer 必须仍可编辑。
大文件索引不能让渲染线程同步构建并排序全部搜索候选。

## 搜索与生命周期

文件菜单把索引构建和排序交给独立 Worker。渲染线程只接收有界结果，并显示加载或
失败状态。Worker 失败不能回退为同步全量搜索；重新打开菜单会重试。单独的 `@`
和其他类别的限定搜索不启动文件搜索。关闭菜单、离开文件搜索、更换源条目或卸载
组件都会释放 Worker 及其索引。

只能显示和选择当前源条目、当前查询的结果。新输入替换待执行查询，并可在候选批次
之间中断正在运行的搜索。旧响应不得覆盖新输入或其他项目的候选。

## 兼容性与限制

保留现有模糊匹配分数、路径顺序、目录导航、插入文本、懒加载目录和结果数量限制。
文件发现、忽略规则、文件访问权限和草稿恢复不变。这不保证结果即时出现：宽泛查询
仍需检查大量路径，传输索引也有成本。性能测量必须区分查询完成延迟和渲染线程阻塞，
并注明输入数据及运行环境。

## 证据

- [实现导航](../packages/components/src/components/mentions/README.md)
- [行为测试](../packages/components/tests/mention-file-search.test.ts)
- [Benchmark 与实测限制](../.agents/notes/implemented/bug-fix/2026-09-20-composer-file-search-worker.zh.md)
