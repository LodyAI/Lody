# Builtin agent credential detection

Status: implemented
Translation: current

[中文](2026-10-28-builtin-agent-credentials.zh.md)

## Abstract

Kimi and Grok were automatically registered without local credentials. Default registration now checks for their native credential files without reading secrets. Explicit CLI selection and user removals keep their existing behavior. File presence does not prove credentials are valid.

Kimi uses `KIMI_CODE_HOME/credentials/kimi-code.json` and Grok uses `GROK_HOME/auth.json`, with native home directories as defaults. Detection runs at daemon startup; logging in later requires a restart for automatic registration. Manual provider creation remains available.
