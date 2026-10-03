# 内置 Geist 与分包 vivo Sans SC

Status: proposed
Translation: current

[English](2026-10-03-interface-font-delivery.md)

[Draft 审查](https://github.com/LodyAI/Lody/pull/1235)

## 摘要

默认界面需要协调中西文，但首屏不能下载 44 MB 中文字体。审查实现使用官方
Geist 和 vivo Sans SC 可变 WOFF2 分包：界面文案优先、常用汉字其次、长尾按需。
保持字号层级、等宽栈与原生可变轴，字体构建可复现，不提交字体二进制。
vivo 协议未明确授权格式转换或子集化；仅作传输优化的解释仍有不确定性，
不能描述为厂商书面授权。

## 决策与边界

[字体模块](../../../../packages/components/src/tailwind/interface-fonts/README.md)
负责来源、加载、原协议和验证命令。只改共享默认 token，不替换保存的字体覆盖，
不统一相邻控件的字号或字重。Renderer 构建输出相对路径 hash 字体资产和原协议；
应用运行时离线加载，失败使用系统回退。不携带实验候选包、截图或字体二进制。

原 SC 可变字体为 44,430,172 字节。延迟下载整包不能满足首屏加载边界；单个 WOFF2
仍要求全量加载，机械等码点分包容易使常用文案跨多个包。当前方案优先覆盖项目
全部中文文案，再覆盖剩余 GB2312 一级汉字，只有长尾按 512 码点分包。完整离线
发行体积仍大于首屏请求，分包会重复部分元数据和可变字体开销。

保留的 vivo 协议 §2.2 禁止改编/二次开发，§2.3 区分单独分发与 App 等作品；两者
均未明确解决无损格式转换和覆盖分包的边界。保留字形、轴、命名、hinting 与版权，
在审查中明确这一不确定性。OS/2 嵌入位及其他项目许可均不能授予法律权限，不得
把这些资产作为独立字体包发布。

新增构建前提为 uv 与固定版本 fontTools/Brotli。只在构建时下载公开原包，hash
不匹配则失败；复用资产前核对配方、内容及文件 hash，共享 CI 工具链安装 uv。
不启用产品云能力或遥测。

构建还要求固定的 adapter manifest 与根锁文件一致。基线 `e5b7bde30` 更新
Codex/Core gitlink，却未同步 Codex importer；main `9bdac2851` 仍有此缺口。
只同步该 importer 及必要 peer snapshot，保留无关依赖解析。pnpm 10.20 对发布时间
例外只取第一条同包规则，因此把已选 Codex 版本和平台 alias 合成一个确切版本
并集，不开放通配例外，不改 ACP 源码或子模块 pin。

完整 Storybook 暴露两个既有汇总入口循环：chat selectors → shared selectors →
chat selectors，以及 Appearance → settings barrel → Appearance。直接引用同一
selector 与既有 `settingsSurface.container`，不加兼容重写，不改配置行为或样式
token。字体署名模块改用相对导入，使 Electron 较窄的类型路径也能解析。

## 证据与边界

[浏览器回归](../../../../packages/components/tests/e2e/interface-typography.spec.ts)
使用实际字形记录而非 computed family，覆盖 portal、延迟/失败加载、五档设置、
浅深主题和窄窗口。[确定性字体检查](../../../../packages/components/scripts/test-interface-fonts.py)
核对完整互斥的已映射非 Latin 覆盖、协议、可变轴，在默认值与两端采样分解后的
字形轮廓及 advance width；不等于所有字形和插值位置的穷尽证明。

现有复杂合成场景保留在本地用于 before/after、冷暖缓存和生僻字测量，其实验控制器
不是生产代码，也不进入该改动。实现预算为首屏 3 MiB、最多三个 Geist/vivo 请求，
暖缓存复用正文，初始 CLS 低于 0.05。Vite 开发服务使用 `no-store`，缓存验收以构建
资产为准。macOS Chromium 结果不能证明全部平台或桌面打包结果。
九项 Chromium 回归已在完整构建的 Storybook 运行时通过，覆盖五档字号与 portal；
确定性字体检查通过。完整复杂 React 页面测得首屏 Geist/vivo 2,654,308 字节，
暖缓存零传输，生僻字单独新增 318,716 字节。相同场景的原 TTF 为 44,430,472 字节，
单个 WOFF2 为 23,079,052 字节，机械分包请求九包共 20,493,224 字节。
初始 CLS 为 0.02886，before 为 0.02861。此前冻结 DOM 结果仅属传输验证，本轮
运行时证据替代其验收边界。结果来自 loopback HTTP，不代表远程网络或打包后的
安装程序。完整 OSS 桌面与 Storybook 构建、冻结安装、公开/平台边界检查通过；
隔离的真实 Electron Appearance 场景通过，Electron 单元测试 199 项通过。

Node 26.10.0 下，完整仓库检查在 `NODE_ENV=test`、
`NODE_OPTIONS=--no-experimental-webstorage` 时通过。普通 Node 26 会复现未改动的
boot-shell storage spy 用例失败（4,759 个组件测试中的一个）；关闭 Node 实验性
storage 后恢复浏览器/jsdom 边界，没有修改产品或测试源码。已装 Node 22 因缺
Homebrew simdutf 动态库无法启动，本机 Node 22 未验。docs check 仍有六项既有
链接指向未初始化、根工作区排除的 Kimi/Pi checkout，不将该检查算作通过。
相关字号决策：[界面文字层级](../../implemented/simplification/2026-10-03-interface-typography.zh.md)。
