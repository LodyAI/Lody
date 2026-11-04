# 强制执行 2026 年 10 月独立 Node 安全版本下限

Status: implemented
Translation: current

[English](2026-10-22-node-security-runtime-floor.md)

## 摘要

工作区与 CLI 原先允许使用早于 2026 年 10 月安全发布的 Node，而它们会下载、解包远端文件并发起 HTTPS 请求。独立 Node 现要求 22.x 中的 22.23.4+、24.x 中的 24.22.1+ 或 26.x 中的 26.12.1+；安装前及 CLI 启动时都执行同一限制。CI 使用明确的已修复版本，SQLite 的 Node-API 10 与架构检查继续保留。Electron 单独核对：其 Chromium Brotli 已含有关解码器修复，但 Node TLS 主机名验证仍待上游安全版本与发布验证；本次不宣称已修复打包桌面端。

## 决定

[Node 官方安全公告](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)指出，CVE-2026-111497、CVE-2026-106069 影响三个支持版本线；CVE-2026-105483 影响 24.x、26.x。单独 `>=22.23.4` 仍会接受有漏洞的 24.x/26.x 和停止维护的奇数版本，因此使用三段有上界的范围。未来新版本线与预发行版需另行确认后才纳入支持。

根目录无依赖的 preinstall 检查与 CLI 首个导入的检查在安装及 CLI 应用初始化前拒绝不支持的版本。生产构建可能先求值静态外部导入，再执行内联到入口的检查，因此源码导入顺序不保证所有依赖模块都在检查后加载。包声明指导包管理器，不能替代实际检查。不更新依赖包或运行时文件的版本针。Node 包形式的 managed adapter 继承 CLI 的 `process.execPath`，因此独立 Node 下的子进程也由入口检查覆盖。Electron 的嵌入 CLI 继续接受现有 Node-API 和架构检查；不能用其 Node 版本文本代替回补证据。

## Electron 证据与后续任务

Electron 44.7.0 内置 Node 24.21.0 与 Chromium 152.0.7977.130。其 [Node GN 补丁](https://github.com/electron/electron/blob/v44.7.0/patches/node/build_add_gn_build_files.patch)把 Brotli 链接到 Chromium 的 `//third_party/brotli:dec`，没有使用 Node 自带 Brotli。对应 Chromium [解码源码](https://chromium.googlesource.com/chromium/src/+/152.0.7977.130/third_party/brotli/dec/decode.c)已含 `BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH` 和 `BROTLI_SAFE_WITH_STATUS`，对应 [Node 解码器修复](https://github.com/nodejs/node/commit/49dff6f57aa72cbbe13e480cd41ff4e46837c8fc)。这支持纠正仅按 Node 版本认定该 Electron 构建存在 Brotli 漏洞的结论；证据是源码核对，不是恶意压缩流或漏洞利用测试。

对本地安装的 44.7.0 二进制做离线合成探针：`tls.checkServerIdentity` 接受全角 `１２７.0.0.1` 配 `DNS:127.0.0.1`；Node 22.23.4 拒绝。正常 `127.0.0.1` 配 IP SAN 在两者中都通过。另一独立探针发现 Electron 还接受 `127。0.0.1`、`127.1`、`0x7f000001`、`2130706433` 配 `DNS:127.0.0.1`；已修复的 Node 22.23.4 拒绝全部五种非标准主机名，即使提供匹配的 IP SAN。这些探针展示了 CVE-2026-105483/CVE-2026-106069 对应的全角和数字主机名校验弱点，尚未证明产品实际 URL 或网络路径可利用。嵌入 CLI 的 Node HTTPS/TLS 客户端仍需关注；Chromium 渲染器网络使用不同的证书实现。

[Electron 44.9.3 发布说明](https://github.com/electron/electron/releases/tag/v44.9.3)仅列 ANGLE、Chromium、PDFium、Skia、V8 回补；[DEPS](https://github.com/electron/electron/blob/v44.9.3/DEPS)仍固定 Node 24.22.0。Node 补丁列表未发现主机名验证回补。Electron 45.0.0 同样列出 Node 24.22.0，并有不兼容变化。本次不能将两者确认为安全 TLS 修复，因此不做猜测式升级。

关闭桌面端问题前，需要上游发布包含 [105483](https://github.com/nodejs/node/commit/de49c913f232fd9c216bf164818c87c0cb645b7b)、[106069](https://github.com/nodejs/node/commit/935918e3427911f2bef315638d68308dfecc61ba)修复或等价且有记录的回补。随后核对实际源码，在将交付的二进制中运行上游主机名回归用例，并在每个支持平台验证嵌入 CLI、原生模块和打包桌面启动。升级系统 Node 不会替换已经交付的 Electron 运行时。生产部署与安装包交付由负责人另行执行。

## 验证边界

聚焦行为测试覆盖每个安全下限、紧邻的有漏洞版本、排除的版本线、预发行版、preinstall 拒绝以及 Electron 与原生能力检查的分离。CI 明确指定已修复的 Node 发布。npm 依赖审计仅是补充：不检查 Node/Electron 二进制，修改运行时下限也不会解决其他依赖公告。本地验证和构建不能证明用户已安装应用或生产运行中的镜像已被替换。
