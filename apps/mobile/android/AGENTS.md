# Lody Android

This file is an index; the rules live in the linked documents and bind as if
written here. Before any change under `apps/mobile/android`, read the
[general rules](docs/rules/general.md). Before changing an area below, also read
its rules. These triggers bind callers outside the owning directory as well.

- Building, installing, testing on, or taking screenshots from any device or emulator: read [Devices and installation](docs/rules/devices.md).
- The WebView runtime, its owner and lifecycle, the `CloudRuntime` contract or the vendored runtime snapshot: read [Cloud runtime](docs/rules/runtime.md).
- Sign-in, credentials, avatars, native HTTP or the runtime's network gates: read [Authentication and network](docs/rules/auth-network.md).
- Push registration, providers or notification handling: read [Push notifications](docs/rules/push-notifications.md).
- The catalog repository, its stores, persistence or connection recovery: read [Catalog cache and recovery](docs/rules/catalog-cache.md).
- Home, the Chats list, grouping, families, the project index, the bottom bar or the hidden Projects tab: read [Home](docs/rules/home.md).
- The new-chat page, creation options, submissions or project groups: read [Create session](docs/rules/create-session.md).
- The conversation transcript, turns, composer, action bar, attachments, images, Tabs, message actions, members, PRs or usage: read [Conversation](docs/rules/conversation.md).
- The web preview, iOS Simulator or Android Emulator preview, their runtime commands, the preview-token broker or the viewer host WebView: read [Remote previews](docs/rules/previews.md).
- Markdown repair, splitting or rendering in the transcript: read [Transcript Markdown](docs/rules/transcript-markdown.md).
- @ references, `/` commands or prompt shortcuts in any composer: read [Mentions and prompt shortcuts](docs/rules/mentions.md).
- The Schedules tab, its editor or its cache: read [Schedules](docs/rules/schedules.md).
- Settings: read [Settings](docs/rules/settings.md).
- Repository identity, PR marks, the new-chat permission face, creation keyboard handling or the conversation Tab panel: read the [cross-platform rules](../docs/rules/cross-platform.md), shared with iOS.
