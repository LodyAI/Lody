# 在恢复前应用选择的 Codex 模型

Status: implemented
Translation: current

[English](2026-10-09-codex-resume-model.md)

## 摘要

Codex 先按原生配置恢复，Lody 再应用驱动轮的模型，导致用户选择与记录相同的模型时也可能收到模型不一致 warning。宿主现在在启动时携带模型，adapter 在原生会话建立前转换该选择。预热兼容性检查也包含模型。主动切换仍保留原生提醒；旧 adapter 和复用会话仍需要实时配置应用。

## 决策

Core 定义增量的 version-1 启动元数据类型。宿主使用驱动轮的选择，不扫描历史或修改全局默认；成功确认的实时配置供替换进程启动使用。Codex 的显式模型选择优先于旧模型选项，保留旧式推理强度后缀，并让显式强度优先。无需过滤 warning、修改全局配置或改写 rollout。[Spec 草案](../../../../specs/acp-startup-model.zh.md)定义保证。

## 验证与限制

宿主准备和管理测试覆盖启动传参，以及模型不兼容时先清理预热会话。ACP v2 协议测试通过真实 adapter 和配置投影覆盖新建、恢复、加载回放、分叉，并验证非法启动配置在原生会话建立前被拒绝。adapter 类型检查与打包通过。

真实 Codex 0.159.2 的合成会话在记录模型后跨进程恢复：不带启动选择时，恢复成配置中的另一模型并产生一条不一致 warning；带启动选择时，恢复成记录模型，不一致 warning 为零。验证使用临时文件，没有在仓库保留转录或修改用户配置。

55 个 adapter 测试、53 个宿主测试，以及 CLI/adapter/Core 类型检查、adapter 构建、改动文件的格式与 lint、公开边界检查均通过。文档检查仍有六处指向未初始化 Kimi/Pi 子模块的既有链接错误，本次文档没有新增错误。源码修改不会更新已安装桌面版本；集成时两个公开子模块的改动须与宿主改动配套。

配套 PR：[Core 合约](https://github.com/LodyAI/acp-extension-core/pull/21)及 [Codex adapter](https://github.com/LodyAI/acp-extension-codex/pull/66)。独立 adapter 集成前需要发布包含新类型的 Core 版本。根目录 `pnpm format` 通过；全仓 `pnpm check` 因当前检出未安装文档站的 `fumadocs-mdx` 而中止。

## 集成修正

宿主集成最初仍固定在 Core `85ec3ab` 和 Codex `66c724b`，既缺少
`LodySessionConfig`，也缺少原生启动阶段的消费者。这会导致 CLI 类型检查失败；
仅删除类型断言仍会让启动选择不生效。因此一起固定到上述配套提交
Core `d7266e9` 和 Codex `60f1dc4`。这两处源码指针不会发布 Core 新版本，
也不会更新已安装的托管运行时。
