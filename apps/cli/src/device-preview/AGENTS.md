# Device preview

CLI ancestor contracts apply. This directory owns the shared device-preview lifecycle,
viewer, authenticated gateway and transport. Platform adapters own native protocols.

- Keep operations and endpoint cleanup isolated by platform and Session. Browser is an independent owner.
- Revoke inputs and join native cleanup before releasing the machine-wide device lease.
  Failed cleanup must not release an unsafe device or block unrelated devices.
- Local viewers work offline. Remote endpoints require exact platform-specific signed
  operations; never reinterpret an iOS proof as Android authority.
- Only fixed typed controls cross the private viewer boundary. Never expose raw ADB,
  native URLs, shell commands or credentials through workspace data.
- Encoded frames preserve reference order; bound every queue. Platform adapters validate
  their native packets before shared flow control, and recovery never replays input.
