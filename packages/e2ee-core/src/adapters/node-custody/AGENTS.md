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

Device access credentials are independent 32-byte random values, protected with the
existing KEK under `lody-e2ee/local-device-credential/v1\0` plus genesis and device
public key. `prepareDeviceCredential` publishes once; `deviceCredential` only reopens
an existing original. Neither changes device/epoch formats or exports a content key.

Credential files are scoped by genesis and signing public key. The former
single-genesis location is read-only for the same current v1 blob with exact AAD;
no conversion, rewrite, deletion or older-format import is permitted. New identities
publish separate originals and never reuse another identity's credential.
