# Node key custody

`CLAUDE.md` is a symlink to this file. Parent core rules apply.

- This host-only entry is never imported by protocol, host or browser barrels.
- Keep existing blob domains, AAD, publication and rewrap formats unchanged.
  Electron and CLI qualify their own KEK wrappers; generic custody never guesses OS backends.
- File protection admits machine identities only. Personal devices require OS protection.
  The CLI owns permanent first-creation selection, file permissions and Windows ACL checks.
- An explicit Scope owns the KEK and native promises. Stop admission, await actual
  in-flight operations, then release stores and wipe owned buffers. No timers/PID lock takeover.
- No arbitrary signing or secret export in IPC. Expose only purpose-limited product operations.
  Missing/corrupt originals are not permission to replace a device or key.
