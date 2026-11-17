import type { LoroStreamsTokenProviderEvent } from '@lody/shared';

/** Local retry/lifecycle diagnostics, never a per-attempt analytics capture. */
export function logTokenProviderEvent(event: LoroStreamsTokenProviderEvent): void {
  const logContext = {
    ...event,
    hasCachedToken: event.type === 'cache-hit',
  };
  if (event.type === 'fetch-failure') {
    console.warn('Loro Streams token provider event', logContext);
    return;
  }
  console.debug('Loro Streams token provider event', logContext);
}
