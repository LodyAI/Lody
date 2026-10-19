# 原子移除成员与先暂存后提交的换代

Status: draft
Translation: current

[English](atomic-removal.md)

## 账本状态转换

看到 `rotationRequired = true` 的活跃 Owner/Admin 个人设备可生成 tag 7。
tag 8 固定为 `[8, targetMembershipId, nextEpoch, commitment, previousEpochKey]`，
使用现有普通记录、固定项数及原有 sig/v1、rec/v1 域。只有当前 Owner 的个人
设备能生成；目标必须存在且不能是 Owner。新 epoch 恰好加一，拒绝溢出和重复
commitment。tag 2 仍拒绝；没有旧版双读或迁移。

一条 tag 8 同时移除成员及其全部 personal、machine、Recovery 设备，保留历史
作者与退役身份事实，写入新 commitment 和既有 72 字节历史包，清除
rotationRequired。发布者打开历史包核对旧 commitment；回放检查签名、结构与
前态权限，不能仅凭密文长度证明包内密钥正确。

## 先暂存，一次提交

1. 生成候选 key、原始签名记录 R 和哈希 h，以及发给换代后**全部**活跃设备
   （包括 Recovery、Guest）的签名 HPKE 信封。发送前在本地持久保存全部原件；
   候选 key 经初始化的宿主 port 保护。
2. 按 `(genesis, nextEpoch, commitment, h, recipient)` 一次暂存整组。
   Convex 一次 mutation 全写或全不写。随后读回，核对数量和每个信封原字节。
   暂存或读回失败，不发 CAS。
3. 将同一 R 经既有 P09 CAS 提交。Streams 不检查内容。
4. 账本是唯一生效点。冲突后废弃本地受保护候选，不安装、不重签、不偷偷另造
   候选；结果未知按 P09 用 R 原字节对账，重启也沿用同一组暂存信封。

只有真实已验证账本包含该 tag 7/8，且 epoch、commitment、签名者一致时，接收
端才打开暂存信封。未提交候选是惰性的。这里使用历史发布记录作为证明，与普通
mailbox 的当前发送资格分开：发布者后来撤权不能阻断仍获准的接收者。安装前后
仍核对接收设备当前资格、加密公钥以及实际 HPKE/commitment。后来加入的设备
继续使用现有 mailbox 和 repair。

暂存适配器必须证明调用方持有记录 R 的设备私钥，校验 R 及每个信封的固定签名和上下文，
并使同一定位键下的整组原件不可更改。重试须每个字节都相同，否则拒绝，不能替换或缩减。
账号成员／管理权限本身不证明设备身份；云端凭据只有账号身份时，暂存及删除请求还须有
设备签名证明，绑定操作、工作区以及整组／删除请求的完整字段。

只有 R 的原签名设备可以删除自己的组，每页物理清理均重核该身份。Convex 必须在同一个 mutation 内核对原签名者并删除；组不存在时
直接成功，不再删除。其他成员、其他管理
设备即使给出真实 occupied 元组也必须拒绝。服务端验证设备身份，不读取 Streams，
也不把 occupied 声明当作账本证明。诚实客户端还须先独立确认：真实账本在同一个 epoch
已提交了**另一个 commitment**，才请求清理。
超时、年龄、服务器提示或缺少记录均不能授权删除。本地原件、结果仍须显式确认。

## 边界与已知限制

core 仅定义暂存、读回、按条件删除 port；DTO 归 cloud-api；Convex 实现归私有
仓库。Lab SQLite 用一个真实事务写整组。存储和账号角色都不代替签名账本权限；
调用方独立提供并核验真实 view，存储不能证明全局新鲜度。

有 bug 或恶意发布设备可绕过暂存直接提交合法记录，或违反客户端清理规则删除自己的组，
等同扣留新 key；账本换代后
其他设备可能无法继续。Lab 必须测量这个结果。本期不让 Streams 阻止此事，也
不引入跨库事务。暂存保护诚实发布者的崩溃窗口，不保证恶意方生成可解密信封或
永不删除数据。

## 审批与证据

以上方向来自用户明确要求；修订后的 Spec 仍为 **draft，待审批**，不代表生产
启用，也未决定 vault、原生保管、严格 B、账号恢复或 MLS 替换。
参见[准入](../../packages/e2ee-core/src/internal/ledger/ADMISSION.md)、
[暂存 port](../../packages/e2ee-core/src/internal/keys/staging.ts)、
[换代流程](../../packages/e2ee-core/src/internal/keys/publisher.ts)和
[Lab](../../packages/e2ee-lab/README.zh.md)。
