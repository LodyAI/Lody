# 中央信箱投递与安装报告

Status: proposed
Translation: current

[English](./2026-10-09-e2ee-central-key-delivery.md)

## 摘要

离线设备需要保留密钥密文，不能要求换代时同时在线。公共补充实现现已提供显式、
有限一轮的分发协调、设备签名安装报告、接收日志与持久结果消费，并有内存/Node
存储和真实 Lab HTTP 宿主。复用原有精确信封及账本验权，服务器保存与设备报告安装
仍是不同状态。实际 Convex 部署、产品调度和新鲜度策略仍为未验收提案；安装报告
不能证明设备持续持钥。

## 决策与替代方案

[双语草案](../../../../specs/e2ee-central-key-delivery.zh.md)拥有意图，
[README](../../../../packages/e2ee-core/README.md)映射公共 API。中央信箱支持离线/R
保留和可查询进度，不要求点对点可达。保留已有 Streams 适配器；若信箱必须经过
密钥流，会把存储迁移与无关的权限/内容运输耦合。

`Observed` 仍是精确密文读回。另加签名报告，避免悄悄改变原调用方的成功含义。
DeliveryId 仍是发送者关联标识，不是授权、唯一密文身份，也不进入信封 wire。
服务端按 genesis/epoch/recipient 汇总多个精确摘要/发送者记录。

协调器从自己的已验证账本枚举设备，核对持久当前钥，显式恢复既有
sendCurrentEpochKey/resumeEpochDelivery 引擎。启动可发现发布后、调度前崩溃的缺口，
同代新增设备也会安排；其他合格持钥设备可补齐，R 从不转发。不加定时器、后台
运行时，也不自动 rebase 已签名账本 pending。

## 崩溃一致性与修复

客户端任务状态与未消费终态结果同一次原子保存。只有应用明确确认才删除结果；
晚到的并发完成不能重新生成已消费结果。业务失败持久终止，网络不确定仍待处理，
存储失败须重新读取，缺陷正常传播。协调器的文档锁不覆盖网络分发。

接收顺序为：保存 `verify` 上下文/精确密文，打开验签并核对承诺，保存 `install`
检查点，keyring.put，排队精确签名报告，提交报告，保存 `done` 与结果。已有本地钥
不能替代验证新密文。重启只有在 `install` 检查点之后才可使用匹配 keyring 项，
否则重开已存信封。keyring 与接收日志是独立存储，通过上述顺序弥合崩溃窗口，
不声称跨存储原子提交。

报告绑定协议用途、genesis、代次、接收者、承诺、来源和修复轮次。信封来源绑定
发送者/精确摘要；本地发布来源要求精确已验证发布记录与签名设备，创世同理。
只有快照而没有发布记录的日志不能伪造本地来源。修复保留历史报告但清除当前报告
轮次，旧报告不能结束新修复。丢钥修复保留可用密文；坏信封修复排除摘要，由其他
补发者修复。原发送者不替换不可变 outbox 帧；原帧不可用时持久记录
`repair-needs-another-sender` 失败。

内存/Node 参考存储保存最多 16 MiB 的整体文档。Node 显式 create/open，使用 SQLite
EXCLUSIVE 锁；缺失、外国格式、损坏存储失败关闭。信箱密文与派生索引同一次提交。
查询每页最多 100 项；参考位置游标不代表稳定快照。投影恢复刷新已验证资格，拒绝
回退，保留精确数据。

## 宿主与 Convex 边界

Lab 增加显式 `centralKeyRound()` 与 Org 绑定凭证的 HTTP 信箱。SQLite 信箱独立于
Riverrun control/content。宿主准入检查当前账本，并在异步验签后再刷新；不与外部
账本原子截止。

Spec 描述 Convex ledgerProjections/keyRecipients/keyEnvelopes/keyReports/keyRepairs
表、有界索引查询，以及密文/索引同一次 mutation。公共 core 不引入 Convex SDK
或私有路由。可信账本同步器必须声明检查点、新鲜度/访问时限、投影落后处理与撤权
行为；旧投影不能直接授权写入。

首选默认 mutation 运行时中的固定严格 noble 验签器。Convex 文档列出 Web Crypto
不证明本协议或打包已兼容；真实默认运行时的签名/证明/拒绝向量仍是部署门槛。
若必须使用 Node action，最终内部 mutation 须绑定精确字节、重查当前投影；action
验签结果不是持久授权证明。Convex 与外部 Loro Streams 权限链从不描述为同一事务，
内容和账本运输可保留。

## 证据与验证边界

- core 中央信箱套件 **17 项通过**：真实 Ed25519/HPKE、明确故障边界，覆盖重复/
  丢失/延迟/旧代报告、同代设备、补发者、离线 R、丢钥、错误秘密、撤权/换代、
  已安装未报告与无 handler 结果。
- 三个子进程 SIGKILL 检查点：密钥已持久安装、精确报告已入队、终态/结果已提交。
  新进程重开 Node 存储恢复/消费。属于进程死亡测试，不是硬件断电测试。
- core 中央信箱/信封/投递相关套件 **35 项通过**。
- 真实 Lab HTTP/SQLite/Riverrun 中央套件 **2 项通过**，覆盖宿主/客户端重启、
  离线领取、报告状态、严格 Org 凭证与修复冒充。中央/历史/宿主相关套件 **11 项通过**。
- core/Lab 类型、完整 Effect 边界与变更文件格式/lint 分别检查。全量套件**未全绿**：
  允许本机端口的 core 有 10 个失败（558 通过、1 跳过），Lab 有 2 个（185 通过）。
  全部失败已在 /tmp 未修改 HEAD 副本独立复现：既有 review2 权限/快照/同步/outbox/
  换代探针与两项 HTTP snapshot 测试。首次 core 沙箱运行另因禁止监听导致 TCP 失败。
- docs check 报告 checkout 中无关 ACP 子模块断链；没有已注册 SHA 保护主题，
  没有刷新哈希或虚构人工批准。
- 未建立生产部署、Convex 运行时/接线验收、产品受保护密钥存储、正式安全证明或
  全局跨流新鲜度。

原有 [Effect 迁移](./2026-09-22-e2ee-effect-api.zh.md)和
[宿主网关](../../implemented/architecture/2026-09-18-e2ee-host-gateway.zh.md)决策仍适用。
本记录对托管接线保持 proposed；上述公共 core/Lab 实现证据取代原来的仅文档评估。
