# Settings (Android)

Read before changing Settings. These rules bind every caller of the area, not only files in its directory.

- Settings Home uses iOS flat groups without Machines or Agent conversation sync; Preferences, Agents, Roles and shortcuts follow [Settings](../../README.md#settings). Optimistic changes roll back on failure. Writes require fresh owner/online permission, preserve conflict bases, and never replay uncertain outcomes. Filter catalog agentUsage by runtime eligibility and provider/config identity; reuse session quota components. Other destinations remain explicit placeholders. Credential drafts remain write-only and ephemeral; never persist or log them.

- GitHub Settings and Add Project share a fresh personal-operation authorization preflight before requesting installation state. Missing or expired grants offer Web settings through the configured backend’s neutral installation callback; the user signs into the same Lody account, authorizes, then returns and retries. Failed or malformed reads remain retryable errors, never missing-grant claims. Keep the existing live role checks and final server authorization, and do not change the personal operation preference.
