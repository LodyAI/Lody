# Settings (Android)

Read before changing Settings. These rules bind every caller of the area, not only files in its directory.

- Settings Home uses iOS flat groups without Machines or Agent conversation sync; Preferences, Agents, Roles and shortcuts follow [Settings](../../README.md#settings). Optimistic changes roll back on failure. Writes require fresh owner/online permission, preserve conflict bases, and never replay uncertain outcomes. Filter catalog agentUsage by runtime eligibility and provider/config identity; reuse session quota components. Other destinations remain explicit placeholders. Credential drafts remain write-only and ephemeral; never persist or log them.
