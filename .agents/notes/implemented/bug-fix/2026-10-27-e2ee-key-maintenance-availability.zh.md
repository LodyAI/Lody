# E2EE 收发钥的可用性

Status: implemented
Translation: current
PR: [#1976](https://github.com/LodyAI/Lody/pull/1976)

[English](2026-10-27-e2ee-key-maintenance-availability.md)

## 摘要

已安装密钥损坏会阻止打开修复所需的桌面账本。坏信封、丢失分页位置和未消费结果也会阻塞后续发钥。桌面现在独立打开已验证账本，对确定的信封拒绝发起修复，保存各队列分页提示并确认终态业务结果。验签、commitment、原字节重试和原生操作结束后才释放资源的要求不变；真实平台及云端验收仍独立进行。

## 决策与归属

现有工作区 host 持有维护服务、内存 cursor 和合并中的轮次。每次最多四轮 core 操作，合并的后续处理也最多四次；换 epoch 清空位置，整轮失败不推进位置。关闭只中止本工作区网络，等待已接纳操作结束后释放存储，不引入第二个 writer 或新的恢复寿命。现有 host 已使用原生 Effect，没有迁移台账边界变化。

打开仍验证历史与独立 pin；坏密钥返回 `hasCurrentKey: false`，只有检查成功的旧钥可进入 `writeEpoch`。reader 登记、账本显示和显式刷新因此可用。只有 core 验证同一已提交密钥后才能替换坏 blob，创建原件不变。这收窄 M1/M2 对密钥健康的前提，不降低账本权限或 custody 要求。

仅在信封认证/解开边界设置 `MailboxInstallError.cryptographicRejection`。报告签名、SQLite、权限变化及未知原生错误不能授权拒信封。HPKE 区分 AEAD 认证失败与无法确定的原生初始化/解封装错误。确定的拒绝登记固定 epoch/digest repair，并重取同一页；提示不授予权限。坏页超过轮数需下一次维护事件。无法确定的解封装错误仍重试，即使可能由恶意字节造成；把原生故障视为远端损坏会错误摧毁有效收钥路径。

桌面观察后确认收钥、repair、发钥的终态结果，释放未消费容量，保留账本行和 outbox 原始密文。`Observed` 仍表示邮箱读回一致，不表示收件人掌握密钥。各队列独立保存位置，前页 pending 不再阻塞有限调用中的后页。

## 证据与限制

真实 crypto/SQLite 回归覆盖坏 installed blob、好信封前的坏签名、超过 501 个 pending 发钥任务、终态消费且 outbox 不变，以及存储恢复且不误拒远端信封。前三项在原 runtime 上失败。core 覆盖签名有效但 HPKE 无效的信封及原生故障分类；原有关闭、慢邮箱、配对、换代和历史内容测试仍保留。具体检查见 PR。

合成认证 OS 包装不证明真实钥匙串、安装版桌面、实体设备、线上 repair 或生产启用。CLI 密钥健康恢复和显式身份重置由独立工作负责。
