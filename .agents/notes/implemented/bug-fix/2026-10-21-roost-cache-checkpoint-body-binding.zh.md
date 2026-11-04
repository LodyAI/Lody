# 将 Roost 缓存正文绑定到对应 checkpoint

Status: implemented
Type: bug-fix
PR: https://github.com/LodyAI/Lody/pull/1765
Translation: current
Date: 2026-10-21

[English](2026-10-21-roost-cache-checkpoint-body-binding.md)

## 摘要

旧的完整正文刷新路径会推进缓存文本，却保留较早的 checkpoint。机器能力稍后到达时，内容补丁会再次应用已经写入的追加操作，持久化重复文本。现在只有与全部保留正文一致的 checkpoint 才能留下；增量读取遇到失去绑定的缓存时，先重建一致快照再恢复补丁。新的只读缓存命名空间隔离已经存在的错误缓存，以及仍按旧规则写缓存的页面。Roost 权威历史和数据库格式不受影响；升级后需要首次从所属机器读取以填充新缓存。

## 决策

- 缓存 checkpoint 必须对应整个保留窗口的正文。旧式 changed-turn 写入在同一事务中清除 checkpoint；不带 checkpoint 的分页写入也清除它。受保护的部分分页不能为未绑定的前缀背书，也不能与不同 checkpoint 的正文混用。完整的连续变更可以在已有绑定的基础上推进到新 checkpoint。
- 增量读取发现未绑定的 head 时，使用现有的受保护分页快照替换流程，在另一存储槽暂存完整页面，形成一致快照后发布。继续使用现有的有界读取、释放、错误处理与被新版本取代时的退避流程。失败时保留上一份持久化 head 并重试，不在无法确认的基准上启用补丁。
- 保留正文与 head 的原子事务及 checkpoint 比较并交换检查。清除 checkpoint 后，即使 revision 未变，较早发出的补丁也不能提交。
- 使用 `lody:roost-history-v2`，不解析或修复 v1 head。旧客户端在同 revision 的页面合并等路径中也会展开并保留未知 head 属性，仅检查标记存在不能证明来源。独立命名空间避免依赖任何旧写入规则。v1 保持原样；新旧页面可以读取同一份权威历史，但不再共享补丁基准。这是按需重建只读前端投影，不是 Roost 数据迁移，也不会删除本地已接收输入。

代价是升级后的首次缓存读取，以及从旧式刷新切换到增量读取时的一次一致快照重建。稳定运行后的补丁 watch 保留原有传输收益。在所属机器首次填充 v2 之前，升级后的首次离线打开无法复用旧缓存。v1 的存储空间留到常规缓存清理时释放。

## 验证与限制

使用真实 Native SQLite 所属机器和真实 IndexedDB bridge，复现 revision 1 / C1 / `base`、旧式刷新到 revision 2 / `baseA`、机器能力稍后到达的过程。修复后缓存与完整 owner 读取一致，都是 `baseA`。临时去掉 checkpoint 失效处理，同一回归测试会以 `baseAA` 失败。

所属前端测试覆盖旧式 changed-turn 与分页写入、不同 checkpoint 的部分分页、原子完整恢复、拒绝过期的在途变更、已持久化 v1 head 以及旧页面并行写入。46 项前端 bridge/cache 测试和 81 项 Native 后端契约测试全部通过，其中包括现有补丁体积预算和加密 RPC 测试。这些确定性的合成数据测试验证所覆盖的状态转换，不构成对任意存储损坏的穷尽证明。

本修复纠正了[内容补丁决策](2026-10-20-roost-history-rpc-patches.zh.md)中的缓存基准假设，不改变协议或 Native 补丁资格规则。

后续的[有界恢复决策](2026-10-21-roost-cache-recovery-network-cost.zh.md)保留这项绑定保护，
并替换昂贵的全缓存重建。它单独保留用于完整正文校准的游标，在覆盖不可用时只恢复最新窗口。
