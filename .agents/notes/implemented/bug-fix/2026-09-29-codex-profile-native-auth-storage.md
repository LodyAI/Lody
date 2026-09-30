# Codex profile login without a system keyring

Status: implemented
Translation: current

[中文](2026-09-29-codex-profile-native-auth-storage.zh.md)

## Abstract

Managed ChatGPT profiles forced Codex keyring storage, so device authorization
could succeed in a headless Linux container while credential persistence failed.
New profiles now use the pinned Codex runtime's native default in their isolated
home, which permits file storage without moving credentials between accounts.
Profiles already ready under the former keyring policy retain that backend;
the separate API-key vault still requires system credential storage.

## Decision and compatibility

[Issue #1109](https://github.com/LodyAI/Lody/issues/1109) records a successful OAuth
exchange followed by a Linux Secret Service write failure. Codex 0.156.0 defaults
`cli_auth_credentials_store` to `file` when unset, so omitting Lody's keyring
override lets it write `CODEX_HOME/auth.json` in the profile's private home.
Lody keeps the profile's home fixed across login, session startup, and logout;
switching providers never copies the file into the global Codex home.

Profile metadata records `authStore: codex-default` for new profiles. A ready
ChatGPT record created before this change has no `authStore` field and is read as
`keyring`, preserving its existing credentials. An old pending record has no
successful login to preserve and uses the native default on retry. Removal
persists the resolved backend before attempting cleanup, so an interrupted
cleanup retries with the same backend. API-key generations still live in the
host system vault; this change does not add an API-key file fallback.

The earlier [account-profile decision](../../proposed/architecture/2026-09-26-codex-account-profiles.md)
required keyring for ChatGPT and ruled out file storage. This decision changes
that storage choice for new profiles while retaining its account isolation,
immutable provider binding, and Codex-owned OAuth refresh. The current contract
is the [draft Spec](../../../../specs/codex-account-profiles.md).

## Evidence and limits

The official [Codex authentication documentation](https://learn.chatgpt.com/docs/auth)
describes `auth.json` under `CODEX_HOME`, keyring failure when the service is
unavailable, and the plaintext nature of file credentials. The pinned
[0.156.0 configuration source](https://github.com/openai/codex/blob/rust-v0.156.0/codex-rs/config/src/config_toml.rs)
identifies `file` as the default. The existing profile directory uses mode
`0700`, and the acceptance flow checks that two ChatGPT profiles retain
separate auth files with private file permissions.

Store tests cover new, old pending, and old ready records plus removal backend
retention. The macOS acceptance recorder covers native login and account
switching, but this change has not been verified with a real account in a
keyring-free Linux container. The existing same-profile native refresh race
is unchanged.
