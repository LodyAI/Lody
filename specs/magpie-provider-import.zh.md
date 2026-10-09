# 本地 Magpie Provider 导入

Status: draft
Translation: current

[English](magpie-provider-import.md)

在桌面打开 Magpie 导入链接时，无论当前页面是什么，都展示全局确认对话框。
用户通过 checkbox 选择 Claude、Codex、Pi、DSH，可用目标默认全选。确认后仅在
当前桌面的本地执行机器创建 `Claude-magpie`、`Codex-magpie`、`Pi-magpie`、
`DSH-magpie` 内置 Provider；当前选中的远程机器不参与。保留已有 Provider、Role、
账号绑定和原生配置。

## 公开链接

`lody://provider/import?v=1&data=<base64url UTF-8 JSON>` 携带以下有界数据：

```json
{
  "kind": "custom",
  "id": "magpie",
  "name": "Magpie",
  "auth": { "method": "apiKey", "apiKey": "magpie-lody" },
  "endpoints": [
    { "protocol": "anthropic-messages", "baseUrl": "http://127.0.0.1:3425", "targets": ["claude-code"], "modelsUrl": "http://127.0.0.1:3425/v1/models" },
    { "protocol": "openai-responses", "baseUrl": "http://127.0.0.1:3425/v1", "targets": ["codex"], "modelsUrl": "http://127.0.0.1:3425/v1/models" },
    { "protocol": "openai-chat", "baseUrl": "http://127.0.0.1:3425/v1", "targets": ["pi", "dsh"], "modelsUrl": "http://127.0.0.1:3425/v1/models" }
  ]
}
```

允许只提供部分端点或目标。这是本地 Magpie 专用协议，不是任意 Provider 或密钥
导入。只允许 HTTP 回环主机 `127.0.0.1`、`localhost`、`[::1]`，所有端点同源且
API 路径固定。`magpie-lody` 是公开的用量归属标识，不是上游密钥。拒绝供应商密钥、
命令、任意环境变量、未知版本、重复参数或目标、错误数据和超过 8 KiB 的链接。
链接不能指定机器、工作区、模型、权限模式或可执行文件。

公共链接留在操作系统选中的 Lody 安装中，OSS 同样如此。打开链接只暂存在内存中，
不会写入设置或请求网关。错误链接显示脱敏提示；新有效请求替换待处理请求。冷启动
时等待工作区和本地机器就绪。不支持或关闭本地 Agent 时禁止导入，没有远程或云端
回退。本地 daemon 必须声明 `magpieImport` v1 和 `providerSetup`；Pi 还要求
`builtinPi`。部分成功的写入在失败后保留，重试跳过已绑定同一网关和运行时的
Provider，不覆盖已有配置。

## 运行时职责

渲染器只生成已知环境变量映射，经现有 Machine Flock writer 持久化。托管运行时
沿用后台准备队列，DSH 沿用非托管创建路径。导入成功表示配置持久化，不表示模型
请求已成功。Providers 展示托管准备进度和错误。工作区、机器或请求变化时停止
剩余写入，不撤销已经持久化的配置。

`LODY_MAGPIE_GATEWAY` 选择 daemon 拥有的准备流程。每次启动检查 `/api/hello`，
在超时、大小限制和禁止重定向的条件下读取 `/v1/models`。网关不可用、目录无效或
为空时明确失败。网关地址参与能力缓存身份；正常刷新启动新的实时探测。Magpie
目录变化不会热更新已运行的 Agent。

- Claude 接收 Anthropic 端点、标识 token 和 `CLAUDE_MODEL_CONFIG` 模型目录。
- Codex 在 Lody 自有、按网关隔离的 Codex home 中使用 Responses Provider 和生成的
  原生模型目录，不复用 ChatGPT 账号绑定。
- Pi 在 Lody 自有隔离配置中使用生成的 `models.json` 和 OpenAI Chat Completions，
  不导入原生全局配置中的扩展和设置。
- DSH 接收 `DEEPSEEK_BASE_URL`、`DEEPSEEK_API_KEY`，由 adapter 发现模型。

供应商密钥由 Magpie 保管。新运行时默认使用目录首个模型；明确的会话选择通过
正常 ACP 启动契约生效。

## 接入边界与证据

Magpie 必须运行在同一机器。Magpie 的 Agents 列表中新增 Lody 行需要单独提交上游
适配器；本仓库实现接收协议，不修改 Magpie。本次不引入状态 API 或直接编辑数据库
的契约。

- [导入解析与映射](../packages/shared/src/magpie-import.ts)
- [运行时准备](../apps/cli/src/agent/magpie-runtime.ts)
- [决策与验证](../.agents/notes/implemented/feature/2026-10-09-magpie-provider-import.zh.md)
