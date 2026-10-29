# E2EE Spec 批准范围

Status: implemented
Translation: current

[English](2026-10-28-e2ee-spec-approval.md)

## 摘要

2026-10-28，owner Zixuan Chen（zxch3n）明确批准了所列 E2EE Spec 修订。权限账本仅批准已确认或已实现部分；账本 v1 冻结前，未定格式细节须单独审查。桌面保管在产品启用前须完成真机验收。恢复库保持 draft，且不在 MVP 范围内。

## 决定

Owner 批准了[原子移除](../../../../specs/e2ee/atomic-removal.zh.md)、[发布者密钥可恢复性](../../../../specs/e2ee/publisher-key-recoverability.zh.md)、[快照加入](../../../../specs/e2ee/snapshot-join.zh.md)及[桌面保管](../../../../specs/e2ee/desktop-custody.zh.md)。产品启用前须在真机验收中验证打包 Electron 与 macOS、Windows 的真实系统钥匙串。

[权限账本](../../../../specs/e2ee/permission-ledger.zh.md)仅批准已确认或已实现部分。第 9 节及标为待确认、待审或待定的字段与参数不在批准范围；账本 v1 冻结前须单独进行格式审查。[恢复库](../../../../specs/e2ee/recovery-vault.zh.md)保持 draft，不在 MVP 范围内。批准不代表产品已启用或真机验收已完成。

2026-10-28，owner Zixuan Chen（zxch3n）通过 E2EE 总调度进一步批准现有实现的 tag 9 能力声明、capability 1 和 tag 10 移除，包括现有 1–16 个严格递增非零 u32 能力码、现有长度上限，以及遇到不支持的声明时以 `upgrade-required` 停止。此决定来自[冻结前审查](https://github.com/LodyAI/Lody/pull/2026)；恢复格式问题及第 9 节仍不在此次批准范围。

2026-10-28，owner Zixuan Chen（zxch3n）通过 E2EE 总调度批准恢复设备 tag 4 与 `possess/v2` 字节不变、不修改 genesis；恢复 generation 和可信账本材料保存在加密恢复包中，可信锚由外部独立确认。owner 同时批准恢复包 `formatVersion: 1` 与验收条件：独立确认可信锚、导入恢复密钥、实际解密当前代信封并核对承诺。这些是格式边界，不代表整个[恢复保险库 Spec](../../../../specs/e2ee/recovery-vault.zh.md)获批；保险库仍为 draft，且不在 MVP 内。[格式审查](https://github.com/LodyAI/Lody/pull/2026)记录字节形状和依据。
