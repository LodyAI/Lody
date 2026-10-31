# 强制执行 2026 年 10 月独立 Node 安全版本下限

Status: implemented
Translation: current

[English](2026-10-22-node-security-runtime-floor.md)

## 摘要

工作区与 CLI 原先允许使用早于 2026 年 10 月安全发布的 Node，而它们会下载、解包远端文件并发起 HTTPS 请求。独立 Node 现要求 22.x 中的 22.23.4+、24.x 中的 24.22.1+ 或 26.x 中的 26.12.1+；安装前及 CLI 启动时都执行同一限制。CI 使用明确的已修复版本，SQLite 的 Node-API 10 与架构检查继续保留。Electron 与独立 Node 分开核对。2026-10-30 的更新将桌面运行时固定为 Electron 44.10.0，其内置 Node 为 24.22.1。这是十月 Node 修复对应的桌面运行时补救，不表示已安装应用或生产版本已被替换。

## 决定

[Node 官方安全公告](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)指出，CVE-2026-111497、CVE-2026-106069 影响三个支持版本线；CVE-2026-105483 影响 24.x、26.x。单独 `>=22.23.4` 仍会接受有漏洞的 24.x/26.x 和停止维护的奇数版本，因此使用三段有上界的范围。未来新版本线与预发行版需另行确认后才纳入支持。

根目录无依赖的 preinstall 检查与 CLI 首个导入的检查在安装及 CLI 应用初始化前拒绝不支持的版本。生产构建可能先求值静态外部导入，再执行内联到入口的检查，因此源码导入顺序不保证所有依赖模块都在检查后加载。包声明指导包管理器，不能替代实际检查。2026-10-22 的决定不更新依赖包或运行时文件的版本针。Node 包形式的 managed adapter 继承 CLI 的 `process.execPath`，因此独立 Node 下的子进程也由入口检查覆盖。Electron 的嵌入 CLI 继续接受现有 Node-API 和架构检查；不能用其 Node 版本文本代替回补证据。

## Electron 证据与后续任务

Electron 44.7.0 内置 Node 24.21.0 与 Chromium 152.0.7977.130。其 [Node GN 补丁](https://github.com/electron/electron/blob/v44.7.0/patches/node/build_add_gn_build_files.patch)把 Brotli 链接到 Chromium 的 `//third_party/brotli:dec`，没有使用 Node 自带 Brotli。对应 Chromium [解码源码](https://chromium.googlesource.com/chromium/src/+/152.0.7977.130/third_party/brotli/dec/decode.c)已含 `BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH` 和 `BROTLI_SAFE_WITH_STATUS`，对应 [Node 解码器修复](https://github.com/nodejs/node/commit/49dff6f57aa72cbbe13e480cd41ff4e46837c8fc)。这支持纠正仅按 Node 版本认定该 Electron 构建存在 Brotli 漏洞的结论；证据是源码核对，不是恶意压缩流或漏洞利用测试。

对本地安装的 44.7.0 二进制做离线合成探针：`tls.checkServerIdentity` 接受全角 `１２７.0.0.1` 配 `DNS:127.0.0.1`；Node 22.23.4 拒绝。正常 `127.0.0.1` 配 IP SAN 在两者中都通过。另一独立探针发现 Electron 还接受 `127。0.0.1`、`127.1`、`0x7f000001`、`2130706433` 配 `DNS:127.0.0.1`；已修复的 Node 22.23.4 拒绝全部五种非标准主机名，即使提供匹配的 IP SAN。这些探针展示了 CVE-2026-105483/CVE-2026-106069 对应的全角和数字主机名校验弱点，尚未证明产品实际 URL 或网络路径可利用。嵌入 CLI 的 Node HTTPS/TLS 客户端仍需关注；Chromium 渲染器网络使用不同的证书实现。

[Electron 44.9.3 发布说明](https://github.com/electron/electron/releases/tag/v44.9.3)仅列 ANGLE、Chromium、PDFium、Skia、V8 回补；[DEPS](https://github.com/electron/electron/blob/v44.9.3/DEPS)仍固定 Node 24.22.0。Node 补丁列表未发现主机名验证回补。Electron 45.0.0 同样列出 Node 24.22.0，并有不兼容变化。因此 10 月 22 日的决定没有把这两个版本当作 TLS 修复。

## 2026-10-30 更新

[Electron 44.10.0](https://github.com/electron/electron/releases/tag/v44.10.0) 是最新的稳定 44.x，也是 44.x 中第一条将 Node 更新到 24.22.1 的发布说明。Node 十月安全发布修复了内置 Brotli 解码器的 CVE-2026-111497，以及数字主机名 TLS 校验 CVE-2026-105483、CVE-2026-106069 和 CVE-2026-106072。`apps/electron` 现依赖 Electron 44.10.0。主版本仍是 44；Electron 45 是另一条线。

主机名证据是带合成 SAN 的离线 `tls.checkServerIdentity` 探针：44.9.3 接受五个非规范别名，44.10.0 拒绝包含合法 DNS 与 IP 对照在内的十个用例。该探针不是 TLS 握手、产品登录或网络利用。Brotli 证据是上游修复加上内置运行时真实的 `node:zlib` 解码调用，不是已复现的 Lody RCE。修复后的运行时里 `process.versions.brotli` 仍可能是 1.2.0。系统 Node 和 npm 的 `undici` 不能替换 Electron 内置解码器。合法 Brotli 数据在 44.9.3 上也能解码，因此这次调用本身不能证明越界写入已修复。`scripts/package-electron.mjs` 以 `--publish never` 打出的本机 macOS arm64 包报告 Electron 44.10.0 与内置 Node 24.22.1。afterPack 检查了嵌入 CLI、原生 SQLite、含 spawn-helper 的 node-pty，以及合成 E2EE 存储探针。本机 Developer ID 签名通过了 `codesign --verify --deep --strict`。公证没有执行。打包后的应用会忽略仅用于开发的明文认证存储开关，因此桌面冒烟使用未打包的 OSS 构建、独立 profile 和 `LODY_ELECTRON_PLAINTEXT_AUTH_STORAGE=1`。该冒烟通过了六个 P0 场景。云登录、真实系统钥匙串、Windows 和 Linux 不在本次验收内。生产部署仍由负责人另行执行。

## 验证边界

聚焦行为测试覆盖每个安全下限、紧邻的有漏洞版本、排除的版本线、预发行版、preinstall 拒绝以及 Electron 与原生能力检查的分离。CI 明确指定已修复的 Node 发布。npm 依赖审计仅是补充：不检查 Node/Electron 二进制，修改运行时下限也不会解决其他依赖公告。本地验证和构建不能证明用户已安装应用或生产运行中的镜像已被替换。
