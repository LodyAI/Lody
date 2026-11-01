# 个人设备客户端 host

[English](README.md)

`@lody/e2ee-client` 是可选的平台中立产品组合，使用现有 `@lody/e2ee-core`。
包内没有 Node、Electron、文件系统、SQLite、默认账号或云端地址。桌面消费共享的
配对编解码、完整历史验证和有限收钥维护流程，保留既有原生存储与产品装配。

## 创建与所有权

在消费方 Scope 中创建 `makeOwnedPersonalDeviceHost(ports)`。`ports` 是拥有资源的 Layer，
提供 `PersonalHostPlatform`、`PersonalHostRemote`、`ClientInstallationStore`、
`ClientCustodyWriter`、`ClientPairingOriginalStore`。它在独立保留的 Scope 中获取这些端口
和底层 scoped host。固定账号、工作区和独立传入的 genesis；
每项能力绑定同一完整身份。另一账号的登录或响应标签不能选择该绑定，缺能力明确失败。

平台提供持久保管、账本端口、密钥存储/后端、公开审批证据和可选 RPC 原件存储。
浏览器可以组合既有 browser-crypto/browser-custody 与 IndexedDB 适配器；移动端用同一
窄 custody 形状接入真实原生生命周期。工厂借用的 credential 只在所属 Scope 内有效，
其 finalizer 必须在释放前取消并排空实际调用。额外 Layer 输出不能替换 host 固定的
身份、验证器和 installed/candidate protector。产品调用者拿不到私钥、credential
或通用签名能力。

- `prepare(offer)` 显式保留身份和请求，先于任何网络。`begin`、`claim`、`cancel`
  交换同一原件。pending、admitting、超时和通用失败都保留它；只有完全匹配的明确
  终态才允许新 session，并保持可用身份与固定 pin。
- `open(offer)` 实际解包并重新验证审批和自身准入。登录、ready 回执或持钥证明都
  不能单独启动收钥。
- session 提供已验证账本读/刷新、有限收钥轮次、状态、文档保护、普通账本命令及
  显式 resume/ACK、换代和固定产品 RPC 的准备/响应验证。命令不会把另一项未决意图
  悄悄当作本次操作，也不会重签未知提交。
- `close()` 停止接纳，取消并等待操作，再释放密钥、credential 和数据库所有者。
  close/logout/清缓存不删除身份。组合不创建定时器、文档 Repo 或普通传输。

## 封装 epoch

新文档、Meta 和 Flock 的 seal 在 core 内部选择当前已验证 epoch。
调用方的旧 epoch 只是提示；缺当前 key 时失败并等待重试，不生成新的旧 epoch 密文。
已封装旧帧和历史读取保持有效；高于已验证账本的 epoch 提示必须等待追赶后重试。

## 有界退休

owned host 和 session 的 `close()` 立即停止新工作，每个实际 drain 共用五秒等待预算。
超时返回 `PersonalCloseIncomplete`，附带窄 `owner`；保留完整失败，直到显式
`owner.awaitSettled()` 确认实际清理。`owner.settled()` 只报告 drain 是否结束，包含失败，
不证明关闭成功。超时不释放 Web Lock、不清理仍被原生借用的缓冲、不删除身份，也不
放行替换交接。

消费方 Scope 使用同一有界关闭。受控 owner 在消费方退出后继续持有整个端口 Layer、
原生操作及资源 Scope。并发调用共用 drain；元数据创建与原生工作分别协调。替换先排空全部匹配的 owned
reader，再调用已提供的外部 owner drain，之后才执行既有原子身份切换。已关闭句柄
不会复活。晚到结算成功后，再次 `close()` 可确认完成。在确认关闭前，runtime 必须保留
该绑定的条目，不能因一个等待者超时就换新 owner。

`makePersonalDeviceHost()` 保留为底层 scoped 实际 drain 构造器。产品/runtime 和
移动端原生组合必须使用 owned 构造器；借入的外部端口须活到确认退休之后。runtime
bridge 的采用由 [#2075](https://github.com/LodyAI/Lody/issues/2075) 跟踪。此入口不激活
产品传输，也不证明原生移动端实现通过验收。

## 共享 platform runtime

`makePersonalWorkspaceRuntime(options)` 在应用 Scope 中，为固定账号/工作区/genesis
创建既有 `E2eeWorkspaceRuntime`。应用提供拥有完整资源的 host Layer、当前账号、
本地保留的 offer/原件行读取端口和 Effect 执行入口；包内不启动 Effect runtime，
也没有默认后端或产品选择器。host 独立核对同一 scope。可选创建回调必须是真实的
创建 host；仅配对的组合明确返回 unsupported。

runtime open 仅取得控制 reader：只重开 ready 的既有身份，重验审批并报告真实密钥
可用性，不准备缺失身份。共享 RuntimeProvider 只有在 hasCurrentKey 或获准 writeEpoch
存在时才开受保护正文；晚到的保留 epoch 也能唤醒同一路径。正文、RPC 和 token 保留
各自的权限/epoch 核对。独立密钥故障不封闭账本；导出的原件摘要和绝对位置必须出现于
真实 view。远端分页只能确认既有已验签 feed，不能另建信任缓存或直接推进游标。

`PersonalHostPlatform.contentToken` 在已批准的 session 内接收完整绑定和设备 credential，
产品只取得专用短期正文/附件 grant；拒绝 token、快照修复提示和 RPC-only 参数原样传递。
RPC 方法只在真实原件 store 存在时出现。可选 machineSharing 在固定身份/scope、已验证
账本源和 installed-key history 上构建 PersonalMachineSharing Layer；真实策略 owner 负责
既有密码、持久原件、generation pin 和 freshness。缺失时不暴露两个共享方法，不用空
handler 宣称其他审批/产品通道已支持。管理沿用原件提交、refresh 和 ACK；移除成员使用
原子 remove-and-publish，换代先恢复原有候选。

每次 open 返回 readerOwner，关闭该租约不影响其他 reader。可选
readerLeases: preallocated-v1 接受 open 第四个参数中的唯一调用标签，provider 可在首次
原生获取返回前关闭自己的请求。已关闭的排队标签不能发布，也不能退休其他 opener 或
既有 reader；旧桌面 host 保留原 API，不宣称支持该可选能力。最后一个 reader 立即停止
接纳；并发关闭共享 owned drain。未完成关闭保留 entry 和完整恢复失败，重开先确认实际
结束。首次获取过程中关闭会退休整个绑定 host；观察到账号改变也永久退休该组合，恢复
账号不会复活旧句柄。应用只能在旧 owner 确认结束后新建组合。父 Scope 使用 owned host
的有界关闭并保留未结算工作。
正文副本在交给执行器前就拥有清理责任，覆盖已退役执行器和失败的应用 Layer。程序进入后
接管清理；调用者被拒绝不提前清零原生工作仍借用的缓冲。已由入口清理的副本拒绝延迟执行。

共享内容桥只有一个实现 createE2eeContent，保留原桌面导入名。provider 同时启动 renderer
清理和 native fencing，不在等待同一正文操作后才调用有界 native close；失败租约保留以供
明确重试。只有重叠的 custody 绑定或 Repo 命名空间等待旧 owner，独立普通工作区保持
可用。设备身份替换仍须等待同一账号/工作区/genesis 的物理 writer。这里只提供可选工厂，不启用 Web/移动端产品入口，也不代表真机验收。
[#2075](https://github.com/LodyAI/Lody/issues/2075) 同时跟踪 owned close 与 bridge 采用。

## 审批、替换与失败

快照审批使用独立传入的 endorser 和固定 core 验证器；完整历史从独立 genesis
重放每个签名。二者都必须准入完全相同的个人签名/加密公钥及成员。受保护的 credential
包还认证不可变 offer pin。原始审批分页及其校验和只是待重放证据，不是权限。

`personalLedgerControl({ approval })` 通过注入的 `LedgerFeedStore`、
`LedgerPinStore`、`SubmissionJournal`、`LedgerLog`、`LedgerFeedSource`、
`WorkspaceScope` 组合持久 `LedgerFeed`。feed/pin 使用稳定数据库，提交槽按身份实例
独立。刷新有界，验证每条后缀后才持久化位置，不 reset 或 rebase 损坏行。

显式 `prepare(offer, true)` 准备受保护替换候选，旧指针保持 current。第二个未决候选
会被拒绝。替换打开要求桌面重新批准的完整历史，以及成功的 pin/origin 验证；之后才
实际 `drainOld` 并按批准合同原子保留 retired 归档、切换 current。host 在新审批原件中
保留首次快照 origin；冷重开从新签名完整历史重新限定其历史管理员、签名和状态。
旧缓存标签或丢失的 KEK 不能授予信任。缺失、未知原件要求重新审批，不重建 KEK。

密钥流程延迟创建，与账本所有权独立。临时密钥/repair 失败可重试，不封住账本。
当前钥缺失时，状态与文档发送仍可选择现有规则允许的保留 epoch；rotation 提示不
阻塞本已获准的发送。撤销、本地身份实例改变、回滚和错误作用域仍阻止密钥/RPC/正文
操作。已提交 epoch 的钥缺失时，先由 core receiver 验证并接收暂存原件；暂存不可用
仍允许 mailbox 接收。背书快照缺少发布原件时走 mailbox/history。core 保留并验证
receive/report/distribution 原件；共享有限维护流程只确认已观察到的业务终态，也会确认另一阶段失败时成功的兄弟阶段。没有明文降级。

## 账号级配对流程

`@lody/e2ee-client/account-pairing` 是各宿主共用的账号级个人设备配对流程（[基础规范](../../specs/e2ee-foundations.zh.md#账号级个人设备配对owner-于-2026-11-01-批准)）。它负责标签和有效期检查、单次签名的接纳日志，以及本地终态。宿主需要提供四样东西：
- `AccountPairingStore`，保存持久状态，其中不含任何密钥或私钥；
- 中继；
- 按工作区的端口；
- 可选的 `diagnostics`。

配对密钥只保存在内存里。桌面端使用 SQLite 存储，浏览器端的存储另行实现。身份保护方式由按工作区的端口决定，不在这个流程里决定。

## 验证与限制

`pnpm --filter @lody/e2ee-client test` 检查固定证明和 credential 边界。
`test:browser` 使用真实 Chromium/WebKit 密码能力、Web Locks 和 IndexedDB，覆盖进程
重开、中断安装读回、未知 relay 结果、关闭、原子换身份、保留 epoch 发送、撤销和事务
故障。可移植 bundle 以 Safari 16.4 为编译目标且无 Node 依赖，不代表 iOS 16.4 真机、
原生插件、硬件或断电验收。IndexedDB `strict` 只是耐久提示。Web 按
[已批准 custody Spec](../../specs/e2ee/client-custody.zh.md) 信任页面下发代码使用私钥。
runtime 工厂是可选能力，其导出不启用任何产品组合。
[所有权理由](../../.agents/notes/implemented/architecture/2026-10-16-e2ee-core-service-architecture.zh.md#个人设备产品组合)。
