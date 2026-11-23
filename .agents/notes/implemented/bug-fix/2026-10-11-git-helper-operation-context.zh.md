# HTTP helper 再次调用时保留 Git 操作上下文

Status: implemented
Translation: current
PR: [#1476](https://github.com/LodyAI/Lody/pull/1476)

[English](2026-10-11-git-helper-operation-context.md)

## 摘要

Git clone 的内部 HTTP helper 再次经过包装脚本时，将读取标记覆盖成写入，导致有效的
GitHub 只读凭据被拒绝。生成的包装脚本现在仅对 `remote-http` 和 `remote-https`
保留有效的继承上下文。独立命令仍自行分类，未知命令或无效的 helper 上下文仍保守
执行写权限探测。回归测试覆盖包装脚本再次调用到凭据选择的链路，并使用真实 Git
对合成只读仓库执行递归克隆；未验证生产 GitHub 和 Windows。

## 决策

[Issue #1471](https://github.com/LodyAI/Lody/issues/1471) 暴露了
[身份降级决策](../architecture/2026-10-03-github-identity-fallback.zh.md)的实现缺口。
读写访问通告必须匹配发起命令：HTTPS 读取使用 `list`，push 使用 `list for-push`。
修复不改变凭据优先级、owner 资格或禁止重放写操作的约束。

HTTP helper 同时服务读取和 push，因此加入只读白名单会错误降低 push 的检查要求。
所有命令无条件优先使用继承上下文，也会让独立 push 继承先前的读取标记。仅允许
这两个 helper 命令继承，且只接受 `read` 或 `write`。

改动的是生成的独立 Node 脚本内的同步分类。原生 Effect 迁移需要改变 helper 的运行时
打包和进程生命周期，对这次分类修复没有直接帮助；这些边界不纳入本次修改。

## 验证

所属测试现在先执行两次生成的包装脚本，再执行凭据适配器。只读候选拒绝写权限通告，
因此测试观察读取传输成功或传输前失败，而不只检查环境字符串。覆盖两个 HTTP helper、
现有全部读取命令、新读取继承写标记、push 继承读标记、以及 helper 上下文缺失或无效。
现有真实递归克隆夹具现在拒绝 receive-pack，补上了合成身份原先同时接受两种权限的缺口。

修复前，包装脚本到适配器的读取回归用例以 `credentials_exhausted` 失败。修复后，
将原生 Git 放在 PATH 前部并移除继承的 Git 路由，18 个传输测试全部通过。合成夹具不能
混入会话自身的 Git 包装脚本。连同凭据运行时套件，共 27 个相关测试通过。全仓类型检查、
lint、格式化和文档检查通过。`pnpm check` 因容器无法监听 IPv6 `::1`（`EAFNOSUPPORT`）
而停在无关的预览夹具：CLI 共 4015 项通过、1 项失败、1 项跳过，全工作区测试未完成。
