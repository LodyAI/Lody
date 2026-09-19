# Run the git credential helper under the CLI runtime

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/644

[中文](2026-09-12-git-helper-cli-runtime.zh.md)

## Abstract

GitHub HTTPS clone already has a token. Dock-launched Lody inherits the macOS GUI PATH
(`/usr/bin:/bin:/usr/sbin:/sbin`), which has no `node`. The helper was
`!node "helper.cjs"`, so git failed with `could not read Username` /
`turn_pre_prompt_failed`. Token prefetch and the broker are in-process HTTP and never
needed PATH `node`.

Host helper is now `!"<process.execPath>" "helper.cjs"` (both words quoted; Windows `\`
→ `/`). Electron also sets `ELECTRON_RUN_AS_NODE=1` so `Lody Helper` is not opened as a
GUI. The diagnostic probe spawns `execPath`, not `node`. Container helpers stay `!node`
because the image has `node` and the host execPath is not in the container.
