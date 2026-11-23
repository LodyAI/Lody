/** Keep the prerendered document untouched until its client dependencies are ready. */
export async function prepareHydration<T>(
  events: EventTarget,
  prepare: () => Promise<T>,
  hydrate: (value: T) => void
): Promise<void> {
  let failed = false;
  // TanStack's lazy component preload records import errors without rejecting.
  // Vite emits this event before that catch, including failed dependency imports.
  const onPreloadError = () => {
    failed = true;
  };
  events.addEventListener('vite:preloadError', onPreloadError);
  try {
    const value = await prepare();
    if (!failed) hydrate(value);
  } catch (error) {
    console.error('Keeping the static page because client initialization failed.', error);
  } finally {
    events.removeEventListener('vite:preloadError', onPreloadError);
  }
}
