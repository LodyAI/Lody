# 改用 Registry 的版本化二进制启动 Amp

Status: implemented
Translation: current

[English](2026-10-14-amp-acp-registry-binary.md)

## 摘要

Lody 通过本地覆盖项 `npx -y amp-acp` 启动 Registry 中的 Amp Provider，这个命令不带版本号，而所有
npx 启动都会加上 `--prefer-offline`。于是 npm 会一直复用第一次缓存的安装，用户停留在旧适配器上，目录里却显示
Registry 的当前版本。现在删除了该覆盖项，Amp 改用 ACP Registry 的二进制分发；ACP 二进制管理器按版本缓存，
与 Zed 的做法一致。代价是：用户需要自己安装 Amp CLI（以前由 npx 顺带安装）；Registry 没有发布 Windows ARM64
构建；Lody 不校验 Registry 提供的归档校验和。

## 问题

`scripts/generate-acp-registry.mjs` 用本地 `npx` 命令替换了 Registry 的 `amp-acp` 分发方式。
`--prefer-offline` 只对精确版本的包规格安全（`NPX_CACHE_MODE_ARG` 的注释本就这样假设）。
在 `--prefer-offline` 下，npm 用缓存的包元数据解析裸包名：用本地 Registry 桩复现时，0.10.0 发布后仍停在
0.9.0，只有 `--prefer-online` 才升到 0.10.0。适配器 0.8–0.10 增加了 Amp 模型选择、带历史重放的会话恢复和持久化
线程生命周期，过期缓存会让用户看不到这些行为。

## 决定

- 删除 `amp-acp` 本地覆盖项。生成器现在保留 Registry 的 `binary` 分发，由 `AcpBinaryManager` 从
  `acp-bin/amp-acp/<version>/<platform-arch>` 启动；Registry 版本变化即新的缓存目录，带有重新生成目录的 Lody 版本发布后，用户就会升级。
- 不再有本地 `npx` 启动项，`resolveRegistryAgentACPSetting` 不再给本地命令加缓存参数。测试断言没有 Registry
  Agent 使用本地 `npx` 命令，且每个 Registry npx 启动都指定精确版本。
- 生成文件只按生成器的输出格式改动了 `amp-acp` 条目，避免顺带升级其他所有 Provider。

更小的替代方案是在 npx 覆盖项里锁定 `amp-acp@<version>`。没有采用，因为它仍依赖 Node.js，且手动升级会与
Registry 脱节。

## 限制

- 二进制只是适配器：它从 PATH 运行 `amp`（或 `AMP_CLI_PATH`）。以前的 npx 安装恰好带上了 `@ampcode/cli`，
  并把其中的 `amp` 放进适配器的 PATH，所以只配置了 `AMP_API_KEY`、没有安装 Amp CLI 的用户以前能用，现在会在第一次
  发消息时失败（`Executable not found in $PATH: "amp"`）。Provider 验证发现不了：它只到 `session/new`，而没有
  `amp` 时这一步也会成功。接受这一点，是因为适配器文档把已安装的 Amp CLI 列为前提，Zed 的 Registry 安装也有同样要求，
  且官方安装脚本会把 `amp` 链接到 `~/.local/bin`，Lody 本来就会把该目录加入 ACP 的 PATH。
- Registry 没有 `windows-aarch64` 构建；在 Windows ARM64 上，Amp 现在会报二进制管理器的“不支持平台”错误，
  不再通过 npx 运行。
- `normalizeBinaryEntry` 会丢弃 Registry 的逐归档 `sha256`；下载只依赖 HTTPS，与其他二进制 Agent 相同。
- 已在 orb 的 linux-x86_64 上验证：启动解析到 0.10.0 二进制，ACP `initialize` 返回 `amp-acp` 0.10.0，并带有
  `loadSession` 和恢复能力。未实际运行 macOS 和 Windows。已有的 Amp Provider 会在下次启动时切换启动方式；
  其能力缓存键（`amp-acp@0.10.0`）不变。
