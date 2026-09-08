# Select chat messages for an image preview

Status: implemented
Translation: pending

## Abstract

Sharing a whole session gives users no control over which messages appear in a
conversation card. The chat now owns temporary message selection and passes a
snapshot into a separate style preview. Selection follows message IDs across
virtual rows, with a drag rectangle and edge scrolling. Metadata uses selected
history instead of the current model selector, while token counts remain rough
text estimates and image export is not implemented.

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

## Evidence and limits

[The draft specification](../../../../specs/chat-share-image.md) owns the intended
behavior. Synthetic tests cover drag ranges, inversion, edge scrolling, metadata
extraction, and token estimates. The `SessionConversationPage` share stories compose
the production tab bar, header menu, stream, selection hook, composer, and preview
dialog around synthetic history. They start in normal chat, support local message
submission, and preserve drafts and selections through preview round trips.
Storybook also covers light/dark cards without a backdrop. No automated screenshots or image-export
verification were performed. In an isolated checkout with pinned submodules and
Node 22, workspace typechecks, lint, tests, translation checks, documentation
checks, and repository boundary guards passed. Tests required disabling Git
commit signing for their temporary repositories and installing Electron locally.
