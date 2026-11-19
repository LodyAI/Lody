# Experimental native Repo adapter

Ancestor Shared and Node rules apply. The daemon owns the SDK host; desktop main
attaches as a client. Never stop the host when releasing a window or attached
client. SDK locking remains the single-writer authority.

This slice is local-only, opt-in and uses a separate new-data directory. No legacy
room import, dual write, cloud transport, E2EE or Roost access belongs here. Product
code targets SDK APIs directly; local SDK overrides and build identity checks must
not enter committed manifests or runtime admission.

Use bounded key/prefix reads and read-set conditional writes. Share
`room-observation` across Node and renderer; domains own authorization and projection,
not release/reconnect state machines. IPC exposes domain commands and views only.

[Design and slicing plan](../../../../../.agents/docs/native-repo-first-slice.md).
