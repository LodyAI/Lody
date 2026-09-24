/**
 * Shared max content width for the session conversation column.
 *
 * Consumed via `ConversationColumn`
 * (`@/components/shared/conversation-column`) — the message thread rows, the
 * child-tab suggestions, pinned-message content, context strip, composer
 * content, floating permission surface, and notification prompt all render
 * inside it so they read as ONE centered column, declared once here.
 *
 * Why this is a repeated inner wrapper and NOT a single page-level parent:
 * the message list is a virtua `VList` whose scroller must span the full pane
 * (scrollbar at the pane edge, wheel works over the side margins), and the
 * composer/strip band paints a full-bleed background. Backgrounds + scroll
 * containers stay full-width; each region mounts one `ConversationColumn`.
 *
 * Horizontal gutter MUST live on `ConversationColumn` (not on the VList):
 * Virtua positions rows with `position:absolute; left:0`, which is relative to
 * the padding edge and therefore ignores the scroller's horizontal padding.
 * Putting `px-*` only on the VList made agent/user avatars flush to the screen
 * edge while the header and composer (normal flow) stayed inset.
 *
 * Do not put `ml-*` / left margin on `ConversationColumn` instances: it
 * overrides the auto left margin from `mx-auto` and pins that row to the
 * pane edge. Indent with padding or an inner wrapper instead.
 */
/** Horizontal inset shared by stream rows, context strip, composer. */
export const CONVERSATION_GUTTER_X_CLASS = 'px-[14px] sm:px-[18px]';

// 46rem (736px): the common chat-column measure — max-w-3xl (48rem) minus 1rem
// side padding. Wide enough for code blocks, narrow enough to stay readable.
export const CONVERSATION_CONTENT_WIDTH_CLASS = `mx-auto w-full max-w-[46rem] ${CONVERSATION_GUTTER_X_CLASS}`;
