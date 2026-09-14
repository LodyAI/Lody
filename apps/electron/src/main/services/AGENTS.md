# Main-process service contracts

`CLAUDE.md` is a symlink to this file. Parent Electron instructions also apply.
These rules bind services and callers; the source-level parent routes callers here.

## E2EE key protection

- `e2ee-key-protection*` is opt-in main-only epoch/device-key wrapping, not
  persistence or authorization. Reject plaintext-auth mode, unavailable/unknown
  OS storage and Linux `basic_text`; never add a plaintext fallback or expose raw
  keys via IPC. `e2ee-device-service` and `e2ee-user-service` return public
  descriptors under a main-owned account lease; local mode rejects before auth.
  See the [E2EE draft](../../../../../specs/e2ee-control-log.zh.md).

## Local file resources

- CLI `file/resolve-local` owns session/path resolution; Electron owns file IO. Never
  put local file bytes back into the daemon's JSON response or expose filesystem
  paths in resource URLs. `local-file-resource.ts` issues opaque renderer-lifetime
  capabilities, bounded per renderer, revoked on navigation/destruction.
- Each resource read opens a regular file without following a substituted symlink
  and checks device/inode/size/mtime/ctime before and during reads. Replacement or
  modification invalidates the preview; no mixing revisions or writes through resources.
- Text above the editor budget uses fixed bounded Range requests. Binary uses raw
  streams with backpressure/cancellation; raster header dimensions bound decode cost.
  The scheme never bypasses CSP, executes file content, or authorizes a remote RPC.
