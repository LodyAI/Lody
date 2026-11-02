# Detect the active Windows console code page from a trusted utility

Status: implemented
Translation: pending
PR: https://github.com/LodyAI/Lody/pull/70

## Abstract

Windows console programs can encode output with the active OEM code page, which is
independent of locale environment variables. The CLI now resolves the kernel-owned
SystemRoot link to `chcp.com`, runs that read-only utility directly with bounded
resources, and uses the reported supported encoding before locale fallback. The
synchronous probe is cached to avoid repeated startup work, while transient failures
retry later and never replace a last known good value.

## Decision and boundaries

Probe only when invalid UTF-8 output needs the Windows fallback. Resolve
`\\?\GLOBALROOT\SystemRoot\System32\chcp.com` with `realpathSync.native` so
`SystemRoot`, `WINDIR`, `ComSpec`, `PATH`, and the working directory cannot select
an executable. Run without a shell, with a two-second timeout and 64 KiB output cap.
Accept only a successful, parseable code page supported by `iconv-lite`; map Windows
aliases 65001 and 54936 to UTF-8 and GB18030.

Cache successful detection for five minutes. A failed refresh retains the last known
good encoding and retries after 30 seconds; without one, decoding uses the existing
locale fallback. Non-Windows behavior and forced encodings remain unchanged.

## Alternatives and trade-offs

Locale-only inference was rejected because locale and console configuration can
disagree. Resolving `cmd.exe` or `chcp.com` through environment variables was rejected
because the CLI can inherit attacker-controlled paths. A registry probe or native
addon would avoid a subprocess but adds platform-specific dependencies and failure
surfaces for a fallback used only after UTF-8 validation fails.

The synchronous probe can pause the first affected decode if Windows is unhealthy.
Bounding and caching that work keeps the common UTF-8 path free of subprocesses while
retaining deterministic recovery from transient failures.

## Evidence and limits

Focused tests exercise localized raw output, UTF-8 and GB18030 aliases, unsupported
and malformed output, unresolvable system paths, hostile environment paths, locale
precedence, cache expiry, retry, and last-known-good retention. A live CP936 Windows
probe and Chinese round trip have succeeded. Local testing does not cover every
localized Windows message resource or unusual console host.
