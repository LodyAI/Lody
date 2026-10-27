# PR20-C：接收新 epoch 时保持发送

Status: proposed
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1954

[English](2026-10-27-e2ee-epoch-receive-barrier.md)

## 摘要

Owner 的可用性优先 MVP 决定覆盖原强制停发屏障。rotationRequired 只提示管理员手动操作；合格设备在新钥接收重试期间继续使用已发布的旧 epoch 封装。房间保留稳定 provider，每次操作开始时选择已安装 epoch。新钥读回确认后同步更新选择；失败或超时保留旧发送和本地数据。没有自动签署或已保存格式回退。

## 权限与选择

原生工作区拥有已验证账本、安装密钥和接收日志。Staging locator 来自真实 publication 原件，KeyReceiver 复查签名、publication、recipient、HPKE 和 commitment，历史 mailbox／history 恢复保留。即使使用较早的已发布 epoch，每次 seal 仍在加密前和签名后检查当前成员与设备权限；撤销、移除、Guest 和 Recovery 写者仍被拒绝。签名期间出现真实后续账本不再使合法的旧 epoch 密文失败。Namespace、线格式、签名域、commitment 和原件不变。

每次操作只捕获一个 epoch。接收与真实读回确认之后，同步更新选择，无须 I/O、关闭 transport、重建 Repo 或清空队列。在途旧操作可完成合法的旧 epoch 密文。重启时原生 status 返回确认可用的 writeEpoch，因此新钥缺失不再丢弃可用的本地副本；身份丢失或没有任何可用密钥不能绕过。

移除旧方案新增的 SDK 强 close 补丁、drain／restart API 及其过时测试，无 SDK 升级或外层镜像补丁要求。选择前进时使活跃 token owner 失效，桌面后续 token owner 的缓存身份也包含 epoch。仅 rotationRequired 变化不使 token 失效。

## 失败隔离

- 触发：启动、已验证 epoch 前进、重连或明确重试。手动签署及设置红点／按钮留给 20-D。
- Owner：现有 renderer／CLI 工作区及原生 scope 中的单次接收／选择；没有全局网络锁或新重试 daemon。
- 取消：十秒等待期限不代表原生任务结束；最多保留一个未完成安装 owner。超时、过时和迟到读回不得更新选择。Close 使选择回调失效并等待原生／加密工作收束。
- 交接：先安装并确认，再同步更新选择；没有需要破坏后回滚的步骤，原 provider 和 transport 继续可用。
- 失败：接收错误、缺钥和超时可见且可重试，同时用已验证旧 epoch 发送；其他工作区独立。本地存储／账本验证失败仍保留既有安全检查。

此方案接受 owner 的 MVP 取舍：持有旧密钥的被撤销设备能解开它获取的密文，访问边界由服务端凭据／token 权限和绝对过期承担。不允许明文 fallback 或恢复撤销写权。

## 证据与边界

确定性回归覆盖同一 provider 持续发送、失败、超时／迟到结果、缺钥与过时代次、另一个工作区发送、旧钥冷启动，以及真实 SQLite／加密重启和 committed staging 接收。改变的行为均撤回修复先 RED，再 GREEN。本地边界验证不等于安装产品验收；真实网关撤销／长连接、系统钥匙串、双设备安装包、跨平台和完整十五分钟访问上限仍未验证。完整仓库测试交给 CI。

core 的 advisory 权限独立在 [#1956](https://github.com/LodyAI/Lody/pull/1956) 审查；文档旧 epoch 兼容属于本 PR，两者无分支堆栈依赖。此 owner 指令覆盖 [M2](2026-10-22-e2ee-m2-product-integration.md) 的停发解释。原生 Effect consumer 迁移仍由 [路线图](2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger) 单独负责。
