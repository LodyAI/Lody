# MVP 独立移除成员

Status: proposed
Translation: current
PR: [#1979](https://github.com/LodyAI/Lody/pull/1979)

[English](2026-10-27-e2ee-independent-member-removal.md)

## 摘要

强制将移除与换代绑在一起，会在发钥失败时推迟撤权。Owner 选择可用性优先：tag10 立即撤销成员及全部设备，保留已发布 epoch，并提示管理员稍后完成密钥更新。操作前声明 capability 1，快照、保留状态与摘要 v4 保存这一门槛。本草案实现协议边界；服务端投影/凭据失效与诚实端删除本地数据另行接入。被移除者若保留旧钥，在启用新代前仍能解密其取得的对应密文。

## 决定与职责

Owner 个人设备可移除非 Owner；Admin 个人设备只能移除 Member/Guest。Owner 调整角色继续用 tag3。tag2 仍拒绝；tag8 保留 Owner 专用的原子移除换代语义。保留 tag8 无需兼容适配层，且保留一个语义完整的显式操作。tag10 为 `[10, membershipId]`，普通签名/hash 域不变。必须此前已有 tag9 capability 1 声明；未知能力返回 upgrade-required。获授权声明单调并入状态；current-only 紧凑状态 v4 追加排序后的能力列表，不迁移旧状态。首次生产冻结前更新独立 Python/PyNaCl 向量。

移除在一个状态转换中取消目标全部设备与机器绑定。历史作者、退役成员/设备公钥和关闭的加入请求仍保留；同账号返回须新邀请、新成员实例和新密钥。其余有效写入者在 rotationRequired 为 true 时仍能使用已发布代次。这替换[旧决定记录](../../implemented/architecture/2026-10-15-e2ee-current-decisions.zh.md)中的强制绑定，并衔接[手动换代](2026-10-27-e2ee-mvp-manual-rotation.zh.md)。

普通命令沿用 WorkspaceControl 所有权与精确原字节 LedgerSubmission。取消、确认、冲突与未知结果仍由原所有者处理，不增加自动重签或换 parent。该单元已有原生 Effect v4，无需另加迁移单元。

服务端接受移除时须在接纳事务中使全部设备投影、凭据及续签权限失效，先于可选清理。MVP 只依赖现有内容 token 的 15 分钟过期，不主动撤销已发 token 或断开长连接；主动断开留待以后。诚实端下次打开得知移除后删除该加密工作区本地数据，停止同步与远程执行；无法擦除恶意保留的副本。

## 验证与限制

新增原生 Ed25519 用例在改动前失败，覆盖角色/设备种类权限、全部设备失权、历史作者保留、旧代继续加密、新成员实例重新加入、真实命令签名、能力门槛和快照/保留状态等价。现有真实 SQLite feed/reopen 与换代测试随新状态格式运行。这些检查不证明部署后的 token 过期、真实钥匙串、安装版删除行为或 Spec 获批。公开移除 Spec 保持 draft。

最新 main 组合保留 candidate 恢复和独立移除的各自契约。CI 的两个组件分片仍把 capability 1 当作未知能力、沿用旧向量端点；现使用 capability 2（index 13）测试升级停止，端点哈希/数量跟随真实签名向量。更新预期还发现真实读回遗漏：tag10 在现有账本界面抛出 Unsupported ledger operation。现补只读记录与中英展示，真实签名向量回归覆盖移除后 epoch 不变、成员变化及未知能力停止；修补前为 RED。成员管理按钮仍由独立产品接线负责。
