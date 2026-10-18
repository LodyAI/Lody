# 限制 Roost 输入接收查询范围

Status: proposed
Type: bug-fix
Translation: current

[English](2026-10-19-roost-input-acceptance-paging.md)

## 摘要

Roost 合并输入接收在返回回执前，通过整个历史目录查找最新用户，导致展开旧页正文。
共享选择器现改用反向分页，在找到最新可读目标后结束。真实 SQLite 冷打开回归和本地
对照验证了对无关旧历史的依赖已移除。这项 owner 修复需更新 CLI；空历史耗时不变，
原始远程延迟尚未归因到这个扫描。

## 缺陷与修改

`accept_input_and_dispatch` 在不可变原生提交之后、activation 与回执之前调用共享
`readLatestTurn`。backend wrapper 已有分页查询，但该 helper 使用
`readDirectory(0, count)`；Node Roost 会转到 `readRangeEntries`，加载并投影尾部
缓存外的正文。因此，无关旧页失败也可能让已提交输入的请求失败。

共享 helper 从最新 40 行目录开始，仅在未找到可读匹配时继续向前；非分页 reader
保留标量目录路径，分页失败继续传播。wrapper 委托同一选择器。回执身份、writer
串行化、终态/已移除输入保护和 activation 顺序均保留，不增加确认捷径、重放、
生命周期 owner 或 Effect 迁移。它与[浏览器响应恢复](2026-10-18-roost-remote-receipt-latency.zh.md)
分别处理不同路径；wire contract 不变，但远端 CLI 更新后此修复才生效。

## 本地对照

已保存的[benchmark](../../../../apps/cli/benchmarks/roost-first-input.mts) 使用生产
SessionDocument/backend 和真实原生 SQLite。环境为 Apple M4、macOS arm64、
Node 24.14.0，源码基线 `17c76466b`。按 A–B–B–A 顺序，每阶段每个后端/规模
预热一次、测五次，即每版本十样本。每轮恢复相同的已关闭 SQLite/Loro 快照，重新
打开会话和原生 Worker，再发相同的首条与后续输入。旧消息交替使用已 handled 用户
和已结束助手，正文 4 KiB。OS 缓存是热的，元数据准备和复制不计时；记录源码 hash，
实验后源文件逐字节恢复。

初始化后的首条接收/activation 耗时中位数：

| 旧消息数 | 修复前 | 修复后 | 旧页读取：前 → 后 |
| ---: | ---: | ---: | ---: |
| 0 | 10.7 ms | 11.4 ms | 0 → 0 |
| 100 | 162.8 ms | 82.0 ms | 2 → 0 |
| 1,000 | 969.9 ms | 88.8 ms | 25 → 0 |

1,000 条时，冷打开加接收由 1,059.3 降至 159.0 ms，后续接收由 1,016.5 降至
90.2 ms。追加/封口的投影仍读有界尾页，该场景为 80 个物理页行。空历史基本持平。
Loro 追加/activation 参考各组约 0.5–0.8 ms，冷快照导入另计；内存 Repo 没有
SQLite 不可变回执的持久化保证。这里不测网络、远程元数据、渲染、IndexedDB 或 ACP，
不能解释原始远程 26.8 秒，也不构成普遍耗时上界。

从 `apps/cli` 指定专用临时 `BENCH_DIR`，先用 `BENCH_PHASE=prepare` 准备，
再取消该 phase、使用相同目录测量：

```sh
TSX_TSCONFIG_PATH=tsconfig.json node --experimental-wasm-modules --import ./node_modules/tsx/dist/loader.mjs benchmarks/roost-first-input.mts
```

版本之间保持 fixture 相同并保留源码 hash。`BENCH_VARIANT` 只标记结果，不选择模拟
实现。benchmark 验证结果状态，不设耗时阈值；从 `apps/cli` 运行专用检查
`pnpm exec tsgo --noEmit -p benchmarks/tsconfig.first-input.json` 和格式检查均通过，
范围 lint 没有错误。

## 验证与限制

真实 SQLite 回归导入 81 条合成旧消息，关闭/重开 owner，并拒绝读取旧页：基线
首条接收失败，修复后旧页仍不可用时已能返回不可变回执、持久化输入并发布 activation。
共享测试覆盖最新正文、最新正文缺失时跨页查询、分页穷尽、非分页 reader 和读取失败。
已有重试仍保护较新的 activation、终态输入和已移除历史。76 项原生契约通过，共享包
1,577 项、CLI 4,397 项通过，后者跳过四项。全库验证见 PR；文档仍有六条既有 ACP
坏链接，无受保护主题变更。此 owner 修复尚未部署或在原远程会话复测。
