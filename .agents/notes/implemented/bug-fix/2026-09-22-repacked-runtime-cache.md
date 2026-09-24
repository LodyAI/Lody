# Recover from repacked runtime caches

Status: implemented
Translation: current

[中文](2026-09-22-repacked-runtime-cache.zh.md)

## Abstract

A runtime artifact can change while retaining its source version, but the cache directory
uses only runtime name, version, and platform. Comparing the old metadata against new pins
then aborted daemon startup during pruning. A valid but outdated entry is now a cache miss
and is replaced through the existing verified download path. Invalid metadata remains an
error for launch and installation; this change does not authorize launching an artifact that differs from current pins.

## Decision and validation

Returning a cache miss covers status, launch, explicit installation, and startup cleanup.
The fallback scan already excludes the target version, so it cannot reuse the rejected
artifact. Changing only startup exception handling would leave Pi unusable. A cache-layout
migration is deferred to keep this repair small.

Regression coverage changes each compared metadata field independently and verifies startup,
replacement command bytes, and new integrity metadata. Existing malformed-metadata rejection
remains covered.

An isolated harness ran the actual manager methods with fixture runtime definitions: all
22 selected tests passed; restoring the old mismatch throw made all four new cases fail.
The complete dependency graph and submodules were then installed in a standalone checkout.
The real manager/coordinator suites passed all 39 tests, and documentation checks and the
desktop build passed. Full `pnpm check` also passed (typecheck, lint, workspace tests,
i18n and repository boundaries). The CLI bundle also passed with a 2 GiB heap limit; applying that
limit to the renderer failed, so the desktop build used its normal memory settings.

Startup cleanup and the immediately following update scan now isolate failures per runtime.
Warnings retain the runtime and cause; even a logging failure cannot escape maintenance.
Permission errors, unexpected errors, and non-Error rejections cannot prevent later runtimes
from being cleaned. A malformed cache is preserved and rejected on actual launch/install.
