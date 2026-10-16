# 公开 E2EE Lab

[English](README.md)

这是消费公开 `@lody/e2ee-core` 导出和已发布 SDK 的私有合成 Lab，使用真实
loopback HTTP、SQLite、HPKE、Loro/Flock 和 OS 进程。迁移尚未完成，
此包不启用生产 E2EE。E2EE 尚未上线，旧数据、账本和 API 兼容不在范围内。

## 运行

使用仓库支持的 Node 和固定 pnpm，在独立 checkout 初始化公开 submodule，
按冻结 lockfile 安装。依赖版本以 [package.json](package.json) 和根 lockfile 为准。

```sh
pnpm install --frozen-lockfile
pnpm --filter @lody/e2ee-lab typecheck
pnpm --filter @lody/e2ee-lab test
pnpm --filter @lody/e2ee-lab lab run /absolute/new-output-directory
pnpm --filter @lody/e2ee-lab lab run /absolute/another-new-directory actions.json
pnpm --filter @lody/e2ee-lab lab inspect /absolute/new-output-directory/evidence.json
pnpm --filter @lody/e2ee-lab lab replay /absolute/new-output-directory/evidence.json /absolute/new-replay-directory
pnpm --filter @lody/e2ee-lab lab minimize /absolute/failing-run/evidence.json /absolute/new-shrink-directory
```

`run` 要求输出目录尚不存在。默认计划执行 39 个动作；自定义计划可以是最多 256 个
动作的数组，也可以是 `{ actors, actions }`，显式配置 Owner/Admin/Member/Guest 与
绑定成员的设备。不支持的动作和访问器在执行前失败；缺少必需观察也明确失败。
SIGINT/TERM 先停止接收新工作，再等待真实子进程终止。

失败预期必须指定精确拒绝原因，例如：

```json
{ "ok": false, "refusal": { "tag": "LabContentError", "code": "decrypt_failed" } }
```

无关的有类型失败、defect 或无类型错误都属于测试设施失败。
每项 ok/outcome/text/持久状态不变检查保留自己的结论；某项通过不能覆盖
另一项已测违规或缺失测量。

| 退出码 | 含义               |
| ------ | ------------------ |
| 0      | 已测动作契约通过   |
| 1      | 测试设施失败       |
| 2      | 已测违规或覆盖缺口 |
| 64     | CLI 用法无效       |

`evidence.json` 保存实际载入源码/依赖的哈希、原始签名记录、受保护传输字节、
调度、观察及覆盖缺口。其引用的 `fixture/*-transport.jsonl` 仅含受保护协议流量，
不含凭据。独立的 `private-replay/` 保存合成设备私密导出、初始签名记录和逐动作原输入，
供 replay／缩减使用；目录权限 `0700`，文件权限 `0600`。这些文件必须保持私有，公开
`evidence.json` 用格式／摘要引用它，不能脱离原私有目录重放动作。`inspect` 根据记录的观察重新计算结论，
不信任已存 verdict；它不认证文件来源，也不重新执行场景。执行与检查共用一套
动作语义校验和观察汇总。耗时仅作诊断。
固定120秒的测试设施看门狗会中断停滞场景，kill 并等待所属子进程、释放资源后
返回 `LabScenarioError/watchdog`（CLI exit1）。只有 owner 清理成功后才写最终证据；
它不是耗时通过阈值，也不改变严格 freshness B。
测试套件使用 180 秒的外层看门狗（清理 hook 为 120 秒），替代各用例零散的 5/10/15/20 秒到达预算。
测试等待明确事件或操作实际结束；操作结束却缺少所需事件时，直接报测试设施失败。
外层预算给内部 120 秒场景看门狗留出清理余量。运行缓慢不能证明协议拒绝。发出 SIGKILL 或收到关闭确认后，进程 owner 仍等待真实
`close`，不会因为过去了五秒就提前释放资源。

## 入口与资源归属

| 入口                                                                     | 职责                                                                                                     |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `./workspace-session`、`./full-session`                                  | 已获准的现有 control/[P09](../e2ee-core/README.md#terms)、身份、密钥和逐文档资源；重新认证先关闭旧 owner |
| `./workspace-creation`、`./workspace-creation-request`、`./host-session` | 原 genesis 先落盘、创建重试及完整 HTTP／Riverrun／SQLite 宿主关闭重开                                    |
| `./repro`、`./repro-runner`、`./attacks`、`./attack-transport`           | 原密文读取、原输入 replay／缩减、真实响应拦截和有界攻击测量                                              |
| `./join-session`                                                         | 持久化原签名加入申请，丢回执后重试；真实获准后再普通启动                                                 |
| `./key-round`                                                            | 一轮有限修复/接收/报告/分发；明确保留阻塞任务和各页游标                                                  |
| `./content-session`、`src/platform/flock-session.ts`                     | Loro/Flock 适配，共用文档生命周期及原生状态/游标原子存储                                                 |
| `./host`、`./http-identity`                                              | 合成 challenge/bearer HTTP、签名 genesis 发现、加入、mailbox 及有界控制/内容传输                         |
| `./driver`、`./actions`、`./scenarios`                                   | 原生 Effect 放行、有限动作、真实进程崩溃及测量证据                                                       |
| `./snapshot-cache`、`./reference-model`、`./replay`                      | 重验账本快照字节、独立预期及静态材料比较                                                                 |

receiver 拥有唯一的受保护已安装密钥存储；distributor 和完整会话借用它的
`installedEpochKeys`，不重复打开存储 owner。原生阶段直接组合 Effect。
`LabCallbackRunner` 仅承接真实 Node/SDK Promise 回调；未接通的攻击钩子和
Promise-phase API 已删除。父事件身份使用 JSON tuple；replay 精确比较 parent 和 occurrence。

## 有限密钥工作与显式结果确认

`session.keyRound(limit, cursors)` 每阶段只执行一页。把各阶段返回的 `next`
传回各自游标名：`repairs`、`resumed`、`reportsBeforeSend`、`reconciliation`、
`delivered`、`reportsAfterSend`；最外层 `next` 属于 `received`。
结果页分别用 `repairResults`、`deliveryResults`。这些提示不是持久 offset，
也不能选择权限；第一页阻塞时仍可显式继续后页。

调用者显式 `enqueueRepair(stableId, rejectedDigest?)`：只有精确坏帧才提交其摘要，
本地存储/原生故障应重试，不自动换 repair ID。`receiveResults`、`repairResults`、
`deliveryResults` 返回保留结果。消费后再以准确 ID 调用对应的 `acknowledgeReceive`、
`acknowledgeRepair`、`acknowledgeDelivery`。轮次不会自动确认；配送确认释放活动任务
预算，但原始行继续保留。

进程 actor 通过 `keyCommand` 暴露相同流程，自定义 CLI 动作计划可直接使用：

```json
{
  "kind": "key-command",
  "actor": "peer",
  "command": { "operation": "repair", "requestId": "explicit-repair-1" },
  "expect": { "ok": true }
}
```

命令包括 `repair`、`keys`（可选 `limit`/`cursors`）、`key-results`、
`acknowledge-key-result`（显式 `resultKind`/`resultId`）。Worker 保留真实结果和
下一页提示；没有新增后台排空循环、自动确认或存储 owner。

## 权限、持久化与关闭

现有会话独立提供本地与网络 checkpoint；读取启动可用显式合资格的快照起点，
P09 写入仍要求已发布完整签名控制前缀（含原 genesis）。
发现元数据、SQL 行、offset 和 IPC 观察不能选择信任依据；
私有 IPC 返回的位置必须与独立见证的原签名记录核对。
账本读取或 SQLite 写入失败时，已验证历史和游标一起保留；P09 重试原签名字节，
只有持久 feed 已验证包含结果后才 ACK。

已存凭据绑定真实设备和 Org，JSON 不能选择发送者。Recovery 设备可以接收、
修复、授权自己的新个人设备，但不能发送 epoch 信封或写内容。
当前发送资格与合法历史内容认证分别检查。加入回执没有授权效力。
快照缓存每次按调用方固定的资格重验；具备资格本身不代表快照已获准或当前权限成立。

每个文档把原生状态与精确 SDK 游标原子提交。远端认证、解密、格式错误或本地存储损坏才停止该文档。
网络、超时、5xx、409 和权限拒绝保留 active 及原持久状态，可以直接重试。
SQLite 存储共用当前格式的连接 helper，打开时校验文件身份和绑定；本机恶意进程篡改审计不在威胁模型内。
重开仍验证签名历史，事务及目标行读回语义保持。显式恢复重建原生 owner，使用已发布 SDK 可读取的历史，
或经过认证的内容快照加 suffix。Native 快照保留策略可能让从头读取返回410，但 bootstrap
仍成功；这不等于恢复已裁剪的前缀。恢复材料不足时 fail closed，不重置宿主 offset，
也不删除快照。Flock 使用明确的单调逻辑时钟。

关闭先停止接收新工作、abort 请求，再等待真实原始工作与响应体结束，
最后关闭此前的存储/原生 owner。并发 close 调用共享完成结果，包括清理失败。
`StreamsClient.close()` 会发布协议 EOF，不能用于资源释放。
CRDT SDK close 不等待全部单次操作：先等原始工作，再关订阅/SDK，最后 free Loro。
Flock 没有公开确定性 free/dispose；实际结束后丢弃引用。
abort 本身不证明工作已停止，也不保证原生关闭时间有界。

HTTP 消费者在既有 raw lease 内共用一个有界 body reader：EOF 释放 reader，
未读完则等待 cancel 后释放。共享路由筛查只负责实际读取和 control CAS，
mailbox 与内容写入走各自准入，不预设 key/content/snapshot 写许可。
Control 复用具体 SDK adapter 同次验证的 genuine view，不再重放同一历史两遍。

## 尚未完成的边界

- 生产 checkpoint 资格的取得；当前合成宿主已持久保存验证原件／checkpoint，并能续做创建与丢 ACK 间隙。
- 内容快照的生产资格来源及历史保留政策；当前 content v0 字段认证精确续读位置。
- 恢复库及生产／原生候选保护。
- 完整对抗／持续协作探索。原输入 replay／缩减、原密文读取及后端／旧钥攻击测量各有明确覆盖；不承诺重新加密得到相同密文。
- 比较 note 的权威、严格 freshness B、原生存钥和产品接线。

受限 A 仅覆盖可信初始化时保护已安装密钥。已知密钥 AES protector 和可导出设备
都是合成 fixture，不代表 OS 存钥、候选备份或 B 历史发送者信封恢复。
测试、远端 CI、独立审查和产品验收分别成立，不能互相替代。
参见[清单](https://github.com/LodyAI/Lody/blob/5f97599e60700d6185834632df85922ea0d73ec6/.agents/docs/e2ee-migration-manifest.json)、
[组合 Note](../../.agents/notes/implemented/architecture/2026-10-15-e2ee-current-decisions.zh.md#模块与验证边界)
及[来源记录](https://github.com/LodyAI/Lody/blob/5f97599e60700d6185834632df85922ea0d73ec6/packages/e2ee-lab/migration-provenance.json)。完整旧 checkpoint 流水保留于
[Git 5ab9394](https://github.com/LodyAI/Lody/blob/5ab9394392a3577a76b14ab0552c33f755b3ce48/packages/e2ee-lab/README.zh.md)。

## 本地换代与显式快照启动

完整会话可选 `epochRotation: { path, mode, protector }`，初始化独立的本地候选 owner。
`rotateEpoch`、`resumeEpochRotation`、`acknowledgeEpochRotation` 共用 control actor 的
P09 日志及接收器唯一 installed 存储；文档每次从真实账本选择当前代再固定本次加密。
本地候选恢复与下文完整暂存发布共同工作；恢复库及生产／原生保护仍单独保留。

现有工作区启动可选账本／授权快照起点 `snapshot: { bytes, trust, offset }`。认证前先捕获并验证独立资格；
metadata 不能选择权限。重开仍需相同显式起点和独立预期终点。读取启动无需重放旧前缀；
P09 写入仍独立验证全历史。生产资格取得和 snapshot-only P09 写入尚未完成。

## 当前快照与原子移除消费者

文档配置显式 `snapshotUpload: true` 才开放 `uploadSnapshot(id)`。Lab 调用已发布
SDK 标为 internal 的 `uploadSnapshotForTesting`，不是产品公开上传 API。Provider header4
仅为 `[4]`；content v0 在签名公钥后紧接 u16be 字节长度和原样 ASCII 续读位置，
完整字段进入签名与 AEAD。四种文档 purpose 共用文档叶，docEpoch=0；update 的 content-frame
开销保持 143 字节，快照另加2 字节及 offset 字节数。网关核对不晚于 native head 的真实记录边界，
不解释调用方不透明 offset；接收方解密后对比精确位置，native 文档与 cursor 原子保存。
[三角色计划](test/plan-snapshot.test.ts) 实际消费 Loro／Flock 快照加 tail，篡改响应位置时
不推进持久状态，再通过新的真实 bootstrap 恢复；native 保留策略与普通读取410都保持原样。

`removeMemberAndRotate(member)` 复用同一个候选 publisher/P09，把移除与新代写成
一条记录。已入账 R 为本人新 personal 登记、丢回执后重开原记录、认证收钥和读文档
已有真实消费者；这不包含恢复文件或 vault。`comparisonNote()` 仅导出刷新的个人设备
观察，原始比较仍不是独立确认，调用方必须另给实际可信信道取得的 exact tuple。

本地快照 gateway 必须借入显式初始化的持久接纳 journal，没有内存后备。PUT 结果不明时，
宿主 `resumeSnapshot` 只通过 native GET 确认保存的原件，不再次 PUT。Accepted 精确重试
不能复活旧快照。再次调用 SDK 上传方法会生成新随机密文，同位置第二次上传应当冲突。
同一 resource/model 必须只有一个 gateway，等待原生工作真正结束后再重开；不提供多宿主
fencing 或 Riverrun+SQLite 跨库事务。原始未确认尝试过期后明确 blocked，不能靠新 token
悄悄续期；这属于 fail-closed 保留状态，不是完整宿主可用性恢复的证明。

## 可恢复创建与实际重现

创建消费公共 producer 生成的签名 genesis 和另行保护保存的初始已安装钥。客户端在 POST 前
保存原请求；宿主把 genesis 作为 control 首记录发布，完整读回验证并保存已观察历史／原样
cursor 后才返回。崩溃或丢 ACK 均重试原字节。宿主重开仍需独立最小 pin；回执或 SQL 行不能
决定客户端新鲜度。token 绑定不续期，也不授予成员身份。Lab 只采用这一种当前实验布局，
不添加 metadata 补前缀 reader。

`replay` 在新的真实进程和 SQLite owner 执行原动作／放行顺序，复用原合成身份、签名记录、
HPKE／密文帧、发送前候选／outbox 输入与原生本地编辑 delta。真实 HTTP／P09、SDK 导入、
持久化与 cursor 提交再次执行；不回灌已记录 reply、终态结果或文档／cursor 后态。比较实际
结果、精确拒绝、文本、故障命中及每轮内部持久关系；不替换安全随机数，也不支持新加密
密文相等。`minimize` 先实际重现原违规，再为每个有限候选用这些原输入建立独立文件／资源，
保留同一具体失败观察。缺少依赖和无关的测试设施错误不能当作保留成功。

精确原字节读取由 `replayLabCapturedReads` 消费签名历史、header3／header4 密文与预期明文
哈希。调用方另给独立 checkpoint 和取钥能力；pack 不含私钥，也不自己选择信任。实际验签、
解密原字节，不替换安全随机数。

场景把私有写入事实接到独立参考模型，只读扫描 native SQLite `entries` 与 `snapshots` 的
body 中是否出现已知合成明文；实际普通 HTTP 410 保持不变，已保留快照也纳入观察。
证据记录来源及有界行数／字节数，SQL 不选择账本权限。攻击观察器还实际测量伪造 control、
错误上下文／当前作者拒绝和被排除者旧钥读取。攻击能力仅接触后端
字节，不拿正常设备密钥或客户端路径。每项分别报告通过／违规／未测／设施错误；单个后端
扫描通过不能代表完整保密性或整个 Lab 验收。

## 完整宿主与离线续做

`makeLabHostSession` 拥有一个 Org 的实际 Riverrun、HTTP 和全部本地存储。重开必须另给独立
最小 checkpoint，启动时先验证真实远端全历史；每次授权也刷新实际账本。已验证的新观察
若因 SQL 故障未保存，当前对象会拒绝授权和导出 checkpoint，并拒绝回退旧前缀；确认落盘
后才能继续。未保存的知识不承诺跨进程保留，重开仍依赖外部最小 pin。

实际重开覆盖原 P09 待确认记录、未知快照 PUT 的 GET-only 确认，以及重新认证后继续
密钥／加入／Loro／Flock。HTTP 和原始响应体先结束，再关闭 Riverrun 和数据库。

`session.editOffline(id, text)` 只编辑并保存原生文档和旧 cursor，不取钥、不加密、不发网络；
`flushOffline(id)` 用已发布 SDK 同步本地差量，按当前真实 epoch／权限封装。关闭重开、
并行成员合并、SQL 故障重试及已移除成员拒绝均保留本地编辑。更新密封后，同一个文档 SQLite owner 保存原 header／密文、AAD 与明文摘要直到 SDK 确认；网络失败及关闭重开均复用原件，不重新加密。先用 flushOffline 确认待发原件，再做新的本地编辑；不引入另一套队列 owner 或传输协议。

有限攻击计划通过 `makeLabAttackTransport`／`runLabAttackPlan` 控制真实响应的丢弃、重复、
截断、替换、允许响应头修改和显式延迟，也可对特定成员暂留已验证旧前缀后释放。计划不接触凭据和设备秘密；
命中以实际响应事件报告。旧前缀仅说明尚未同步，不自动证明恶意分叉；独立渠道获得的
exact tuple 才可用于比较确认。三成员真实换代／排除、离线恢复和原字节读取都有独立
测量，不能由一次通过推成所有攻击已覆盖。

暂存组只有原记录的已认证签名设备能删除。SQLite port 不把客户端 occupied
声明当作账本证明；诚实发布者另行验证清理条件。其他管理设备即使提供真实的
occupied 元组，也不能删除别人的组。

## 暂存换代与术语

换代先持久保存候选、原签名和全部换代后设备信封，再整组暂存并逐字节读回，
最后提交 P09 CAS。冲突候选废弃；未知结果和崩溃沿同原件重试。会话 keyRound
先验证并接收已提交暂存组，随后继续既有 mailbox/repair。真实已提交完整组的接收者
可在发布者永久丢失后收钥，不依赖其磁盘。这替代旧发布者独立备份选项，不代表 vault 或
原生保管获批。无暂存直接 CAS 仍是可测量的管理者扣钥／可用性限制。

[P07–P14、D12、strict B、RestrictedA 术语](../e2ee-core/README.md#terms)。

## 本轮组合

`full-session` 消费公开 `E2eeWorkspace`。邀请人钉住的权限快照经认证加入信箱下发，保存后按快照与已验后缀重开。历史设备只能读取控制账本以看见自身撤销，不因此获得正文、钥匙、信箱或写入权限。SQLite vault 使用不透明不可变条目／索引 CAS 端口；合成保护器不算桌面保管验收。

每个动作执行前记录独立预测，执行后比较真实结果；网络或存储失败不能证明权限拒绝，缺测保持 unavailable。`explore <目录> <目标和actors.json>` 为手动工具，使用 `OPENAI_API_KEY`、`E2EE_LAB_MODEL`，仅发送显式合成目标、角色配置和动作 schema，不进 CI。模型自报期望被丢弃；真实性质违规须经新进程确定性重放才计入发现。测试使用录制回复，不调用模型网络，接口见 [Responses JSON mode](https://developers.openai.com/api/docs/guides/structured-outputs)。

快照准入使用后端 `record-boundary` HTTP 扩展，不再读内部表；SQLite 0.3.0 精确依赖补丁承载相同的上游改动，不称已发布包原本具备此能力。
