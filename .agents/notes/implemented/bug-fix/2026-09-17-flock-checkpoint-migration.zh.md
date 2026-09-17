# 接入属于具体副本的 Flock 进度

Status: implemented
Translation: current

[English](2026-09-17-flock-checkpoint-migration.md)

## 摘要

Flock 时钟摘要可能掩盖缺少的 key，接受的数据未落盘就推进进度，会让缺失延续到
重启后。升级 loro-repo 0.20.3 接入精确记录持久化与 IndexedDB 副本 checkpoint，
Renderer 恢复操作也改为删除实际使用的 checkpoint。CLI 等待每个资源真实写入，
由于上游 SQLite 缺少原子副本恢复，暂用内存进度。CLI 冷启动会多下载数据，
这次改动不能证明历史远端数据完整。

## 决策与证据

旧 ready() 补丁已包含在上游。撤回 inclusiveVersion 替换，因为相关字段是下次
导出的过滤基线，不是完整性检查。真实 Wasm 服务端回归证明：一个 peer 被覆盖的
高时钟，不能阻止后来补回的低时钟 key 发送到另一端。

Renderer 使用 createRepoStreamsPersistence，旧 cursor store 仅供 LoroDoc。
新 Flock checkpoint 从空开始，保留本地数据并触发 bootstrap。恢复绕过和删除
都指向当前 repo 副本的 checkpoint。

CLI 原来的 onPersist 回调只安排防抖全局保存便返回。现在改为等待
persistMetaNow/persistDocNow/persistFlockDocNow；删除无调用者的 coalescer 及测试。
没有复制缺乏完整性证据的旧 cursor，也没有在本地重复上游 SQLite 恢复内部实现，
而是明确暂用绑定当前 Flock 对象的内存进度。未来上游 SQLite 能力通过原子读取及
失效测试后可以替换这个方案。

测试使用真实 Flock、SQLite 和 fake-indexeddb，覆盖 v3 布局迁移、同向量修复后
重开、本地记录保留、并存副本进度隔离、失败重试和阻塞保存，并运行原有运行时
生命周期测试。未访问网络或生产数据；fake-indexeddb 不证明物理断电持久性。
Agent 未删除或迁移生产缓存。[契约](../../../../specs/flock-checkpoint-recovery.zh.md)。

补充测试通过已发布的 StreamsTransportAdapter，对 Meta 和 named Flock 使用
合成 HTTP 响应：snapshot bootstrap 补回同版本向量的缺失 key，保留仅本地存在的
记录；重开后恢复全部记录，使用保存的 offset 而不再 bootstrap。两个 renderer
测试套件共 23 条通过，components 类型检查通过。源码确认 snapshot 导入是合并
到现有 Flock，保存进度会等待数据落盘。这验证的是 IndexedDB 恢复，不代表
SQLite 已有持久 checkpoint，也不能恢复远端 snapshot 和保留的后续更新中都
已经缺失的记录。

## 复审：本地同步仍不能传播所有修复

持久化测试改为不 destroy/flush 写入者就重开存储，并对 Meta 和 named Flock
通过真实 transport 注入数据保存失败、checkpoint 保存失败。9 条持久化测试通过：
数据保存失败不推进恢复进度，checkpoint 保存失败保留已存数据，重试仍能将内存里
已经存在的修复 key 保存下来。

真实 Wasm 服务端复现确认一个未解决的迁移缺口：服务端和本地读者先有 peer aa
时钟 2 的 B，bootstrap 随后给服务端补回 aa 时钟 1 的 A。版本仍为 aa:2，本地
服务端按 lastSentVersion aa:2 导出，未发送修复，读者依然缺 A。此前回归仅覆盖
peer frontier 已消失的场景，不能证明这个场景。这是既有本地协议限制，不是新
持久化 helper 引入的回归，但本地优先读者在自身云同步补齐之前，不能被视为已
完成端到端修复。

本地服务端套件用明确的 `it.fails` 记录回归；套件绿色代表成功复现已知失败，
不是已修复。应在精确变化 key 转发或完整性修复路径真正补齐接收端后移除标记。
换成 inclusiveVersion 不能解决。本轮仅改测试和证据，生产修复仍未实施。
