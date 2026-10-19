# 在 Messages 升级后兼容 DeepSeek 官方地址

Status: implemented
Translation: current

[English](2026-10-10-dsh-official-messages-endpoint.md)

Provider PR: [acp-extension-dsh #29](https://github.com/LodyAI/acp-extension-dsh/pull/29)

## 摘要

Harness 切换为 Messages 后，Lody 官方 Provider 表单仍保存 Chat API 根地址，
导致模型发现成功、发送消息却返回 HTTP 404。现在由 provider 在构造原生服务前
归一已知官方地址，表单保存 Messages 根地址。模型发现独立使用官方 `/models`，
自定义路由和已存凭证保持不变。新旧官方配置均通过真实 ACP 消息验证；未重新构建
或替换已安装的桌面发布版本。

## 决策

[Harness 升级](../feature/2026-10-09-dsh-harness-upgrade.zh.md)遗漏了官方表单默认值
及地址识别。地址规则归 provider 所有，由 Lody 表单、生成 profile、模型发现和
计费共同使用。profile v19 更新生成配置和能力缓存标识。

- 只将官方 HTTPS 主机的根路径、`/v1`、`/anthropic`、`/anthropic/v1` 及末尾斜杠
  识别为官方地址。其他主机、端口、内嵌凭证、查询参数和片段均不作别名转换。
- 与上游一致，settings 优先于环境变量。在构造原生 provider 前，将官方推理地址
  归一为 `https://api.deepseek.com/anthropic`，不修改 settings.yaml 或宿主环境。
  settings 文件不存在时也必须执行地址兼容。
- 官方模型列表固定请求 `https://api.deepseek.com/models`；自定义地址保留追加
  `/models` 的原有契约。新旧官方地址均用于官方计费及表单官方选项识别。
- 不隐式转换自定义 Chat 网关。它们需要 Messages 路由，或显式配置
  `llm-pi-ai` Chat provider。

本次修复落实仍为草案的[设置契约](../../../../specs/deepseek-harness-settings.zh.md)。

## 验证

- Provider：构建、57 项单元测试、格式检查、7 项原生 settings-profile 冒烟测试。
  覆盖配置优先级、文件缺失、相似域名和自定义地址、模型选择及官方计费。
- 宿主：48 项配置对话框测试，覆盖官方创建、新旧地址回填和保存、自定义地址保留。
  根目录格式化通过。
- 真实测试：使用本机已有官方凭证，在隔离的生成 ACP profile 中分别传入旧根地址
  与 Messages 根地址。两次均发现两个模型（`GET /models` 返回 HTTP 200），
  通过 `POST /anthropic/v1/messages` 发送合成提示（HTTP 200），收到预期回复并
  以 `end_turn` 完成。不提交用户会话或凭证。
- 根目录 `pnpm check` 被嵌套 checkout 缺少依赖或类型声明阻塞，最先报告的包为
  `@loro-dev/ignore`；UI 类型检查也受缺失的 Electron 依赖阻塞，不能声称全仓检查
  通过。文档检查仍存在既有债务。
