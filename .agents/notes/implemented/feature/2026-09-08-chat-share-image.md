# Select and export chat messages as an image

Status: implemented
Translation: current

[中文](2026-09-08-chat-share-image.zh.md)

## Abstract

Sharing a whole session gives users no control over which messages appear in a
conversation card. The chat now owns temporary message selection and passes a
snapshot into a separate style preview. Selection follows message IDs across
virtual rows, with a drag rectangle and edge scrolling. Metadata uses selected
history instead of the current model selector, while token counts remain rough
text estimates. The styled card can be saved as PNG without publishing it.

## Decision

The preview accepts already selected messages instead of embedding a second
conversation picker. Each assistant message is one selection unit, including
its folded working content. Selected prose is rendered, and a separate numeric
estimate accounts for stored thoughts, plans, tool arguments, output, and diffs.
No hidden working text is copied into the preview payload.

The last selected assistant message supplies the model label; aggregating mixed
models was deliberately excluded. Custom Runtime names resolve from the current
session configuration. Selection state and preview snapshots are local React
state, with no persistence, cloud calls, or transcript mutation.

PNG export uses a lazy-loaded `@zumer/snapdom` capture of the natural-size card
inside the preview, excluding its scaled scroll container. Fonts and images
finish loading before capture; QR generation gates the action. The existing
Electron image bridge owns native saving, while browsers download a Blob URL
and release it afterward. Save cancellation is not an error. The dialog keeps
export errors actionable and prevents duplicate requests.

## Evidence and limits

[The draft specification](../../../../specs/chat-share-image.md) owns the intended
behavior. Synthetic tests cover drag ranges, inversion, edge scrolling, metadata
extraction, and token estimates. The `SessionConversationPage` share stories compose
the production tab bar, header menu, stream, selection hook, composer, and preview
dialog around synthetic history. They start in normal chat, support local message
submission, and preserve drafts and selections through preview round trips.
Storybook also covers light/dark cards without a backdrop. Export tests cover
browser download cleanup, native save cancellation/failure, and invalid capture
results; they mock rasterization and do not establish pixel fidelity. No automated
screenshots were performed. In an isolated checkout with pinned submodules and
Node 22, workspace typechecks, lint, tests, translation checks, documentation
checks, and repository boundary guards passed. Tests required disabling Git
commit signing for their temporary repositories and installing Electron locally.
