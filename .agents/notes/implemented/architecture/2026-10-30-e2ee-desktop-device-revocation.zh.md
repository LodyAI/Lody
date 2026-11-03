# 桌面端对被撤销设备的停止与清理

Status: implemented
Translation: current
PR: [#2122](https://github.com/LodyAI/Lody/pull/2122)

[English](2026-10-30-e2ee-desktop-device-revocation.md)

## 摘要

本设备的凭据被撤销后，凭据端点已经会返回精确码 `e2ee_device_revoked`。CLI 把它定为 `CloudE2eeDeviceRevoked` 类型，但桌面端把它压成了通用的 `unauthorized` 后端错误。结果是，被撤销的桌面会一直保留 reader、传输和本地副本直到 token 过期，也始终无法确认失权。owner 决定：桌面端把这个精确的已认证结果按"成员被移除"对等处理，只有三点不同——范围仅限本设备身份，不影响成员资格，用户可以重新配对此设备。

## 决策

- **分类。** 只有这个精确码才会变成 `E2eeDeviceRevokedError`。它仍然继承 `BackendError`、reason 为 `unauthorized`，因此其他调用方的行为不变。[成员控制与本地移除](../../proposed/architecture/2026-10-28-e2ee-member-controls-and-local-removal.zh.md) 中的否决仍然成立：通用无权限响应、未分类的消息、网络失败或账号问题都不会触发删除。
- **同一回执、同一清理。** 原来处理成员移除的每个 IPC 位置，现在都把两种类型化的失权传给 `removeLocalWorkspace`，并带上明确原因。宿主写入已有的移除回执；它绑定到具体设备，因为写入时会核对账号、工作区、创世、签名公钥和凭据是否对应当前身份。随后宿主关闭该工作区条目，`cleanupRemovedDesktopWorkspace` 只删除该账号/工作区的身份目录，并只在 custody 中遗忘这一台设备。其他工作区、其他账号以及该成员的其他设备都不受影响。
- **持久化原因。** 新增的 `revoked_devices` 表在同一个 SQLite 事务中为这条精确回执记录原因。没有这条记录即表示整成员移除，因此已有回执的含义不变，也不需要迁移。打开工作区和清理进行中的门禁都报告 `e2ee_device_revoked`，而不是 `member_removed`。已有的加入安装流程只有在核实换成了不同的签名密钥后，才会同时清除这两条记录。
- **渲染进程。** `e2eeAccessLoss`识别这两种精确的原生结果。内容桥接会停止 seal、token 和上传，并通过已有的成员移除路径退役运行时，该路径会保留并执行按窗口划分的 IndexedDB 清理。工作区门禁显示"此设备已被移出工作区"，并提供"重新配对此设备"按钮，跳转到已有的加密控制页。控制页把被撤销的身份归类为 `approval-required`，从而显示已有的配对引导。如果撤销发生时控制页正持有 reader，它会先清理再重新打开，而不是显示终止性的"已移除"。

## 限制

这是诚实客户端的清理，不能安全擦除此前已被复制走的副本。已签发的内容 token 仍保留有限的有效期，与成员移除相同。2026-10-31 owner 批准把保留例外扩展到凭据确认的本设备撤销；[桌面保管](../../../../specs/e2ee/desktop-custody.zh.md)、[客户端保管](../../../../specs/e2ee/client-custody.zh.md)与[白皮书](../../../../specs/e2ee/whitepaper.zh.md)均已写明，范围见[批准记录](2026-10-28-e2ee-spec-approval.zh.md#设备撤销保留例外)。选择撤销即删除，是因为撤销设备的主要原因是设备丢失或被盗；误撤销只需重新同步，而尚未发出的编辑本来也无法再用已撤销的签名密钥提交。只停不删、或延迟删除被否决：两者都会让丢失设备上的明文缓存继续可读。测试使用真实 SQLite、custody 和 IPC 搭配合成的云端结果，另有组件测试。没有运行真实服务端、打包应用，也没有跑第二台设备重新配对的完整旅程。
