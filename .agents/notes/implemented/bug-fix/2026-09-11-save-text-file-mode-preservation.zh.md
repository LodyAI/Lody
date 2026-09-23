# 保存 Code Collab 文本时保留普通 POSIX 权限

Status: implemented
Translation: current

[English](./2026-09-11-save-text-file-mode-preservation.md)

## 摘要

Code Collab v2 的 `saveText` 用 mode 0666 的临时文件替换已有文件，新权限由进程 umask 决定。保存可执行脚本会报告成功，随后丢失执行位。现在在 rename 之前对临时文件 `chmod` 原文件的普通权限位（`mode & 0o777`），不受 umask 再削。

## 决策

- 保留 digest 冲突检测和 rename 原子替换。
- 非 Windows 上 `lstat` 已有文件，在可见替换前 `chmod` 普通权限。
- 不保留 setuid/setgid/sticky、ACL、xattr、所有者；这些没有作为产品要求独立验证。
- Windows 跳过 chmod；该平台 Node 的 mode 不是 POSIX，本次未测。

## 证据与限制

`code-collab-v2-service.test.ts` 在 Linux 上覆盖 umask 0022 下 0755 仍可执行、0600 仍为 0600、0644 仍为 0644、冲突保存不改 0755，以及删除后保存返回 `file_deleted` 且不重建文件。未完成打包 Electron 点击验收。未测 macOS 与 Windows。
