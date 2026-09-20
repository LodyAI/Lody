/**
 * The composer's box. Exported so surfaces that cannot mount the real
 * `ChatComposer` — the anonymous share reader, which must stay free of mention,
 * attachment and agent-control machinery — still render the same object the
 * product's composer is, instead of a look-alike that drifts from it.
 *
 * Focus, mention-chip surface colour and every interactive concern stay in
 * `chat-composer.tsx`; this is only the resting surface.
 */
export const COMPOSER_ELEVATION_CLASS =
  'shadow-[0_3px_6px_-2px_lch(0%_0_0/0.02),0_1px_1px_lch(0%_0_0/0.04)] dark:shadow-none';

export const INFO_BAR_ELEVATION_CLASS =
  'shadow-[0_0.5px_1px_1px_rgba(0,0,0,0.04)] dark:shadow-none';

export const COMPOSER_SESSION_SURFACE_CLASS =
  `@container/composer-box flex flex-col gap-1 rounded-xl border px-2 py-1.5 transition-colors duration-150 border-foreground/[0.10] bg-[hsl(var(--composer))] ${COMPOSER_ELEVATION_CLASS} dark:border-input-border/70 dark:bg-input/90`;
