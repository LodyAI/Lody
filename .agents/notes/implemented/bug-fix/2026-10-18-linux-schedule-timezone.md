# Linux schedule timezone detection

Status: implemented
Translation: current

[中文](2026-10-18-linux-schedule-timezone.zh.md)

PR: https://github.com/LodyAI/Lody/pull/1685

## Abstract

Linux Node can display Hong Kong local time correctly while Intl exposes no default
zone name for `TZ=HKT-8` or an absolute zoneinfo path. Lody converted that missing
name to UTC and published it as the machine timezone, making local 10 AM schedules
run at Hong Kong 6 PM. Machine registration now supplies the environment hint so
the shared resolver can recover a named zone or an equivalent fixed IANA zone.
The defect is reproduced on Linux x64; the reported ARM host and its exact environment
remain unverified, and existing schedules are not migrated.

## Cause and decision

This complements the [Once clock correction](2026-10-01-schedule-once-clock.md).
The editor already consumes machine metadata, and the engine already honors the
saved zone. At `450595e07`, `getDeviceTimeZone()` used
`Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'`. Under Node 24.22.0
with `TZ=HKT-8`, `Date` reports offset -480 minutes, but the Intl zone is undefined.
The resulting saved daily rule plans `2026-10-18T10:00:00Z`, instead of `02:00:00Z`.
This affects manual creation as well as proposals that inherit the machine zone.

Keep a detected Intl zone authoritative. Only when it is absent, interpret the
caller-supplied hint: strip the optional POSIX colon and standard zoneinfo path
prefix, retain region names and their DST rules, or translate fixed whole-hour
POSIX offsets to `Etc/GMT` with the same inverse sign. Validate the result through
Intl. Both machine registration paths supply `process.env.TZ`; shared/browser code
does not read process globals or the filesystem. This is a pure conversion change,
with no Effect lifecycle or migration unit change.

Do not infer a region from today's UTC offset: that could silently erase DST.
Do not rewrite existing schedules: an explicit UTC commitment may be intentional.
Unsupported hints retain the previous UTC fallback, including arbitrary paths such
as `/etc/localtime`, non-whole-hour POSIX offsets and full POSIX DST rule strings
when Intl cannot name them. This patch is not a complete POSIX timezone parser or
a live system-timezone watcher. Metadata refresh still requires registration.

## Verification and limits

The existing zoned-input suite covers machine-local daily/Once 10 AM, explicit UTC,
Hong Kong aliases and POSIX/path hints, and preservation of New York winter/summer
offsets. Dependencies were installed in an isolated temporary harness using the
repository's Croner 10.0.1, Zod 4.3.6, Vitest 5.0.2 and pinned Core/DSH sources;
product source was copied without substituting the scheduling implementation.
The 18 repository tests pass under UTC and Hong Kong environments; together with
the real-process replay, all 19 also pass under `TZ=HKT-8`. A separate real-process replay
under `TZ=HKT-8` fails against the original helper by exactly eight hours and passes
with the fix, exercising both the planned cron slot and Once conversion.

The nested checkout has no workspace dependencies. `pnpm check` and `pnpm format`
were attempted but could not complete because `tsgo` and `oxfmt` are absent. Targeted
Oxfmt 0.65.0 and diff whitespace checks pass. Full UI, CLI and type/build checks
remain unverified; this evidence does not claim packaged ARM verification.
The readable workspace did not expose the reported Linux task, so the production
cause remains conditional on its actual daemon environment and saved trigger.
Document checks report pre-existing missing ACP submodule link targets.
