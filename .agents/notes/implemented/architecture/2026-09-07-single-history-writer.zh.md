# 窗口化读取之前，统一历史写入

Status: implemented
Translation: current

[English](2026-09-07-single-history-writer.md)

## 摘要

PR #460 将 CLI 与 renderer 的历史写入统一到 HistoryWriter，不再用整会话校验阻断发送。
新建或改动的输入先解析，未修改的未知历史原样保留。目标 turn 的局部更新与固定版本
Mirror 文本事件补丁减少重复工作，不改变存储布局。全量读取、批量复制、重叠回滚冲突
和真实 3000 轮验收仍未解决。

## 职责与兼容

```text
CLI / renderer → Session facade → HistoryWriter → Loro operations
                                      ↓               ↓
                              changed-input parser   Mirror reader → subscribers
```

writer/materializer 来自 #376，但不依赖 ConversationView。后续窗口读取必须复用它，
读路径开关不能切换 writer。Session Mirror 跳过整状态校验，其他 store 保留校验。
命令先完成校验再写控制字段与历史；诊断只包含路径和错误码。打开旧会话不清洗历史。

封闭的新输入只保存 schema 声明字段；ACP 工具内容与位置的明确扩展边界保留 JSON。
未知嵌套类型不能掩盖已知类型的错误。SDK 入口筛选是另一层：直接 writer 的合成 fixture
不能证明所有 provider 形状都能经过当前 SDK。确定性非法 ACP 通知会被隔离，
临时失败继续使用现有的有界重试。

工具除身份外的字段、已存 inputConfig、同一 proposal 的 meta 只解析实际改动。
未变的损坏旧字段不阻断独立更新。steer 标记保留到读取归一化；旧 built-in CLI
选择器只在新写入时归一化。队列提升在历史和激活指针都写入成功后才移除同一队列行。
只写成历史时，重试只补指针，不重复追加；终态确认防止重放，另有待派发消息时保留
队列行，不覆盖它的指针。真实 SessionDocument / Loro 回归通过连续注入元数据写入
失败，检查这些最终状态。proposal 决策按 id 查最新状态，不覆盖较早渲染的整条记录。

notice 的 name/meta 关联包含 fork origin；operation completion 复用共享 schema。
编译契约检查非法命令、嵌套字段覆盖与 notice 关联，不用源码字符串断言替代它。

## 复制、回滚与导入

fork 使用 writer 从实际存储捕获、由私有 WeakMap 认证的快照；公开 getter 返回独立副本。
普通数组不能伪造历史来源，新增改动仍需解析。复制历史插入目标 setup 行之前，保留目标
容器，拒绝 id 冲突。forkOperation 清理直接清空永久根 Map，不尝试删除根容器。

回滚从不可变读取视图确定范围，只序列化被替换的真实存储范围。保留未动行、替换 user
的自动已读标记以及后来 peer 追加的行。已有行结构变化或重叠编辑仍会产生 stale_rollback，
调用方记录恢复失败；没有持久恢复副本或崩溃恢复保证。恢复的已删除行使用新容器。

导入保留原 source hashes 和 turn ids；doc cursor 的版本化原子 JSON 字符串将已存
role/items/plan hashes 与 source digest、长度绑定。它区分新写入投影与之后的本地修改；
接受“原始或清洗后任一 hash”会掩盖删除，因此没有采用。历史与 cursor 写入之间没有 await，
随后才发布；持久化仍由 repo 负责。已先到达的 source 后缀不会重复插入。
过期、损坏 baseline 回退到严格旧比较，不宽松通过；老 importer 对投影数据仍可能冲突。
发生变化的刷新会重写 baseline，增长成本仍待处理，尚未改成 hash chain。

## 性能与复现

schema 派生必须遍历 ZodPipe 两侧，保留 preprocess/transform 函数。旧配置转换包装曾
遮住内部 strict 对象，导致 inputBlocks/issuePRMentions 的未知字段被拒绝。真实 writer
的追加与重发/回滚测试验证：新字段被过滤、旧行不被重写、已知字段类型错误仍被拒绝；
parser 测试另验证转换和 refinement 保留。

输入 schema 缓存派生且保留 refinement，单次解析；discriminator 索引来自 schema。
标量/fileDiff 只读取目标字段。ACP 纯 text/thought 走 updateEntry；
tool/subagent/mixed 保留跨 turn 路由。旧 Text 修改保留 CID，primitive 不升级。
没有存储迁移、附件外置或 #359 的 hash-v2 改动。

Mirror 2.3.2（配合 Loro 1.15.1）已包含上游文本事件路径优化，只复制单个已存在文本叶子的祖先路径，
保留描述符、旧快照与通知。缺少基线、tree/accessor/结构/多事件继续原实现。
普通稠密数组祖先使用校验后的值复制，特殊数组保留描述符复制。本地 2.3.1 补丁已删除；
这个读取优化本身不依赖存储格式变更。

运行 `bun packages/shared/tests/history-writer.perf.ts`。新旧 reader 对照设置
HISTORY_BENCH_BASELINE_ENTRY 指向未打补丁的 Mirror 2.3.1，
HISTORY_BENCH_PAIRED_ONLY=1、HISTORY_BENCH_SAMPLES=1、
HISTORY_BENCH_SAMPLE_OFFSET=0|1|2，各样本使用独立进程。
每 entry 20 个合成 tool items，30 chunks，无额外预热，交替顺序，断言完整 JSON 与双副本。

76d0e9be 时记录的样本均值中位数，单位 ms/chunk：

| Runtime | Entries | Unpatched reader | Patched reader |
| --- | ---: | ---: | ---: |
| Bun 1.3.14 | 50 | 1.060 | 0.189 |
| Bun 1.3.14 | 200 | 3.839 | 0.156 |
| Bun 1.3.14 | 400 | 6.067 | 0.180 |
| Node 24.20.0 + tsx | 200 | 5.225 | 0.181 |

对照使用同一 writer，不是整应用。Node 同进程重复 seed 即使 free/GC 也变慢；
独立进程避免测量混淆，并非证明生产生命周期问题已修。批量 fork/capture 与多事件
tool 成本仍在，不能据此宣称整体 10x 或真实 3000 用户轮桌面/移动端验收完成。

## 证据、历史与边界

真实 Loro 与服务测试覆盖非法输入原子性、未知历史复制、权限补全、自动已读回滚、
新旧副本、最新 proposal 定位和 cursor 冲突；provider/network/disk 按测试实际情况 stub。
曾有同时离线插入前置 item 并重写 proposal 的探针重建其容器、丢失另一端决策；
没有宣称任意 item 结构并发已解决。通用 turn 换序仍不支持。

合入 main e12cb225 后的 123e9132 通过完整 pnpm check、格式化与文档检查；
fork/清理/编辑重发针对性测试通过 38 项。这是历史证据，不自动批准后续改动或已发布端兼容。

按用户要求，将本 PR 增量 Note 收束为本中英文记录。已被替代的阶段结论和详细记录
可从 123e9132 及以前的 Git 历史恢复。删除仅匹配源码文本的浅测试，保留真实行为
与编译失败契约；同一主题后续修订更新所属 Note，不为每次小修新增文件。

意图：[草案 Spec](../../../../specs/session-history-writes.zh.md)。
PR: [#460](https://github.com/LodyAI/Lody/pull/460)。
