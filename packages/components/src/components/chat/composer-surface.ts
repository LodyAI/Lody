/**
 * The composer's box. Exported so surfaces that cannot mount the real
 * `ChatComposer` — the anonymous share reader, which must stay free of mention,
 * attachment and agent-control machinery — still render the same object the
 * product's composer is, instead of a look-alike that drifts from it.
 *
 * Focus, mention-chip surface colour and every interactive concern stay in
 * `chat-composer.tsx`; this is only the resting surface.
 */
/** Light lift shared by the session composer and the info bar. */
export const COMPOSER_ELEVATION_CLASS =
  'shadow-[0_2px_8px_0_rgb(0_0_0_/_0.08)] dark:shadow-none';

export const COMPOSER_SESSION_SURFACE_CLASS =
  `@container/composer-box flex flex-col gap-1 rounded-xl border px-2 py-1.5 transition-colors duration-150 border-foreground/[0.10] bg-[hsl(var(--composer))] ${COMPOSER_ELEVATION_CLASS} dark:border-input-border/70 dark:bg-input/90`;
