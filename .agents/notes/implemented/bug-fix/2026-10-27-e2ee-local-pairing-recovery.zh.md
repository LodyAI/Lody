# 让机器配对恢复始终绑定身份和待批准会话

Status: implemented
Translation: current

[English](2026-10-27-e2ee-local-pairing-recovery.md)

## 摘要

已发布机器身份的 device 原件丢失后，旧访问凭证仍占据仅按 genesis 命名的位置，导致显式批准的替代身份无法保管自己的凭证。桌面再次准备也会在批准前轮换已暂存但未签名的会话。现在凭证位置包含签名公钥，未批准会话在真实入账或原件历史证明结算前保持稳定。旧位置中的当前格式原件只在完整认证绑定匹配时只读重开，不改变保护格式或网络协议。

## 决策与责任

Core 保留现有 KEK、认证保护格式和用途域/genesis/公钥绑定。新凭证独占发布到 `device-credential-${genesis}-${signingKey}.sealed`，精确重试读取获胜原件。新位置缺失时可只读检查旧 genesis 位置，不复制或重写。必须校验 AEAD 和完整预期 AAD。仅在显式准备时，同 genesis、其他公钥的真实当前格式凭证被视为其他身份的保留证据，随后为新身份生成独立凭证。新位置损坏不能回退；旧位置损坏或属于其他 genesis 时不能借此创建凭证。这是同一当前格式的文件名兼容，不是迁移，也不支持旧保护格式。

CLI 仅允许新的显式会话替换 device 原件丢失的已发布身份。旧 material、admission、runtime 目录保留。运行日志和已安装密钥存储的路径仍包含签名公钥，替代身份不会重开旧身份的 epoch 密钥密文。已发布凭证路径与未完成 generation 分开判断，保管或 device 创建前的临时失败仍可重试，无需回退所有权。旧 genesis 位置只有在没有同 key 新路径遮挡读取，且 AAD 与凭证 hash 完整验证后，才可被识别为已发布证据。未发布 creating generation 只要还有自己的原件凭证，就不能替换缺失的 device；同范围接管和 superseded fencing 保持。KEK/selector 缺失、不安全权限、device 非 ENOENT 错误仍失败。

桌面 main 持有待批准 material 和精确签名请求原件。尚未入账的 unsigned material 在双窗口、重试和重启后保持待批准。未签请求的 staged 材料可由当前精确设备状态或已验证原始账本中的精确 admission 结算，即使设备随后被撤销。结算先校验 credential binding，以及绑定到当前 member、genesis、设备类型和密钥的 possession proof，再匹配当前设备或 admission 的原始 key、encryption key 和 proof；仅有 used key 或其他 member 的 admission 不算结算。已入账设备无需新签名即可结算；签名结果未知的请求仍必须由已验证原件或竞争父节点证明结算。原有 all-null superseded 回执和退休约束不变。工作区串行和原生 Scope 释放仍负责生命周期，不增加网络调用或取消规则。

## 证据与限制

真实 crypto、SQLite 和文件测试覆盖只删 device → pairing-required → 显式准备 → 入账 → 邮箱密钥安装 → 激活，保留旧凭证字节和 runtime 证据。保管测试覆盖只读文件名兼容、不同公钥隔离及新文件损坏时禁止回退。桌面测试覆盖批准前反复准备/暂存、重启后精确请求重试、真实结算与 superseded 退休。普通工作区不进入这些模块。完整 CI 和桌面 smoke 仍是必要门禁；合成保护测试不代表真实 keychain、打包 app 或远程配对验收。

此修复更正先前[配对记录](../../proposed/architecture/2026-10-26-e2ee-machine-pairing-journal.zh.md)对部分 custody 丢失的拒绝：未完成 generation 仍被保护，已发布身份则可通过新会话和独立凭证位置恢复。
