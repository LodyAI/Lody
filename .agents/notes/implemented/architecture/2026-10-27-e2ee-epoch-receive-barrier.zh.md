# 当前 epoch 优先与有界密钥接收宽限

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/2131
Owner revision: 2026-10-31

[English](2026-10-27-e2ee-epoch-receive-barrier.md)

## 摘要

每次新内容封装都由 host 优先选择已验证的当前 epoch，不依赖 renderer 的缓存提示。当前 key 确实缺失时，owner 在 2026-10-31 修订取舍：为了可用性与后端成本，接受从各设备首次真实观察起最多十五分钟的机密性延迟落实。宽限内可以用最新可用、已保留且已发布的 epoch key 封装新内容。持有旧 key 的撤销设备能够读取这些帧；服务端凭据过期或 epoch 检查不能证明该窗口内的机密性。

## 取舍与保留的 bug 修复

owner 修订的是 #2131 缺当前 key 时严格拒绝的策略，不回退旧 renderer 缓存提示的修复。当前 key 已安装时必须优先使用。桌面原生、CLI、便携/浏览器文档绑定共用 core 的 `writeEpoch: current` 选择，覆盖文档、Meta、Flock 的 update 与 snapshot。RPC/执行准入独立且不变。不新增后端 epoch 强制检查、网络请求、替换 key、明文回退或线上格式。

只有 installed-key 的真实 `missing-key` 结果允许尝试最新可用旧 key；其 publication 和 commitment 必须属于同一真实账本。存储、托管、commitment 或权限失败不能变成缺 key 的成功回退。core 仍在加密前和签名后检查当前成员/设备权限；移除或撤销的设备、Guest、Recovery 不获得写入权限。打开旧 key 后会再次读取当前 key，让并发安装的新 key 在加密前优先。

已在后续 publication 前捕获 epoch 的操作可以完成，已封装排队帧保持原件。历史读取独立于新写入资格。宽限耗尽后 status 仍可报告可读的旧 epoch；这不授权新 seal，也不关闭工作区本地历史。

## 设备本地截止时间与持久化

`VerifiedLedger` 把首次真实观察到的各 published epoch 记录到可选的本地 `LedgerPinStore.writeGrace` CAS 日志。SQLite 在已有 genesis 绑定的 pin 文件里增加有界元数据表；IndexedDB 在既有、绑定的 metadata store 使用独立 key。账本、内容、key wrapper 和线上版本不变。先持久化观察再推进 pin；计时持久化不确定或失败时拒绝回退，不影响真实账本读取及当前 key 写入。

对一个旧 key，最早观察到的更新 publication 启动预算；再次换代不能续期。注入的 Effect Clock 提供墙钟与单调时钟，与持久化首次样本和已消耗时间上界比较；任一时钟倒退即耗尽预算。已有 pin 缺少/损坏计时元数据、CAS/存储失败或单调时钟连续性未知时，都不授予宽限。同一时钟对象下关闭再打开 host 保留原截止时间；新进程、页面或时钟域无法证明连续性，保守地结束剩余宽限，不猜测经过时间，也不重新开始。默认单调时钟在休眠期间的行为依运行时而异，因此也计入墙钟经过时间。这遵守已有的本地 OS/存储非恶意威胁边界，不能证明全局 publication 新鲜度，也不能抵御控制 host 时间/存储的攻击者。

耗时 **>= 900,000 ms** 且仍缺当前 key 时返回可重试的 `key-update-required`；签名后返回旧帧前再次检查截止时间。SDK 保留编辑，由已有 owner 重试。宽限内成功回退不启动密钥提示；只有这个明确的失败 seal 信号才启动 #2138 的三十秒工作区提示，普通 I/O 错误不会误触发。key 安装后由既有 transition phase 清除；保存恢复成功也会清除失败提示，不启动接收请求。接收请求、重试所有权、token 失效和关闭等待规则不变；保存不等待网络接收 key。

## 证据与限制

core 既有 crypto 测试使用真实签名账本、SQLite 和注入时钟，覆盖 update/snapshot、截止边界、host 重开、新时钟域、回拨、元数据缺失及当前 key 立即优先。CLI 与桌面原生测试走实际存储/crypto 绑定；便携 host 使用真实浏览器 IndexedDB 和托管。组件测试连接明确的截止失败、延迟非阻塞提示与安装清除。这些是本地确定性边界检查，不是打包桌面、OS keychain、WAN、休眠恢复或真实设备验收。

接收仍独立验证签名、publication、接收者、HPKE 和 commitment；可选 staging 失败不能阻断合法 mailbox 接收。更早的接收/选择取舍见 [#1954](https://github.com/LodyAI/Lody/pull/1954)，advisory 权限变更见 [#1956](https://github.com/LodyAI/Lody/pull/1956)。原生 Effect consumer 迁移仍由[路线图](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger)跟踪。
