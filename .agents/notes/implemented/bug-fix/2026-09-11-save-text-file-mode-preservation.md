# Preserve ordinary POSIX mode when saving Code Collab text

Status: implemented
Translation: current

[中文](./2026-09-11-save-text-file-mode-preservation.zh.md)

## Abstract

Code Collab v2 `saveText` replaced an existing file with a temp file created at mode 0666, so the process umask decided the new permissions. Saving an executable script reported success and then lost `+x`. The helper now copies the original file's ordinary permission bits onto the temp file with `chmod` before rename, which is not masked by umask.

## Decision

- Keep digest conflict detection and atomic replace-via-rename.
- On non-Windows, `lstat` the existing file and `chmod` the temp path with `mode & 0o777` before it becomes visible.
- Do not preserve setuid/setgid/sticky, ACLs, xattrs, or ownership; those were not independently verified as product requirements.
- Skip the chmod on Windows; Node file modes there are not POSIX, and this change is untested on Windows.

## Evidence and limits

Linux tests in `code-collab-v2-service.test.ts` cover 0755 remaining executable after save under umask 0022, 0600 remaining 0600, 0644 remaining 0644 under umask 0022, a digest conflict leaving 0755 untouched, and a deleted-file save that returns `file_deleted` without recreating the path. Packaged Electron click-through was not completed. macOS and Windows were not tested.
