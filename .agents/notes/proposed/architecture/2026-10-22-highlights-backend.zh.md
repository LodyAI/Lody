# Highlights 后端兼容性

Status: proposed
Translation: current

[English](2026-10-22-highlights-backend.md)

## 摘要

语法渲染入口正在从 Shiki 迁往 Highlights 0.2.0，文件和差异渲染使用 Diffs 1.6.1。
独立 tokens API 可接入现有 Markdown Worker 和 React 渲染器；Zed 主题适配器将当前
VS Code 配色提供给 Diffs。迁移尚未完成：Highlights 缺少 Coq、Lean、Fish、Nginx
词法器，而且 Diffs 每个 JavaScript realm 只能使用一个后端。保留这些语言需要独立的
Shiki 路径，静默取消其高亮不属于等价迁移。

## 实现与兼容性

- Markdown 保留核心／扩展语言开关、有界缓存、共享 Worker、主线程回退、CSS 变量
  配色及 React 文本渲染。Highlights 词法器本地打包。缺少 WASM/SIMD 的运行环境
  通过 `canUseWASM()` 选择 Shiki JavaScript 引擎。两个引擎的 token 边界可能不同。
- Diffs 组件和渲染池初始化选择同一后端。自定义主题同时注册 TextMate 与 Zed 格式。
  Zed 语法类别映射到现有 VS Code token 配色；依赖上下文的 TextMate scope 无法
  精确对应为词法类别配色。
- Diffs 1.6 的 hunk 保存行索引，不再内嵌行数组。Worker 返回前将正文压缩到 hunk
  范围并重定位索引；已持有完整源码的调用方恢复索引及展开上下文。复杂度限制仍统计
  实际 hunk 文本。原有消除 lookbehind 的换行补丁迁移到新版本。
- 删除未使用的 `highlight.js` 和 `react-syntax-highlighter` 依赖。无 WASM 时的
  显式回退仍需 Shiki。Monaco 的编辑、语言服务与分词器尚未迁移。

## 待定兼容性决策

建议为不支持的语言保留独立 Shiki 回退，而非静默将已有 Coq／Lean／Fish／Nginx
代码降为纯文本。Markdown 独立适配器可以延迟加载回退；Diffs 在一个 realm 内无法
按文件切换共享后端，不支持的语言需要独立归属与行为测试。当前补丁尚未完成该路径。
现有 Coq／Lean 只读文件查看器必须继续保留显式语言标识。

本方案部分替代 [Markdown Worker 实现](../../implemented/architecture/2026-09-23-markdown-highlight-worker.md)
与[扩展语言包](../../implemented/feature/2026-10-01-extended-code-language-pack.md)的语法加载机制，
保留其 Worker 与偏好设置边界。

## 验证范围

components 和 code-review-helper 类型检查通过。相关组件测试 57 项、helper 测试
33 项通过。独立 HTML 构建与公共边界检查通过。Electron 44.7.0 已实际输出 Highlights token；Chromium 验证了 Worker／主线程
token 一致、自定义主题配色、源码转义和无 WASM 时的 Shiki 回退。完整检查已通过类型检查与 lint，但 CLI 的原生 SSH 递归子模块克隆测试出现失败，
根检查已失败退出，不能认定全套测试通过。文档检查有 6 条指向未初始化 Kimi／Pi 子模块的既有断链。
许可证清单重新生成会涉及大量无关基线，待迁移范围确定后再处理。本记录不代表迁移完成。

## 实测收益与代价

[可复跑基准](../../../../packages/components/benchmarks/highlights/README.md)与
[原始采样](../../../../packages/components/benchmarks/highlights/results-2026-10-22.json)
在 Apple M2 Max、Electron 44.7.0（Chromium 152）、Node 22.20.0 上，对比
`090f51b2` 的原 Markdown Shiki JavaScript 适配器与当前补丁。预热三次后采样十次，
两个后端交替计时；两者使用原有双主题 CSS 变量配色，并验证 token 可完整还原输入。

| 输入                                  | Shiki JS 中位数 | Highlights 中位数 |
| ------------------------------------- | --------------: | ----------------: |
| TypeScript，204,864 字符              |      1,661.4 ms |            2.6 ms |
| Python，204,930 字符                  |        476.9 ms |            2.6 ms |
| Rust，204,867 字符                    |        443.6 ms |            2.6 ms |
| 逐行 JSON，204,816 字符               |        149.9 ms |            2.3 ms |
| Lody DiffViewer TSX 源码，45,251 字符 |        435.1 ms |            0.6 ms |

21,120 字符的 TypeScript 分成 83 次追加，全量前缀重新分词的累计 CPU 耗时从
Shiki 的 7,221.4 ms 降到 Highlights 的 11.3 ms。尚未接入的 `StreamTokenizer`
为 0.7 ms，但只输出完整行，要保留半行即时显示仍需集成。这是强制处理每次更新的
CPU 工作量，不是实际响应延迟：应用调度可能跳过中间前缀。模块已缓存时的新建
高亮器耗时为 65.9 ms 与 0.3 ms；这不代表冷导入或桌面启动时间。

独立压缩适配器的完整依赖产物从 9,670,067 增至 9,943,127 字节；各 chunk 分别
压缩后 gzip 总和从 1,846,646 增至 1,963,185 字节（增加 116,539 字节，6.3%）。
其中包含全部懒加载语法／主题和保留的 Shiki 回退，不等于首次传输体积。
尚无证据证明应用安装包变小。

测试通过 Vite 在 Electron 渲染进程内执行同步分词，不含 React／DOM、Worker
传输、缓存命中、Diffs 渲染或应用启动。token 边界及配色有所不同。已证实的主要
收益是未命中缓存的 Markdown／流式分词计算明显减少；语言覆盖和主题保真仍须
独立验收。
