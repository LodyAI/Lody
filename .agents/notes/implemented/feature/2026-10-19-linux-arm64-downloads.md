# Linux ARM64 download discovery

Status: implemented
Translation: current

[中文](2026-10-19-linux-arm64-downloads.zh.md)

## Abstract

Linux downloads previously exposed only x86-64 installers. The download page now labels architectures and displays ARM64 AppImage and Debian packages when the release manifest advertises them. Nightly keeps older manifests usable but rejects incomplete ARM64 pairs. This allows website and publisher rollout independently; parser checks do not establish native package installation success.

## Decision and evidence

The official desktop publisher owns build availability. Stable links use its download mapping and retain historical x86-64 aliases while accepting current x64 aliases. New ARM64 links have no speculative latest fallback before publication. Nightly requires exact versioned filenames in both manifest lists, inside the configured HTTPS root.

Making ARM64 mandatory in the website parser would hide all downloads until the first matching release. The additive rule instead preserves old releases and requires a complete AppImage/deb pair once either is advertised. This follows the rollout approach in [Android Nightly downloads](2026-10-04-nightly-android-download.md). Existing Nightly rendering handles the additional Linux entries without a new layout.

Tests exercise complete pairs, old manifests, missing entries and traversal mappings. Real Linux ARM64 installation remains a publisher/native-runner validation.

PR: [LodyAI/Lody#1705](https://github.com/LodyAI/Lody/pull/1705)
