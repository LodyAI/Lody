# Native host app icon selection

Status: implemented
Translation: current

[中文](2026-09-20-app-icon-selection.zh.md)

## Abstract

Appearance settings now place alternate native app icon selection immediately
below Font size in both narrow and wide mobile layouts. The shared picker consumes
an optional host bridge that supplies previews and native state. It waits for
successful native completion before changing the selection and keeps failed
changes retryable. The public package ships no host artwork or native dependency;
physical-device behavior remains a host verification concern.

## Decision and evidence

`__LODY_APP_ICON__` follows the existing optional native bridge convention. A
device-local icon should not add synchronized metadata or a second persisted
preference that can drift from the operating system. The host owns the catalog;
hardcoding native asset names in the shared picker would couple public UI to one
app's packaging. The default catalog entry uses `default` as its stable name.

The [contract](../../../../specs/app-icon-selection.md) remains a draft. The UI
suite covers installed-state reads, switching both ways, pending changes,
rejections and retries, and absent/unsupported hosts. Storybook provides default,
alternate, pending, and failure fixtures. No prior owning icon-selection note was
found. No PR has been opened.
