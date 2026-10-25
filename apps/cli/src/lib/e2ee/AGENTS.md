# Machine E2EE custody

`CLAUDE.md` is a symlink to this file. Parent CLI rules apply.

- This module is lazy and machine-only. Ordinary CLI startup must not probe the keyring.
- First creation probes a temporary Secret Service / Keychain / Credential Manager entry
  by write/read, then permanently selects os-keystore or file protection. Reopen never probes
  or changes that selection. Missing selector or KEK with existing originals is a failure.
- File protection requires owner-only directories/files, no symlinks; Windows uses actual
  owner/DACL checks through the official process Layer, not Unix mode bits.
- Keep common blob formats in core's node-custody adapter; no personal management operations,
  private exports, plaintext device files, or silent downgrade after keyring errors.
- A future machine pairing flow must display file protection before the user approves it.

- Native keyring calls run in a managed helper: 10-second timeout, secrets only on stdin.
  Confirm termination before fallback; preserve process-release recovery owners.
- Windows batches root/file ACL checks in one process. SQLite selection uses asynchronous
  bounded retry on SQLITE_BUSY, never a blocking busy_timeout while awaiting keyring work.
