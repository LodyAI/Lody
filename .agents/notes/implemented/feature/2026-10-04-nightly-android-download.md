# Android downloads on the Nightly page

Status: implemented
Translation: current

[中文](2026-10-04-nightly-android-download.zh.md)

## Abstract

The Nightly page previously exposed only desktop installers. It now displays an Android APK when the live release manifest includes the exact versioned file in both download lists. Existing desktop-only manifests remain valid, allowing the website and publisher to roll out independently. Signed mobile publication is owned outside this public website and is not established by parser tests.

## Decision and evidence

`site-docs/lib/nightly-downloads.ts` retains the configured HTTPS Nightly root and never trusts remote absolute URLs. Android is additive rather than mandatory so existing releases stay available; a partially advertised APK fails validation. The page renders the Android card only when a validated link exists and scopes desktop switching copy to desktop.

This extends the download surface described in [desktop channel identity](../../proposed/architecture/2026-09-23-desktop-channel-identity.md) without changing desktop identities. The [draft contract](../../../../specs/desktop-channel-execution.md) records the additional behavior. Parser tests cover a valid APK, desktop-only rollout, missing entries and external/traversal URLs. The production website build and browser checks passed for English/Chinese pages with both desktop-only and desktop-plus-APK manifests. Native installation and release availability require publisher validation.

PR: [LodyAI/Lody#1248](https://github.com/LodyAI/Lody/pull/1248)
