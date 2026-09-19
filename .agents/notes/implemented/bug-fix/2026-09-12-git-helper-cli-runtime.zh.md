# 在 CLI 自身运行时下执行 git 凭据助手

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/644

[English](2026-09-12-git-helper-cli-runtime.md)

## 摘要

GitHub HTTPS clone 本身已经拿到了令牌。从 Dock 启动的 Lody 继承的是 macOS 图形界面的
PATH（`/usr/bin:/bin:/usr/sbin:/sbin`），其中没有 `node`。而助手命令是
`!node "helper.cjs"`，于是 git 以 `could not read Username` 失败，对外表现为
`turn_pre_prompt_failed`。令牌预取和 Broker 都是进程内 HTTP，从来不需要 PATH 上的
`node`。

现在宿主机助手是 `!"<process.execPath>" "helper.cjs"`（两个词都加引号；Windows 上
`\` → `/`）。在 Electron 下还会设置 `ELECTRON_RUN_AS_NODE=1`，避免把 `Lody Helper`
当作 GUI 打开。诊断探针启动的是 `execPath` 而不是 `node`。容器内的助手仍为 `!node`，
因为镜像里有 `node`，而宿主机的 execPath 并不存在于容器中。
