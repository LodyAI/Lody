# 接受版本周期中的首个 Nightly 发布

Status: implemented
Translation: current

[English](2026-09-29-nightly-zero-sequence.md)

## 摘要

下载清单校验器原本要求 Nightly 后缀为正整数，导致合法的 `-nightly.0` 发布无法在下载页展示。
现在允许零和不带前导零的正整数序号。全部六个不可变安装包链接仍须与清单版本一致；
显示序号不能作为原生构建号使用。

## 证据与限制

`site-docs/lib/nightly-downloads.test.ts` 覆盖序号零及后续发布的完整安装包链接、旧有正整数
序号和非法计数格式。[通道契约](../../../../specs/desktop-channel-execution.zh.md) 记录接受的清单格式。
这项解析器修改不代表公开站点已部署，也不证明真实安装包的更新兼容性。
