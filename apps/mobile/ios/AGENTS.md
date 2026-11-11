# Lody iOS

This file is an index; the rules live in the linked documents and bind as if
written here. Before any change under `apps/mobile/ios`, read the
[general rules](docs/rules/general.md). Before changing an area below, also read
its rules. These triggers bind callers outside the owning directory as well.

- Any native UI, including text, colour, canvases, touch targets, grouped lists and page chrome: read the [UI baseline](docs/rules/ui-baseline.md).
- Native UI, Debug fixtures, or UI verification, build and simulator workflows, including shared controls and their app or extension hosts: read the [UI verification rules](apps/ios/verification/ui/AGENTS.md).
- The shell, page hosting and presentation, navigation, deep links, page factories or the Debug page: read [Shell and pages](docs/rules/shell.md).
- Home, its tabs and bottom bar, the workspace capsule or the iPad sidebar: read [Home](docs/rules/home.md).
- Conversation-list rendering, grouping, project-index interaction, family or Tab attention, including Home/Shell navigation, Projects and Activity lists, shared list models, catalog projections and their verification fixtures: read the [Sessions rules](packages/LodyKit/Sources/LodyKit/Sessions/AGENTS.md).
- The conversation transcript, turns, header, Tabs, message actions, members, avatars, images or agent marks: read [Conversation](docs/rules/conversation.md).
- The conversation composer, action bar, merge, the native PR page or usage beside Send: read [Composer and action bar](docs/rules/composer.md).
- @ references, `/` commands or prompt shortcuts in any composer: read [Mentions and prompt shortcuts](docs/rules/mentions.md).
- The new-session page, creation options, new-chat Agent Roles, GitHub branches or project groups: read [Create session](docs/rules/create-session.md).
- Settings pages or their caches: read [Settings](docs/rules/settings.md).
- Login, the data runtime, the offscreen WebView and watchdog, the host↔runtime contract, Streams grants or local persistence: read [Cloud runtime](docs/rules/cloud-runtime.md).
- The Share Extension or its App Group snapshot: read [Share Extension](docs/rules/share-extension.md).
- Push registration, the Notification Service Extension, notification navigation or Live Activities: read [Push notifications](docs/rules/push-notifications.md).
- Repository identity, PR marks, the new-chat permission face, creation keyboard handling or the conversation Tab panel: read the [cross-platform rules](../docs/rules/cross-platform.md), shared with Android.
