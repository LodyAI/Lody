# Encrypted workspace control route

Ancestor rules apply. `CLAUDE.md` is a symlink to this file.

The route owns its account/workspace reader until actual retirement. A successful
member-management operation refreshes the verified ledger through that same
reader; it must not increment the reader generation or close/reopen the host.
Management success alone does not supply the displayed role: publish only the
validated host ledger and retain its observed checkpoint. A failed validation
blocks management and preserves prior verified evidence.

Late management results and ledger reads belong to their captured reader and
route scope. They cannot publish into a replacement account, workspace or reader.
Explicit recovery, reconnect and identity changes retain the existing retirement
and drain rules. Never relax native reader admission or authorization to make a
passive read succeed.
