# Keep React-owned text in place under session search marks

Status: implemented
Translation: pending

## Abstract

With session search open, hovering an assistant row that held an agent file link
crashed the conversation (`SessionChatStream` boundary) with `NotFoundError:
Failed to execute 'insertBefore' on 'Node'`. `MarkdownRenderer` highlighted
matches by replacing each matched text node with a fragment of new text nodes
and `<mark>` elements, and unwrapped them with `normalize()`. Both detached text
nodes React still owned. Hovering arms the row (`useInteractionArm`), which
remounts the link's `ContextMenu` subtree; React then inserts the new link before
its next sibling, the detached text node, and the DOM rejects it.

## Decision

The search highlighter never removes a React-owned node. A matched text node
stays in place holding the text before its first match; the marks and the rest
of the text are inserted after it. Clearing removes only the inserted nodes and
restores the node's value unless React has rewritten it since (its text wins).
`normalize()` is gone, since merging would also detach React's nodes.

The CSS Custom Highlight API would avoid DOM mutation altogether, but it cannot
draw the marks' ring and rounded corners, and search navigation scrolls to
`[data-search-result-id]` elements. Splitting in place keeps both.

A link text that a remount recreates loses its mark until the search effect next
runs (query, match, or text change); the crash, not that highlight, was the defect.

## Verification

`tests/markdown-agent-file-link-menu.test.tsx` renders a list item with a file
link and a match after it in an unarmed row, then arms it. Before the change it
failed with jsdom's `NotFoundError`; after it the text and the active mark
survive arming, and closing search restores the original text.
